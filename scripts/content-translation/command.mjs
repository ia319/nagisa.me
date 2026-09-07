import fs from "node:fs/promises";
import path from "node:path";
import { parseTranslationArgs, TRANSLATION_HELP } from "./options.mjs";
import { readTranslationSnapshot } from "./snapshot.mjs";
import { prepareTranslation, completeTranslation } from "./pipeline.mjs";
import { runOllamaRequests } from "./ollama.mjs";
import { prepareWrites, writeTranslations } from "./write.mjs";

/**
 * Run translation from argument validation through complete-set publication.
 * @param {string} root Working directory, expected to be the project root.
 * @param {string[]} args Command arguments after the script name.
 * @param {(message: string) => void} report Help, progress, and diagnostic sink.
 * @param {AbortSignal} signal Cancellation signal shared with process and write boundaries.
 * @returns {Promise<void>} Resolves after help or successful publication.
 * @throws {Error} When arguments, preflight, generation, validation, or publication fails.
 */
export async function runTranslationCommand(root, args, report, signal) {
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
  for (const diagnostic of plan.diagnostics)
    report(`[${diagnostic.code}] ${diagnostic.message}`);
  const responses = await runOllamaRequests(
    plan.requests,
    plan.model,
    report,
    signal
  );
  const result = completeTranslation(plan, responses);
  for (const diagnostic of result.diagnostics) {
    if (
      !plan.diagnostics.some(
        item =>
          item.code === diagnostic.code && item.message === diagnostic.message
      )
    )
      report(`[${diagnostic.code}] ${diagnostic.message}`);
  }
  await writeTranslations(writes, result.files, report, signal);
  report(
    `Generated ${result.files.length} draft article(s). Review translations before publication.`
  );
}
