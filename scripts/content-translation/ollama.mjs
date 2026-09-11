import childProcess from "node:child_process";
import { stripVTControlCharacters } from "node:util";

function localHost() {
  const raw = process.env.OLLAMA_HOST?.trim() || "127.0.0.1:11434";
  const explicitScheme = raw.includes("://");
  const host = new URL(explicitScheme ? raw : `http://${raw}`);
  if (!explicitScheme && !host.port) host.port = "11434";
  if (host.hostname === "0.0.0.0") host.hostname = "127.0.0.1";
  if (host.hostname === "[::]") host.hostname = "[::1]";
  if (
    !["http:", "https:"].includes(host.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) ||
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    host.pathname !== "/"
  )
    throw new Error(
      "OLLAMA_HOST must identify a local Ollama server without credentials or a URL path"
    );
  return host.href;
}

async function checkService(host, signal) {
  try {
    const response = await fetch(host, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      `Ollama service is unavailable at ${host}. Start it manually, then retry. ${error.message}`,
      { cause: error }
    );
  }
}

async function forwardOutput(source, destination, capture) {
  const onError = error => source.destroy(error);
  destination.on("error", onError);
  try {
    for await (const chunk of source) {
      // Await the destination callback to preserve bytes and bound pending terminal writes.
      await new Promise((resolve, reject) => {
        destination.write(chunk, error => (error ? reject(error) : resolve()));
      });
      capture(chunk);
    }
  } finally {
    destination.removeListener("error", onError);
  }
}

async function invoke(args, prompt, host, signal, output) {
  signal.throwIfAborted();
  const child = childProcess.spawn("ollama", args, {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OLLAMA_HOST: host },
    signal,
  });
  const stdout = [];
  let stdoutBytes = 0;
  let stderr = Buffer.alloc(0);
  let inputError;
  const execution = new Promise((resolve, reject) => {
    child.on("error", error => {
      reject(
        "code" in error && error.code === "ENOENT"
          ? new Error(
              "Ollama CLI was not found. Install it and add ollama to PATH.",
              { cause: error }
            )
          : error
      );
    });
    child.stdin.on("error", error => {
      inputError = error;
    });
    child.on("close", (code, terminationSignal) => {
      resolve({ code, terminationSignal });
    });
  });
  const reading = [
    forwardOutput(child.stdout, output.stdout, chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 16 * 1024 * 1024)
        throw new Error(
          "Ollama output exceeded 16 MiB; no article files were written"
        );
      stdout.push(chunk);
    }),
    forwardOutput(child.stderr, output.stderr, chunk => {
      // Bound only the diagnostic copy; every original byte goes to the terminal.
      stderr = Buffer.concat([stderr, chunk.subarray(-65536)]).subarray(-65536);
    }),
  ];
  child.stdin.end(prompt, "utf8");
  try {
    const [{ code, terminationSignal }] = await Promise.all([
      execution,
      ...reading,
    ]);
    signal.throwIfAborted();
    if (code !== 0 || terminationSignal || inputError) {
      const diagnostic = stripVTControlCharacters(
        stderr.toString("utf8")
      ).trim();
      const missingModel =
        args[0] === "show" && /not found|does not exist|404/i.test(diagnostic);
      throw new Error(
        missingModel
          ? `Ollama model is not installed: ${args[1]}. Install the model manually.`
          : `ollama ${args[0]} failed (${terminationSignal ?? code}); ${inputError?.message ?? "see Ollama output above"}`
      );
    }
    // Clean only the parsing copy; terminal output has already been forwarded unchanged.
    return stripVTControlCharacters(
      Buffer.concat(stdout).toString("utf8")
    ).trim();
  } catch (error) {
    child.kill();
    throw error;
  }
}

/**
 * Run prepared translation requests using an installed local model and non-interactive stdin.
 * Keep the service and model unchanged during the run; CLI preflights are not locks.
 * @param {readonly {id: string, prompt: string, format?: "json"}[]} requests Kernel-validated model requests and optional metadata JSON mode.
 * @param {string} model Model name validated by the translation kernel.
 * @param {(message: string) => void} report Command progress sink, separate from raw model output.
 * @param {AbortSignal} signal Cancellation signal owned by the command.
 * @param {{stdout: import("node:stream").Writable, stderr: import("node:stream").Writable}} output Destinations for original Ollama bytes; the caller retains ownership of both streams.
 * @returns {Promise<{id: string, text: string}[]>} Responses for whole-set kernel validation.
 * @throws {Error} When service, model, process execution, output, or cancellation checks fail.
 */
export async function runOllamaRequests(
  requests,
  model,
  report,
  signal,
  output
) {
  if (!requests.length) return [];
  const host = localHost();
  const results = [];
  for (const [index, request] of requests.entries()) {
    // Even `show` may start the desktop app when the server is down.
    await checkService(host, signal);
    const info = await invoke(["show", model], "", host, signal, output);
    if (!info)
      throw new Error(`ollama show returned no model information: ${model}`);
    if (/^\s*Remote (model|URL)\s+/m.test(info))
      throw new Error(
        "Cloud models are outside the local translation boundary; select an installed local model"
      );
    await checkService(host, signal);
    report(`Translate ${index + 1}/${requests.length}: ${request.id}`);
    // Wrapping or thinking text would contaminate the article returned for validation.
    const text = await invoke(
      [
        "run",
        model,
        "--nowordwrap",
        "--hidethinking",
        ...(request.format === "json" ? ["--format", "json"] : []),
      ],
      request.prompt,
      host,
      signal,
      output
    );
    if (!text) throw new Error(`Ollama returned empty output: ${request.id}`);
    results.push({ id: request.id, text });
  }
  return results;
}
