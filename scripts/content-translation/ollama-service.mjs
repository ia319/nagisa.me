import net from "node:net";
import timers from "node:timers/promises";
import { checkOllamaService, resolveOllamaHost } from "./ollama-connection.mjs";
import { startOllamaProcess } from "./ollama-process.mjs";

async function reserveCandidate(port, signal) {
  signal.throwIfAborted();
  // Close incoming connections so an unrelated client cannot hold the probe open.
  const server = net.createServer(socket => socket.destroy());
  let cancel;
  try {
    return await new Promise((resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      server.once("error", reject);
      server.listen(
        { host: "127.0.0.1", port, exclusive: true, signal },
        () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            server.close();
            reject(new Error("Could not determine the candidate Ollama port"));
            return;
          }
          server.close(error =>
            error ? reject(error) : resolve(address.port)
          );
        }
      );
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      `Cannot bind Ollama ${port ? `port ${port}` : "candidate port"} (${error.code ?? error.message}). Choose another port or check local port restrictions.`,
      { cause: error }
    );
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * Borrow an explicitly configured service or start one private, bounded-lifetime instance.
 * @param {{port: number | "auto", host?: never} | {host: string, port?: never}} selection Resolved private port or borrowed service address.
 * @param {(message: string) => void} report Progress and retry sink, separate from model bytes.
 * @param {AbortSignal} signal Command cancellation signal.
 * @returns {Promise<{host: string, signal: AbortSignal, stop: () => Promise<void>}>} Service address, crash-aware signal, and ownership-safe cleanup.
 * @throws {Error} When the endpoint, port, readiness, or containment cannot be established.
 */
export async function openOllamaService(selection, report, signal) {
  signal.throwIfAborted();
  if (selection.host !== undefined)
    return {
      host: resolveOllamaHost(selection.host),
      signal,
      stop: async () => {},
    };
  const port = selection.port;
  const automatic = port === "auto";
  const startup = new AbortController();
  const deadline = new AbortController();
  const startupSignal = AbortSignal.any([signal, startup.signal]);
  const clock = timers
    .setTimeout(60000, undefined, { signal: deadline.signal })
    .then(() =>
      startup.abort(new Error("Ollama startup timed out after 60 seconds"))
    );
  clock.catch(() => {});
  try {
    for (let attempt = 0; ; attempt++) {
      const selected = await reserveCandidate(
        automatic ? 0 : port,
        startupSignal
      );
      const host = `http://127.0.0.1:${selected}/`;
      report(`Start Ollama: ${host}`);
      const crash = new AbortController();
      const running = AbortSignal.any([startupSignal, crash.signal]);
      const owned = startOllamaProcess(host, running);
      let closing = false;
      owned.exited.then(error => {
        if (!closing) crash.abort(error);
      });
      try {
        await owned.listening;
        while (true) {
          running.throwIfAborted();
          try {
            await checkOllamaService(host, running);
            break;
          } catch (error) {
            running.throwIfAborted();
            const cause = error.cause;
            const code = cause?.code ?? cause?.cause?.code;
            if (
              ![
                "ECONNREFUSED",
                "ECONNRESET",
                "ETIMEDOUT",
                "UND_ERR_CONNECT_TIMEOUT",
              ].includes(code) &&
              cause?.name !== "TimeoutError"
            )
              throw error;
            await timers.setTimeout(100, undefined, { signal: running });
          }
        }
        running.throwIfAborted();
        report(`Ollama ready: ${host}`);
        return {
          host,
          signal: running,
          async stop() {
            closing = true;
            await owned.stop();
          },
        };
      } catch (error) {
        closing = true;
        const primary = startupSignal.aborted
          ? startupSignal.reason
          : crash.signal.aborted
            ? crash.signal.reason
            : error;
        try {
          await owned.stop();
        } catch (cleanup) {
          throw new AggregateError(
            [primary, cleanup],
            `${primary.message}\nOllama cleanup failed: ${cleanup.message}`
          );
        }
        signal.throwIfAborted();
        // Only a confirmed address-in-use bind failure permits releasing another candidate.
        const conflict = new RegExp(
          `listen tcp 127\\.0\\.0\\.1:${selected}: bind:.*(?:address already in use|Only one usage of each socket address|10048)`,
          "i"
        );
        if (
          !startupSignal.aborted &&
          automatic &&
          attempt < 3 &&
          conflict.test(owned.diagnostics())
        ) {
          report(`Ollama port ${selected} was taken; retry ${attempt + 1}/3.`);
          continue;
        }
        const tail = owned.diagnostics();
        throw new Error(
          `Ollama startup failed at ${host}: ${primary.message}${tail && !primary.message.includes(tail) ? `\n${tail}` : ""}`,
          { cause: primary }
        );
      }
    }
  } finally {
    deadline.abort();
  }
}
