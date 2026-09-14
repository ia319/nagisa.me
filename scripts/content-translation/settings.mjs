import fs from "node:fs/promises";
import path from "node:path";
import { readProjectFile } from "./snapshot.mjs";

/**
 * Capture model and service defaults only when command or environment values need a fallback.
 * @param {string} root Project root containing the optional translation.config.mjs.
 * @param {{model?: string, ollamaPort?: number | "auto"}} options Parsed command options.
 * @param {{model?: string, host?: string}} environment Captured model and service environment values.
 * @returns {Promise<{model: string, service: {port: number | "auto", host?: never} | {host: string, port?: never}}>} Required model and explicit service ownership selection.
 * @throws {Error} When the needed configuration cannot be read, is invalid, or supplies no model.
 */
export async function readTranslationSettings(root, options, environment) {
  let model =
    options.model ??
    (environment.model?.trim() ? environment.model : undefined);
  const host = environment.host?.trim();
  let port = options.ollamaPort;
  if (model === undefined || (port === undefined && !host)) {
    const config = await readTranslationConfig(root);
    model ??= config.model;
    // A saved port is a fallback, not permission to override an external service.
    if (port === undefined && !host) port = config.port;
  }
  if (!model?.trim())
    throw new Error(
      "Provide --model, set OLLAMA_TRANSLATE_MODEL, or set model in translation.config.mjs"
    );
  return {
    model,
    service: port === undefined && host ? { host } : { port: port ?? "auto" },
  };
}

/**
 * @param {string} root Project root containing the optional settings file.
 * @returns {Promise<{model: string, port: number | "auto"}>} Validated project defaults.
 */
async function readTranslationConfig(root) {
  const file = "translation.config.mjs";
  try {
    root = await fs.realpath(root);
    try {
      await fs.lstat(path.join(root, file));
    } catch (error) {
      // Only a missing entry is optional; broken links and failed reads must not become defaults.
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { model: "", port: "auto" };
      throw error;
    }
    const text = await readProjectFile(root, file);
    // Evaluate captured, self-contained ESM data instead of importing a cached file URL.
    const { default: exported } = await import(
      `data:text/javascript;base64,${Buffer.from(text, "utf8").toString("base64")}`
    );
    const value = /** @type {unknown} */ (exported);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw new Error("Expected a default-exported settings object");
    const unknown = Reflect.ownKeys(value).filter(
      key => key !== "model" && key !== "port"
    );
    if (unknown.length)
      throw new Error(`Unknown settings: ${unknown.map(String).join(", ")}`);
    const model = "model" in value ? value.model : "";
    const port = "port" in value ? value.port : "auto";
    if (typeof model !== "string") throw new Error("model must be a string");
    if (
      port !== "auto" &&
      !(
        typeof port === "number" &&
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65535
      )
    )
      throw new Error('port must be "auto" or an integer from 1 to 65535');
    return { model, port };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load ${file}: ${message}`, { cause: error });
  }
}
