import { getTagReferenceDiagnostics } from "../../src/utils/localizedTags.mjs";
import { validateLocaleRegistry } from "../locale-config/registry.mjs";
import { parseDocument, stringify } from "yaml";
import { parseArticle, renderArticle } from "./frontmatter.mjs";
import { prepareMarkdown, restoreMarkdown } from "./markdown.mjs";
import { updateMarkdownAnchors } from "./markdown-anchors.mjs";
import { validateMarkdown } from "./markdown-validation.mjs";
import { buildTranslationPrompt } from "./prompts.mjs";
import { planTranslationTargets } from "./targets.mjs";

/**
 * Prepare model requests and same-directory output plans using only snapshots.
 * @param {{source: {path: string, text: string}, registry: unknown, targetLocales: readonly string[], files: readonly import("./targets.mjs").FileState[], tagIds?: readonly string[], model: string, fromLocale?: string, force?: boolean, userPrompt?: string, promptMode?: "append" | "replace"}} input Source, tag identity, and configuration snapshots plus explicit options.
 * @returns Model requests and source data needed for final assembly.
 * @throws {Error} When preflight, frontmatter, tag routes, or prompt options are invalid.
 */
export function prepareTranslation(input) {
  const registry = validateLocaleRegistry(input.registry);
  if (
    typeof input.model !== "string" ||
    !input.model ||
    input.model.length > 256 ||
    input.model.trim() !== input.model ||
    input.model.startsWith("-") ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(
      input.model
    )
  ) {
    throw new Error(
      "Model must be a non-empty name of at most 256 characters without surrounding whitespace, leading hyphens, or control characters"
    );
  }
  const { source, targets } = planTranslationTargets({
    sourcePath: input.source.path,
    files: input.files,
    targetLocales: input.targetLocales,
    config: {
      defaultLocale: registry.defaultLocale,
      supportedLocales: Object.keys(registry.locales),
    },
    fromLocale: input.fromLocale,
    force: input.force,
  });
  const article = parseArticle(input.source.text);
  const markdown = prepareMarkdown(article.body);
  const diagnostics = [
    ...getTagReferenceDiagnostics(
      [
        {
          path: `src/data/blog/${input.source.path}`,
          tags: article.fields.tags,
        },
      ],
      new Set(input.tagIds ?? [])
    ),
    ...markdown.diagnostics,
  ];
  const requests = [];
  // Validate options even when all source text is empty or protected.
  buildTranslationPrompt({
    sourceLocale: source.locale,
    targetLocale: targets[0].locale,
    text: "",
    field: "metadata",
    userPrompt: input.userPrompt,
    promptMode: input.promptMode,
  });
  const outputs = targets.map(target => {
    const fields = {
      title: article.fields.title,
      description: article.fields.description,
    };
    const metadata = {};
    function request(field, text) {
      const id = `${target.locale}:${field}`;
      const prompt = buildTranslationPrompt({
        sourceLocale: source.locale,
        targetLocale: target.locale,
        text,
        field,
        protectedValues: field === "body" ? markdown.protected : [],
        userPrompt: input.userPrompt,
        promptMode: input.promptMode,
      });
      requests.push({
        id,
        sourceLocale: source.locale,
        targetLocale: target.locale,
        field,
        text,
        prompt,
        ...(field === "metadata" ? { format: "json" } : {}),
      });
      return id;
    }
    for (const field of ["title", "description"]) {
      if (fields[field].trim()) metadata[field] = fields[field];
    }
    const metadataId = Object.keys(metadata).length
      ? request("metadata", stringify(metadata, { lineWidth: 0 }))
      : undefined;
    const bodyId = markdown.needsTranslation
      ? request("body", markdown.text)
      : undefined;
    return { ...target, fields, metadata, metadataId, bodyId };
  });
  return {
    article,
    markdown,
    source,
    sourcePath: input.source.path,
    model: input.model,
    requests,
    outputs,
    diagnostics,
  };
}

