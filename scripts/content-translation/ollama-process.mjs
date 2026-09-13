import childProcess from "node:child_process";
import os from "node:os";
import timers from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const supervisor = `
$ErrorActionPreference = 'Stop'
try {
  $ollama = Get-Command ollama.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $ollama) { throw 'Ollama CLI was not found. Install it and add ollama to PATH.' }
  $source = [System.IO.File]::ReadAllText($env:TRANSLATION_OLLAMA_JOB, [System.Text.Encoding]::UTF8)
  Add-Type -TypeDefinition $source
  exit ([TranslationOllamaJob]::Run($ollama.Source, [int]$env:TRANSLATION_OLLAMA_PORT))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  [Console]::Out.WriteLine('{"event":"stopped"}')
  exit 1
}
`;

/**
 * Start a Windows supervisor that owns the service tree and verifies listener ownership.
 * @param {string} host HTTP loopback URL with the selected service port.
 * @param {AbortSignal} signal Cancellation signal for the service lifetime.
 * @returns {{listening: Promise<void>, exited: Promise<Error>, stop: () => Promise<void>, diagnostics: () => string}} Owned process lifecycle; no service is shared with other commands.
 * @throws {Error} When the platform, address, or process setup cannot support reliable containment.
 */
export function startOllamaProcess(host, signal) {
  signal.throwIfAborted();
  if (os.platform() !== "win32")
    throw new Error(
      "Automatic Ollama startup requires Windows. Set OLLAMA_HOST to use an existing local service on this platform."
    );
  const address = new URL(host);
  if (address.protocol !== "http:" || address.hostname !== "127.0.0.1")
    throw new Error("Managed Ollama must listen on HTTP IPv4 loopback");
  const child = childProcess.spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", supervisor],
    {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OLLAMA_HOST: host,
        OLLAMA_NO_CLOUD: "1",
        OLLAMA_NOPRUNE: "1",
        TRANSLATION_OLLAMA_JOB: fileURLToPath(
          new URL("./ollama-job.cs", import.meta.url)
        ),
        TRANSLATION_OLLAMA_PORT: address.port || "80",
      },
    }
  );
  let tail = Buffer.alloc(0);
  let protocol = "";
  let started = false;
  let spawned = false;
  let stopped = false;
  let closed = false;
  let failure;
  let stopping;
  let resolveListening, rejectListening, resolveExit;
  const listening = new Promise((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });
  // Process failure can arrive before the caller begins awaiting readiness.
  listening.catch(() => {});
  const exited = new Promise(resolve => {
    resolveExit = resolve;
  });
  const diagnostics = () =>
    stripVTControlCharacters(tail.toString("utf8")).trim();
  const cancel = () => {
    stop().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  child.stderr.on("data", chunk => {
    tail = Buffer.concat([tail, chunk.subarray(-65536)]).subarray(-65536);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    try {
      protocol += chunk;
      if (protocol.length > 4096)
        throw new Error("Ollama supervisor protocol exceeded 4 KiB");
      let newline;
      while ((newline = protocol.indexOf("\n")) !== -1) {
        const message = JSON.parse(protocol.slice(0, newline));
        protocol = protocol.slice(newline + 1);
        if (message.event === "ready" && !started) {
          started = true;
          if (!stopping && !signal.aborted)
            child.stdin.write("start\n", "utf8");
        } else if (message.event === "listening" && started) {
          if (!stopping) resolveListening();
        } else if (message.event === "stopped") {
          stopped = true;
        } else throw new Error("Unexpected Ollama supervisor event");
      }
    } catch (error) {
      failure = error;
      rejectListening(error);
      cancel();
    }
  });
  child.stdin.on("error", error => {
    failure ??= error;
  });
  child.stdout.on("error", error => {
    failure ??= error;
    cancel();
  });
  child.stderr.on("error", error => {
    failure ??= error;
    cancel();
  });
  child.once("spawn", () => {
    spawned = true;
  });
  child.on("error", error => {
    if (!spawned) stopped = true;
    failure =
      "code" in error && error.code === "ENOENT"
        ? new Error(
            "PowerShell was not found; automatic Ollama startup requires powershell.exe.",
            { cause: error }
          )
        : error;
  });
  child.on("close", (code, terminationSignal) => {
    closed = true;
    signal.removeEventListener("abort", cancel);
    const error =
      failure ??
      new Error(
        `Ollama supervisor exited (${terminationSignal ?? code})${diagnostics() ? `\n${diagnostics()}` : ""}`
      );
    rejectListening(signal.aborted ? signal.reason : error);
    resolveExit(error);
    if (code !== 0 || terminationSignal || !stopped) failure ??= error;
  });
  if (signal.aborted) cancel();

  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!closed) child.stdin.end();
      const deadline = new AbortController();
      try {
        const outcome = await Promise.race([
          exited,
          timers.setTimeout(10000, null, { signal: deadline.signal }),
        ]);
        if (outcome === null) {
          const error = new Error(
            "Ollama supervisor cleanup timed out; job-handle closure was requested but cleanup could not be confirmed."
          );
          rejectListening(error);
          child.kill();
          // Release only this failed supervisor's pipes so the command can report failure.
          child.unref();
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          throw error;
        }
        if (!stopped)
          throw new Error(
            `Ollama process-tree cleanup was not confirmed. ${outcome.message}`
          );
      } finally {
        deadline.abort();
      }
    })();
    return stopping;
  }
  return { listening, exited, stop, diagnostics };
}
