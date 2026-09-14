/**
 * Resolve one model and service selection before any translation side effects.
 * @param {{model?: string, ollamaPort?: number | "auto"}} options Parsed command options.
 * @param {{model?: string, host?: string}} environment Captured model and service environment values.
 * @returns {{model: string, service: {port: number | "auto", host?: never} | {host: string, port?: never}}} Required model and explicit service ownership selection.
 * @throws {Error} When no model is supplied.
 */
export function resolveTranslationSettings(options, environment) {
  const model = options.model ?? environment.model;
  if (!model?.trim())
    throw new Error("Provide --model or set OLLAMA_TRANSLATE_MODEL");
  const host = environment.host?.trim();
  return {
    model,
    service:
      options.ollamaPort === undefined && host
        ? { host }
        : { port: options.ollamaPort ?? "auto" },
  };
}