function readMetadata(output, text) {
  const fields = { ...output.fields };
  const diagnostics = [];
  if (!output.metadataId) return { fields, diagnostics };
  let value;
  try {
    value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected a JSON object");
    // JSON.parse silently keeps the last duplicate key; do not guess which translation was intended.
    const document = parseDocument(text);
    if (document.errors.length)
      throw new Error(document.errors.map(error => error.message).join("; "));
  } catch (error) {
    diagnostics.push({
      code: "metadata-parse",
      message: `${output.metadataId}: ${error.message}. Requested fields remain untranslated: ${Object.keys(output.metadata).join(", ")}. Original field values were kept; see the raw model response above.`,
    });
    return { fields, diagnostics };
  }
  for (const field of Object.keys(value)) {
    if (!Object.hasOwn(output.metadata, field))
      diagnostics.push({
        code: "metadata-extra-field",
        field,
        message: `Unexpected field ${JSON.stringify(field)} was not requested and was not copied into the draft`,
      });
  }
  for (const field of Object.keys(output.metadata)) {
    const translated = value[field];
    if (typeof translated === "string" && translated.trim()) {
      fields[field] = translated.trim();
    } else
      diagnostics.push({
        code: "metadata-field",
        field,
        message: `${field} remains untranslated: expected a non-empty string, received ${JSON.stringify(translated)}; original value was kept`,
      });
  }
  return { fields, diagnostics };
}

/**
 * Assemble draft articles from completed requests without gating on content quality.
 * @param {ReturnType<typeof prepareTranslation>} plan Prepared requests and source snapshot.
 * @param {readonly {id: string, text: string}[]} responses One response for each request.
 * @returns {{files: {path: string, locale: string, overwrite: boolean, text: string}[]}} Complete output set awaiting post-write content review.
 * @throws {Error} When request results are missing, duplicated, or not usable text.
 */
export function completeTranslation(plan, responses) {
  const expected = new Set(plan.requests.map(request => request.id));
  const results = new Map();
  for (const response of responses) {
    if (!expected.has(response.id) || results.has(response.id))
      throw new Error(`Unknown or duplicate model response: ${response.id}`);
    if (typeof response.text !== "string" || !response.text.trim())
      throw new Error(`Empty or invalid model response: ${response.id}`);
    results.set(response.id, response.text.trim().replace(/\r\n?/g, "\n"));
  }
  if (results.size !== expected.size)
    throw new Error(
      `Missing model responses: ${[...expected].filter(id => !results.has(id)).join(", ")}`
    );
  const files = plan.outputs.map(output => {
    const { fields } = readMetadata(output, results.get(output.metadataId));
    const restored = output.bodyId
      ? restoreMarkdown(plan.markdown, results.get(output.bodyId))
      : plan.markdown.body;
    const body = updateMarkdownAnchors(plan.markdown, restored).body;
    return {
      path: output.path,
      locale: output.locale,
      overwrite: output.overwrite,
      text: renderArticle(plan.article, fields, body, {
        sourceLocale: plan.source.locale,
        model: plan.model,
      }),
    };
  });
  return { files };
}

/**
 * Inspect saved drafts and report content issues without rejecting saved results.
 * @param {ReturnType<typeof prepareTranslation>} plan Source snapshot and requested fields.
 * @param {readonly {id: string, text: string}[]} responses Original model results for placeholder checks.
 * @param {readonly {path: string, text: string}[]} files Article texts read after successful writes.
 * @returns {{code: string, message: string}[]} Review findings with file, field, and difference details.
 */
