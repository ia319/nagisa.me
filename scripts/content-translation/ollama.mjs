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

function invoke(args, prompt, host, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn("ollama", args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OLLAMA_HOST: host },
      signal,
    });
    let stdout = "";
    let stderr = "";
    let inputError;
    let oversized = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (oversized) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 16 * 1024 * 1024) {
        oversized = true;
        stdout = "";
        reject(
          new Error(
            "Ollama output exceeded 16 MiB; no article files were written"
          )
        );
        child.kill();
      }
    });
    child.stderr.on("data", chunk => {
      // Keep the latest diagnostic rather than accumulating terminal progress indefinitely.
      stderr = (stderr + chunk).slice(-65536);
    });
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
      const diagnostic = stripVTControlCharacters(stderr).trim();
      if (code !== 0 || terminationSignal || inputError) {
        const missingModel =
          args[0] === "show" &&
          /not found|does not exist|404/i.test(diagnostic);
        reject(
          new Error(
            missingModel
              ? `Ollama model is not installed: ${args[1]}. Install the model manually. ${diagnostic}`
              : `ollama ${args[0]} failed (${terminationSignal ?? code}): ${diagnostic || inputError?.message || "no stderr"}`
          )
        );
        return;
      }
      resolve({ text: stripVTControlCharacters(stdout).trim(), diagnostic });
    });
    child.stdin.end(prompt, "utf8");
  });
}

/**
 * Run prepared fragments using an installed local model and non-interactive stdin.
 * Keep the service and model unchanged during the run; CLI preflights are not locks.
 * @param {readonly {id: string, prompt: string}[]} requests Kernel-validated model requests.
 * @param {string} model Model name validated by the translation kernel.
 * @param {(message: string) => void} report Progress and stderr diagnostic sink.
 * @param {AbortSignal} signal Cancellation signal owned by the command.
 * @returns {Promise<{id: string, text: string}[]>} Responses for whole-set kernel validation.
 * @throws {Error} When service, model, process execution, output, or cancellation checks fail.
 */
export async function runOllamaRequests(requests, model, report, signal) {
  if (!requests.length) return [];
  const host = localHost();
  const results = [];
  for (const [index, request] of requests.entries()) {
    // Even `show` may start the desktop app when the server is down.
    await checkService(host, signal);
    const info = await invoke(["show", model], "", host, signal);
    if (!info.text)
      throw new Error(`ollama show returned no model information: ${model}`);
    if (/^\s*Remote (model|URL)\s+/m.test(info.text))
      throw new Error(
        "Cloud models are outside the local translation boundary; select an installed local model"
      );
    if (info.diagnostic) report(`Ollama show stderr: ${info.diagnostic}`);
    await checkService(host, signal);
    report(`Translate ${index + 1}/${requests.length}: ${request.id}`);
    // Wrapping or thinking text would contaminate the validated translation fragments.
    const result = await invoke(
      ["run", model, "--nowordwrap", "--hidethinking"],
      request.prompt,
      host,
      signal
    );
    if (result.diagnostic)
      report(`Ollama run stderr (${request.id}): ${result.diagnostic}`);
    if (!result.text)
      throw new Error(`Ollama returned empty output: ${request.id}`);
    results.push({ id: request.id, text: result.text });
  }
  return results;
}
