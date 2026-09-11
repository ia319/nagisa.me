import fs from "node:fs/promises";
import path from "node:path";
import { parseTranslationArgs, TRANSLATION_HELP } from "./options.mjs";
import { readTranslationSnapshot } from "./snapshot.mjs";
import {
  prepareTranslation,
  completeTranslation,
  validateTranslation,
} from "./pipeline.mjs";
import { runOllamaRequests } from "./ollama.mjs";
import { prepareWrites, writeTranslations } from "./write.mjs";

/**
 * Report content checks and write translation drafts.
 * @param {string} root Working directory, expected to be the project root.
 * @param {string[]} args Command arguments after the script name.
 * @param {(message: string) => void} report Help, progress, and diagnostic sink.
 * @param {AbortSignal} signal Cancellation signal shared with process and write boundaries.
 * @param {{stdout: import("node:stream").Writable, stderr: import("node:stream").Writable}} output Destinations for original Ollama output.
 * @returns {Promise<void>} Resolves after help or successful publication.
 * @throws {Error} When arguments, preflight, generation, or publication fails.
 */
export async function runTranslationCommand(
  root,
  args,
  report,
  signal,
  output
) {
  const options = parseTranslationArgs(
    args,
    process.env.OLLAMA_TRANSLATE_MODEL
  );
  if (options === null) {
    report(TRANSLATION_HELP);
    return;
  }
  signal.throwIfAborted();
  const snapshot = await readTranslationSnapshot(root, options);
  const userPrompt =
    options.promptFile === undefined
      ? options.userPrompt
      : await fs.readFile(path.resolve(root, options.promptFile), "utf8");
  const plan = prepareTranslation({ ...snapshot, ...options, userPrompt });
  const writes = await prepareWrites(snapshot.root, plan.outputs);
  const responses = await runOllamaRequests(
    plan.requests,
    plan.model,
    report,
    signal,
    output
  );
  const result = completeTranslation(plan, responses);
  for (const diagnostic of plan.diagnostics) {
    report(`[source:${diagnostic.code}] ${diagnostic.message}`);
  }
  const diagnostics = validateTranslation(plan, responses, result.files);
  for (const diagnostic of diagnostics)
    report(`[validation:${diagnostic.code}] ${diagnostic.message}`);
  report(`Content validation: ${diagnostics.length} issue group(s).`);
  await writeTranslations(writes, result.files, report, signal);
  report(
    `Generated ${result.files.length} draft article(s). Review translations before publication.`
  );
}
