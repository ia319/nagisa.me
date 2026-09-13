import fs from "node:fs/promises";
import path from "node:path";
import { parseTranslationArgs, TRANSLATION_HELP } from "./options.mjs";
import { readTranslationSnapshot, readProjectFile } from "./snapshot.mjs";
import {
  prepareTranslation,
  completeTranslation,
  validateTranslation,
} from "./pipeline.mjs";
import { runOllamaRequests } from "./ollama.mjs";
import { openOllamaService } from "./ollama-service.mjs";
import { prepareWrites, writeTranslations } from "./write.mjs";

/**
 * Write translation drafts, then report content checks without rejecting saved results.
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
  let service;
  let failed = false;
  try {
    if (plan.requests.length) {
      service = await openOllamaService(options.ollamaPort, report, signal);
      signal = service.signal;
    }
    const responses = plan.requests.length
      ? await runOllamaRequests(
          plan.requests,
          plan.model,
          service.host,
          report,
          signal,
          output
        )
      : [];
    const result = completeTranslation(plan, responses);
    report("\n--- Save drafts ---");
    await writeTranslations(writes, result.files, report, signal);
    report("\n--- Content checks ---");
    for (const diagnostic of plan.diagnostics) {
      const point = diagnostic.source;
      report(
        `[source:${diagnostic.code}] src/data/blog/${snapshot.source.path}${point ? `:${plan.article.bodyLine + point.line - 1}:${point.column}` : ""}: ${diagnostic.message}`
      );
    }
    const savedFiles = [];
    const diagnostics = [];
    for (const file of result.files) {
      try {
        savedFiles.push({
          path: file.path,
          text: await readProjectFile(
            snapshot.root,
            path.join("src/data/blog", file.path)
          ),
        });
      } catch (error) {
        diagnostics.push({
          code: "read-failed",
          message: `${file.path}: draft was written, but could not be read for validation: ${error.message}`,
        });
      }
    }
    try {
      diagnostics.push(...validateTranslation(plan, responses, savedFiles));
    } catch (error) {
      diagnostics.push({
        code: "check-failed",
        message: `Content validation could not finish: ${error.message}. Saved drafts were kept.`,
      });
    }
    for (const diagnostic of diagnostics)
      report(`[validation:${diagnostic.code}] ${diagnostic.message}`);
    report(
      `Content validation: ${diagnostics.length} issue group(s). Saved drafts were kept.`
    );
    report(
      `Generated ${result.files.length} draft article(s). Review translations before publication.`
    );
    signal.throwIfAborted();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (service) {
      try {
        await service.stop();
      } catch (error) {
        const message = `Ollama cleanup failed: ${error.message}. Any saved drafts were kept.`;
        if (failed) report(`[cleanup] ${message}`);
        else throw new Error(message, { cause: error });
      }
    }
  }
}
