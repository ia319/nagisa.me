import { parseArgs } from "node:util";

export const TRANSLATION_HELP = `Usage: pnpm content:translate [--] <file> --to <locale> [options]
       pnpm content:translate [--] --staged --to <locale> [options]

Translate one blog article with an installed local Ollama model.
Run from the project root. No arguments show help without external calls.

  --to <locale>          Target language; repeat for multiple targets
  --from <locale>        Check the source language inferred from its filename
  --model <name>         Local model (fallback: OLLAMA_TRANSLATE_MODEL)
  --staged               Read exactly one changed blog source from the index
  --prompt <text>        Custom translation context
  --prompt-file <file>   Read custom context as UTF-8; exclusive with --prompt
  --prompt-mode <mode>   append (default) or replace built-in context
  --force               Allow replacing existing target articles
  -h, --help            Show this help

Staged mode also reads reference articles and locales.config.mjs from index.
Generated files are drafts in the source directory. Review them before publishing.
Start Ollama and install the model manually; keep both unchanged during the run.
No automatic staging, commits, model downloads, or service startup commands.
`;

/**
 * Parse the command contract without reading files or contacting Ollama.
 * @param {string[]} args Arguments after the script name, optionally prefixed by pnpm's separator.
 * @param {string | undefined} environmentModel Fallback from OLLAMA_TRANSLATE_MODEL.
 * @returns {{file?: string, staged: boolean, targetLocales: string[], fromLocale?: string, model: string, userPrompt?: string, promptFile?: string, promptMode: "append" | "replace", force: boolean} | null} Explicit options, or null for help.
 * @throws {Error} When inputs, targets, model selection, or prompt options conflict.
 */
export function parseTranslationArgs(args, environmentModel) {
  if (args[0] === "--") args = args.slice(1);
  const { values, positionals, tokens } = parseArgs({
    args,
    allowPositionals: true,
    tokens: true,
    options: {
      to: { type: "string", multiple: true },
      from: { type: "string" },
      model: { type: "string" },
      staged: { type: "boolean" },
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      "prompt-mode": { type: "string", default: "append" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (!args.length || values.help) return null;
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== "option" || token.name === "to") continue;
    if (seen.has(token.name)) throw new Error(`Do not repeat --${token.name}`);
    seen.add(token.name);
  }
  if (values.staged ? positionals.length !== 0 : positionals.length !== 1)
    throw new Error("Provide exactly one source file or --staged, not both");
  if (!values.to?.length || values.to.some(locale => !locale.trim()))
    throw new Error("Provide at least one --to <locale>");
  if (values.prompt !== undefined && values["prompt-file"] !== undefined)
    throw new Error("--prompt and --prompt-file are mutually exclusive");
  if (values["prompt-mode"] !== "append" && values["prompt-mode"] !== "replace")
    throw new Error("--prompt-mode must be append or replace");
  const model = values.model ?? environmentModel;
  if (!model?.trim())
    throw new Error("Provide --model or set OLLAMA_TRANSLATE_MODEL");
  return {
    file: positionals[0],
    staged: values.staged ?? false,
    targetLocales: values.to,
    fromLocale: values.from,
    model,
    userPrompt: values.prompt,
    promptFile: values["prompt-file"],
    promptMode: values["prompt-mode"],
    force: values.force ?? false,
  };
}
