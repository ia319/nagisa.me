import {
  isAlias,
  isCollection,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  visit,
} from "yaml";
import {
  TRANSLATION_FIELD_ACTION,
  TRANSLATION_FIELD_POLICY,
  TRANSLATION_FRONTMATTER_OVERRIDES,
  TRANSLATION_PROVIDER,
} from "../../src/content/translationContract.mjs";

/**
 * Parse a content snapshot while retaining YAML nodes, comments, and field order.
 * @param {string} source Complete Markdown source supplied by the caller.
 * @param {"blog" | "tags"} kind Validated collection. Defaults to article parsing.
 * @returns {{kind: "blog" | "tags", document: import("yaml").Document, body: string, bodyLine: number, fieldPositions: Record<string, {line: number, column: number}>, fields: Record<string, string | string[]>}} Parsed source and physical field/body positions without file access.
 * @throws {Error} When frontmatter is malformed or cannot safely preserve field values.
 */
export function parseContent(source, kind = "blog") {
  if (!["blog", "tags"].includes(kind)) throw new Error("Unknown content kind");
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---[\t ]*\n([\s\S]*?)^---[\t ]*(?:\n|$)/m.exec(text);
  if (!match || match.index !== 0)
    throw new Error("Content must start with YAML frontmatter");
  const lineCounter = new LineCounter();
  const document = parseDocument(match[1], { lineCounter });
  if (document.errors.length || document.warnings.length) {
    throw new Error(
      `Invalid frontmatter: ${[...document.errors, ...document.warnings].map(item => item.message).join("; ")}`
    );
  }
  if (!isMap(document.contents))
    throw new Error("Frontmatter must be a mapping");
  visit(document, (_key, node) => {
    // Editing an anchored field could silently change another copied field.
    if (
      isAlias(node) ||
      ((isScalar(node) || isCollection(node)) && node.anchor)
    ) {
      throw new Error(
        "YAML anchors and aliases are not supported for translation"
      );
    }
  });
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new Error("Frontmatter field names must be strings");
    }
  }
  const fields = {};
  if (kind === "blog") {
    for (const key of ["title", "description"]) {
      const value = document.get(key);
      if (typeof value !== "string")
        throw new Error("Frontmatter title and description must be strings");
      fields[key] = value;
    }
  } else {
    const name = document.get("name");
    if (typeof name !== "string" || !name.trim())
      throw new Error("Frontmatter name must be a non-empty string");
    fields.name = name;
    if (document.has("description")) {
      const description = document.get("description");
      if (typeof description !== "string")
        throw new Error("Frontmatter description must be a string");
      fields.description = description;
    }
  }
  const arrayKey = kind === "blog" ? "tags" : "aliases";
  const arrayNode = document.get(arrayKey, true);
  const values = [];
  if (arrayNode !== undefined) {
    if (!isSeq(arrayNode))
      throw new Error(`Frontmatter ${arrayKey} must be a string array`);
    for (const item of arrayNode.items) {
      if (!isScalar(item) || typeof item.value !== "string")
        throw new Error(`Frontmatter ${arrayKey} must be a string array`);
      values.push(item.value);
    }
  }
  if (kind === "blog") fields.tags = values;
  const fieldPositions = {};
  for (const pair of document.contents.items) {
    const point = lineCounter.linePos(pair.key.range[0]);
    fieldPositions[pair.key.value] = {
      line: point.line + 1,
      column: point.col,
    };
  }
  return {
    kind,
    document,
    body: text.slice(match[0].length),
    bodyLine: match[0].split("\n").length,
    fieldPositions,
    fields,
  };
}

/**
 * Assemble translated fields and Markdown using the shared content contract.
 * @param {ReturnType<typeof parseContent>} content Source snapshot.
 * @param {Record<string, string>} fields Translated fields awaiting post-write content review.
 * @param {string} body Restored Markdown body awaiting post-write content review.
 * @param {{sourceLocale: string, model: string}} provenance Actual translation source and model.
 * @param {import("yaml").Node | undefined} targetAliases Target-language aliases to preserve; omitted for a new translation.
 * @returns {string} Markdown text with LF, no BOM, and a final newline.
 */
export function renderContent(
  content,
  fields,
  body,
  provenance,
  targetAliases
) {
  const document = content.document.clone();
  if (content.kind === "blog") {
    for (const [field, action] of Object.entries(TRANSLATION_FIELD_POLICY)) {
      if (action === TRANSLATION_FIELD_ACTION.OMIT) document.delete(field);
      if (action === TRANSLATION_FIELD_ACTION.TRANSLATE)
        document.set(field, fields[field]);
    }
  } else {
    document.set("name", fields.name);
    if (document.has("description"))
      document.set("description", fields.description);
    document.delete("aliases");
    if (targetAliases !== undefined)
      document.set("aliases", targetAliases.clone());
  }
  for (const [field, value] of Object.entries(
    TRANSLATION_FRONTMATTER_OVERRIDES
  ))
    document.set(field, value);
  document.set("translation", {
    sourceLocale: provenance.sourceLocale,
    provider: TRANSLATION_PROVIDER,
    model: provenance.model,
  });
  const output = `---\n${document.toString({ lineWidth: 0 })}---\n${body}`;
  return output.endsWith("\n") ? output : `${output}\n`;
}