export function validateTranslation(plan, responses, files) {
  const diagnostics = [];
  // Match assembly normalization so CRLF does not look like new block content.
  const results = new Map(
    responses.map(response => [
      response.id,
      response.text.trim().replace(/\r\n?/g, "\n"),
    ])
  );
  for (const output of plan.outputs) {
    const file = files.find(file => file.path === output.path);
    if (!file) continue;
    let article;
    try {
      article = parseArticle(file.text);
    } catch (error) {
      diagnostics.push({
        code: "frontmatter",
        message: `${output.path}: ${error.message}`,
      });
      continue;
    }
    const metadata = readMetadata(output, results.get(output.metadataId));
    for (const diagnostic of metadata.diagnostics) {
      const sourcePoint = plan.article.fieldPositions[diagnostic.field];
      const targetPoint = article.fieldPositions[diagnostic.field];
      diagnostics.push({
        code: diagnostic.code,
        message: `src/data/blog/${output.path}${targetPoint ? `:${targetPoint.line}:${targetPoint.column}` : ""}: ${diagnostic.message}\n  Source: src/data/blog/${plan.sourcePath}${sourcePoint ? `:${sourcePoint.line}:${sourcePoint.column}` : ""}`,
      });
    }
    const fields = [];
    for (const field of Object.keys(output.metadata)) {
      fields.push({
        name: field,
        key: field,
        source: plan.article.fields[field],
        value: article.fields[field],
      });
    }
    for (const field of fields) {
      const point = article.fieldPositions[field.key];
      const location = `src/data/blog/${output.path}${point ? `:${point.line}:${point.column}` : ""}: ${field.name}`;
      const text = field.value;
      if (typeof text !== "string" || !text.trim()) {
        diagnostics.push({
          code: "field-empty",
          message: `${location}: saved field is empty or missing`,
        });
        continue;
      }
      for (const match of text.matchAll(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
      ))
        diagnostics.push({
          code: "control-character",
          message: `${location}, character ${match.index + 1}: unexpected U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
        });
      if (field.key !== "description" && /[\r\n]/.test(text))
        diagnostics.push({
          code: "field-newline",
          message: `${location} must be a single line; received ${JSON.stringify(text)}`,
        });
      const sourceTokens = [...field.source.matchAll(/__KEEP_\d+_\d+__/g)].map(
        match => match[0]
      );
      for (const match of text.matchAll(/__KEEP_\d+_\d+__/g)) {
        const index = sourceTokens.indexOf(match[0]);
        if (index >= 0) sourceTokens.splice(index, 1);
        else
          diagnostics.push({
            code: "field-placeholder",
            message: `${location}, character ${match.index + 1}: unexpected ${match[0]}; metadata was sent without generated placeholders`,
          });
      }
      if (/^\s*(?:```|~~~|---\s*\n)/.test(text))
        diagnostics.push({
          code: "field-wrapper",
          message: `${location} contains Markdown or YAML wrapping instead of a field value: ${JSON.stringify(text.slice(0, 160))}`,
        });
    }
    const translatedBody = output.bodyId
      ? results.get(output.bodyId)
      : plan.markdown.text;
    for (const diagnostic of validateMarkdown(
      plan.markdown,
      translatedBody,
      article.body
    )) {
      const sourcePoint = diagnostic.source;
      const targetPoint = diagnostic.target;
      diagnostics.push({
        code: diagnostic.code,
        message:
          `src/data/blog/${output.path}${targetPoint ? `:${article.bodyLine + targetPoint.line - 1}:${targetPoint.column}` : " (target location unavailable)"}: ${diagnostic.details.length} related finding(s)` +
          `\n  Source: src/data/blog/${plan.sourcePath}${sourcePoint ? `:${plan.article.bodyLine + sourcePoint.line - 1}:${sourcePoint.column}` : " (no corresponding source node)"}` +
          diagnostic.details
            .map(
              item =>
                `\n  - [${item.code}] ${item.message}\n    ` +
                (item.source
                  ? `source src/data/blog/${plan.sourcePath}:${plan.article.bodyLine + item.source.line - 1}:${item.source.column}`
                  : "source location unavailable") +
                (item.target
                  ? `; saved src/data/blog/${output.path}:${article.bodyLine + item.target.line - 1}:${item.target.column}`
                  : "; saved location unavailable")
            )
            .join("") +
          `\n  Original: ${diagnostic.original}\n  Saved: ${diagnostic.saved}`,
      });
    }
    if (
      article.document.has("tags") !== plan.article.document.has("tags") ||
      JSON.stringify(article.fields.tags) !==
        JSON.stringify(plan.article.fields.tags)
    ) {
      diagnostics.push({
        code: "tags-modified",
        message: `src/data/blog/${output.path}: saved tags differ from the source IDs`,
      });
    }
  }
  return diagnostics;
}
