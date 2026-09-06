import {
  buildTagRelations,
  resolveTagTranslation,
} from "../../src/utils/localizedTags.mjs";
import { validateLocaleRegistry } from "../locale-config/registry.mjs";
import { parseArticle, renderArticle } from "./frontmatter.mjs";
import { prepareMarkdown, restoreMarkdown } from "./markdown.mjs";
import { buildTranslationPrompt } from "./prompts.mjs";
import { planTranslationTargets } from "./targets.mjs";

/**
 * Prepare model requests and same-directory output plans using only snapshots.
 * @param {{source: {path: string, text: string}, registry: unknown, targetLocales: readonly string[], files: readonly import("./targets.mjs").FileState[], references?: readonly import("../../src/utils/localizedTags.mjs").LocalizedTagContent[], model: string, fromLocale?: string, force?: boolean, userPrompt?: string, promptMode?: "append" | "replace"}} input Source, reference, and configuration snapshots plus explicit options.
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
  const references = [...(input.references ?? [])].filter(
    item => item.baseId !== source.baseId || item.locale !== source.locale
  );
  const declaredSource = article.document.getIn([
    "translation",
    "sourceLocale",
  ]);
  references.push({
    baseId: source.baseId,
    locale: source.locale,
    tags: article.fields.tags,
    ...(typeof declaredSource === "string"
      ? { translation: { sourceLocale: declaredSource } }
      : {}),
  });
  const relations = buildTagRelations(references);
  const diagnostics = [...relations.diagnostics, ...markdown.diagnostics];
  const requests = [];
  // Validate options even when all source text is empty or protected.
  buildTranslationPrompt({
    sourceLocale: source.locale,
    targetLocale: targets[0].locale,
    text: "",
    userPrompt: input.userPrompt,
    promptMode: input.promptMode,
  });
  const outputs = targets.map(target => {
    const fields = {
      title: article.fields.title,
      description: article.fields.description,
      tags: [...article.fields.tags],
    };
    const slots = [];
    function request(field, index, text) {
      const id = `${target.locale}:${field}:${index}`;
      const prompt = buildTranslationPrompt({
        sourceLocale: source.locale,
        targetLocale: target.locale,
        text,
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
      });
      slots.push({ id, field, index });
    }
    for (const field of ["title", "description"]) {
      if (fields[field].trim()) request(field, 0, fields[field]);
    }
    for (const [index, tag] of fields.tags.entries()) {
      const reused = resolveTagTranslation(
        relations,
        source.locale,
        tag,
        target.locale
      );
      if (reused.status === "resolved") fields.tags[index] = reused.value.tag;
      else request("tags", index, tag);
    }
    markdown.segments.forEach((segment, index) =>
      request("body", index, segment.text)
    );
    return { ...target, fields, slots };
  });
  return {
    article,
    markdown,
    source,
    model: input.model,
    references,
    requests,
    outputs,
    diagnostics,
  };
}

/**
 * Validate every model response before returning any writable article output.
 * @param {ReturnType<typeof prepareTranslation>} plan Prepared requests and source snapshot.
 * @param {readonly {id: string, text: string}[]} responses One response for each request.
 * @returns {{files: {path: string, locale: string, overwrite: boolean, text: string}[], diagnostics: {code: string, message: string}[]}} Complete output set and diagnostics for caller logging.
 * @throws {Error} When responses are missing, duplicated, invalid, or create tag route conflicts.
 */
export function completeTranslation(plan, responses) {
  const expected = new Set(plan.requests.map(request => request.id));
  const results = new Map();
  for (const response of responses) {
    if (!expected.has(response.id) || results.has(response.id))
      throw new Error(`Unknown or duplicate model response: ${response.id}`);
    if (
      typeof response.text !== "string" ||
      !response.text.trim() ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(response.text)
    )
      throw new Error(`Empty or invalid model response: ${response.id}`);
    results.set(response.id, response.text.trim());
  }
  if (results.size !== expected.size)
    throw new Error(
      `Missing model responses: ${[...expected].filter(id => !results.has(id)).join(", ")}`
    );
  const completed = plan.outputs.map(output => {
    const fields = { ...output.fields, tags: [...output.fields.tags] };
    const body = [];
    for (const slot of output.slots) {
      const text = results.get(slot.id);
      if (slot.field === "body") body[slot.index] = text;
      else if (slot.field === "tags") {
        if (/[\r\n]/.test(text))
          throw new Error(`Tag result must be a single line: ${slot.id}`);
        fields.tags[slot.index] = text;
      } else fields[slot.field] = text.replace(/\r\n?/g, "\n");
    }
    const translatedBody = restoreMarkdown(plan.markdown, body);
    return {
      ...output,
      fields,
      text: renderArticle(plan.article, fields, translatedBody, {
        sourceLocale: plan.source.locale,
        model: plan.model,
      }),
    };
  });
  const targetLocales = new Set(completed.map(output => output.locale));
  const references = plan.references.filter(
    item =>
      item.baseId !== plan.source.baseId || !targetLocales.has(item.locale)
  );
  references.push(
    ...completed.map(output => ({
      baseId: plan.source.baseId,
      locale: output.locale,
      tags: output.fields.tags,
      translation: { sourceLocale: plan.source.locale },
    }))
  );
  const relations = buildTagRelations(references);
  const diagnostics = [...plan.diagnostics];
  for (const item of relations.diagnostics) {
    if (
      !diagnostics.some(
        previous =>
          previous.code === item.code && previous.message === item.message
      )
    )
      diagnostics.push(item);
  }
  return {
    files: completed.map(({ path, locale, overwrite, text }) => ({
      path,
      locale,
      overwrite,
      text,
    })),
    diagnostics,
  };
}
