/**
 * Normalize an explicit Ollama address without reading or changing the environment.
 * @param {string} value Address with an optional HTTP or HTTPS scheme.
 * @returns {string} Local service URL shared by HTTP checks and CLI processes.
 * @throws {Error} When the address is malformed, remote, or contains credentials or a path.
 */
export function resolveOllamaHost(value) {
  const raw = value.trim();
  const explicitScheme = raw.includes("://");
  let host;
  try {
    if (/[\u0000-\u0020\u007f]/.test(raw))
      throw new Error("address contains whitespace or control characters");
    host = new URL(explicitScheme ? raw : `http://${raw}`);
  } catch (error) {
    throw new Error("OLLAMA_HOST must identify a valid local Ollama server", {
      cause: error,
    });
  }
  // URL.port omits default HTTP ports; an explicit :80 must not become :11434.
  const authority = raw.split(/[/?#]/, 1)[0];
  if (!explicitScheme && !/:\d+$/.test(authority)) host.port = "11434";
  if (host.hostname === "0.0.0.0") host.hostname = "127.0.0.1";
  if (host.hostname === "[::]") host.hostname = "[::1]";
  if (
    !["http:", "https:"].includes(host.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) ||
    host.port === "0" ||
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    host.pathname !== "/"
  )
    throw new Error(
      "OLLAMA_HOST must identify a local Ollama server on port 1–65535 without credentials or a URL path"
    );
  return host.href;
}

/**
 * Check the Ollama version endpoint before invoking a CLI that could start the desktop app.
 * @param {string} host Normalized local service URL.
 * @param {AbortSignal} signal Cancellation signal owned by the command.
 * @returns {Promise<void>} Resolves when the service returns a nonempty version string.
 * @throws {Error} When the service is unavailable, returns an invalid response, or is cancelled.
 */
export async function checkOllamaService(host, signal) {
  signal.throwIfAborted();
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
  let response;
  try {
    response = await fetch(new URL("/api/version", host).href, {
      method: "GET",
      redirect: "error",
      signal: requestSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      `Ollama service is unavailable at ${host}. Start it manually, then retry. ${error.message}`,
      { cause: error }
    );
  }
  try {
    if (!response.body) throw new Error("empty response");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 8192) throw new Error("version response exceeded 8 KiB");
      chunks.push(chunk);
    }
    requestSignal.throwIfAborted();
    const info = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof info?.version !== "string" || !info.version.trim())
      throw new Error("missing version string");
  } catch (error) {
    signal.throwIfAborted();
    const failure = requestSignal.aborted
      ? "Ollama version check timed out"
      : "Invalid Ollama version response";
    throw new Error(`${failure} at ${host}: ${error.message}`, {
      cause: error,
    });
  }
}
