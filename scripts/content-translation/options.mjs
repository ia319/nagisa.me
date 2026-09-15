import { parseArgs } from "node:util";

export const TRANSLATION_HELP = `Usage: pnpm content:translate [--] <file> --to <locale> [options]
       pnpm content:translate [--] --staged --to <locale> [options]

Translate one Markdown article under src/data/blog with a local Ollama model.
Run from the project root. Select a source file or --staged and provide --to.
Run without arguments to show help without reading articles or calling Ollama.

Options:
  --to <locale>         Configured target language; repeatable
  --from <locale>       Source language; must match the filename language
  --model <name>        Local model name for this run
  --ollama-port <port|auto>
                       Private service port (1–65535) or automatic selection
  --staged             One added, modified, or renamed article from the Git index
  --prompt <text>       Custom translation context
  --prompt-file <file>  UTF-8 context file; mutually exclusive with --prompt
  --prompt-mode <mode>  Built-in context mode: append (default) or replace
  --force              Replacement of existing target articles
  -h, --help           Show help and exit

Input:
  File mode uses the working-tree source, references, and locale registry.
  --staged reads the source, all tracked blog references, and locales.config.mjs
  from Git index. Zero or multiple changed source articles stop the command.
  Output conflict checks always use the working tree.
  The source language comes from the filename suffix, or the configured default
  when no language suffix is present. --from must match this language.
  Every --to language must differ from the source language, even with --force.

Defaults:
  Project file: translation.config.mjs, self-contained ESM data with a
  default-exported plain object and no relative imports. Fields: model (string,
  default "") and port ("auto" or an integer from 1 to 65535, default "auto";
  numeric strings are invalid).
  Model priority: --model > OLLAMA_TRANSLATE_MODEL > configuration model.
  Service priority: --ollama-port > OLLAMA_HOST > configuration port > auto.
  Empty or whitespace-only environment values and configuration model values
  are unset.
  A model is required; explicit empty --model and invalid names stop the command.
  Configuration is read once, only when needed for either fallback, always from
  the working tree even with --staged. Missing files or fields use defaults;
  unreadable or invalid configuration, unknown fields, and invalid types fail
  when loaded. Translation leaves the file unchanged.

Model and context:
  Install the selected model manually. An unavailable model has no fallback.
  Remote servers and cloud models are rejected. Keep the model, content, index,
  and configuration unchanged; removing a model between checks can trigger a CLI
  download. Availability checks do not lock model or service state.
  The replace mode requires custom context and replaces only the built-in context.
  Source and target language instructions, translation-only output, and Markdown
  placeholder constraints remain required.

Ollama service:
  A selected command or configuration port starts a private Windows instance:
  auto selects an automatic port; a number selects a fixed port.
  A selected OLLAMA_HOST connects to an existing local service without starting
  or stopping it. Other platforms require this mode.
  Automatic startup requires Windows 10 or later and powershell.exe with Add-Type
  and process creation allowed. Private services bind 127.0.0.1, start after
  preflight when requests are needed, and stop after completion, failure,
  or cancellation.
  Startup has a 60-second limit, separate from model loading. Automatic selection
  retries confirmed bind conflicts at most three times. Fixed-port failures need
  another port or auto; --force does not authorize taking over a service.
  Service environment settings are per-run. Model-directory and GPU settings are
  inherited; private services use OLLAMA_NO_CLOUD=1 and OLLAMA_NOPRUNE=1.
  Startup may still initialize Ollama user files or adjust model storage.
  Concurrent instances can compete for GPU memory. Startup failures include a
  limited service-log tail.

Output and recovery:
  Metadata requests include non-empty title and description fields and only tags
  without reusable translations. Metadata and body use separate requests.
  All model responses are collected before drafts are written. Draft saving and
  content checks continue if Ollama exits after all responses are collected.
  Content checks read the saved drafts and report findings without rejecting them.
  Drafts use the source directory and UTF-8 without BOM. New targets use
  <name>.<locale>.md, or <name>.md for the default language. Existing target
  filenames are retained.
  Invalid metadata retains the affected source values; no repair is requested.
  Input or model execution failures leave article files unchanged. Write failures
  retain completed drafts and report failed targets, pending targets, and temporary
  files.
  Review retained temporary files before removing them. Use Ctrl+C to cancel.
  Replacement requires matching target and temporary-file owners. On Windows,
  keep powershell.exe available and allow file ownership reads.
  Review drafts before publishing. Stage and commit reviewed files separately;
  the command does not stage files or create commits. Service cleanup failures are
  reported separately, and saved drafts remain available.

Exit status: 0 for help or completion (including content findings), 1 for failure,
             130 for cancellation.
`;

/**
 * Parse the command contract without reading files or contacting Ollama.
 * @param {string[]} args Arguments after the script name, optionally prefixed by pnpm's separator.
 * @returns {{file?: string, staged: boolean, targetLocales: string[], fromLocale?: string, model?: string, ollamaPort?: number | "auto", userPrompt?: string, promptFile?: string, promptMode: "append" | "replace", force: boolean} | null} Explicit options, or null for help.
 * @throws {Error} When inputs, targets, model selection, or prompt options conflict.
 */
export function parseTranslationArgs(args) {
  if (args[0] === "--") args = args.slice(1);
  const { values, positionals, tokens } = parseArgs({
    args,
    allowPositionals: true,
    tokens: true,
    options: {
      to: { type: "string", multiple: true },
      from: { type: "string" },
      model: { type: "string" },
      "ollama-port": { type: "string" },
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
  if (values.model !== undefined && !values.model.trim())
    throw new Error("--model must not be empty");
  const rawPort = values["ollama-port"];
  if (
    rawPort !== undefined &&
    rawPort !== "auto" &&
    (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)
  )
    throw new Error(
      "--ollama-port must be auto or a decimal port from 1 to 65535"
    );
  return {
    file: positionals[0],
    staged: values.staged ?? false,
    targetLocales: values.to,
    fromLocale: values.from,
    model: values.model,
    ollamaPort:
      rawPort === undefined
        ? undefined
        : rawPort === "auto"
          ? "auto"
          : Number(rawPort),
    userPrompt: values.prompt,
    promptFile: values["prompt-file"],
    promptMode: values["prompt-mode"],
    force: values.force ?? false,
  };
}
