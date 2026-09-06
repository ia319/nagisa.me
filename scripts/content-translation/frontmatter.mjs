import {
  isAlias,
  isCollection,
  isMap,
  isScalar,
  isSeq,
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
 * Parse an article snapshot while retaining YAML nodes, comments, and field order.
 * @param {string} source Complete Markdown source supplied by the caller.
 * @returns {{document: import("yaml").Document, body: string, fields: {title: string, description: string, tags: string[]}}} Parsed source without file access.
 * @throws {Error} When frontmatter is malformed or cannot safely preserve field values.
 */
export function parseArticle(source) {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---[\t ]*\n([\s\S]*?)^---[\t ]*(?:\n|$)/m.exec(text);
  if (!match || match.index !== 0)
    throw new Error("Article must start with YAML frontmatter");
  const document = parseDocument(match[1]);
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
  const title = document.get("title");
  const description = document.get("description");
  if (typeof title !== "string" || typeof description !== "string") {
    throw new Error("Frontmatter title and description must be strings");
  }
  const tagNode = document.get("tags", true);
  const tags = [];
  if (tagNode !== undefined) {
    if (!isSeq(tagNode))
      throw new Error("Frontmatter tags must be a string array");
    for (const item of tagNode.items) {
      if (!isScalar(item) || typeof item.value !== "string")
        throw new Error("Frontmatter tags must be a string array");
      tags.push(item.value);
    }
  }
  return {
    document,
    body: text.slice(match[0].length),
    fields: { title, description, tags },
  };
}

/**
 * Assemble translated fields and Markdown using the shared content contract.
 * @param {ReturnType<typeof parseArticle>} article Source article snapshot.
 * @param {{title: string, description: string, tags: string[]}} fields Validated translated fields.
 * @param {string} body Validated translated Markdown body.
 * @param {{sourceLocale: string, model: string}} provenance Actual translation source and model.
 * @returns {string} Markdown text with LF, no BOM, and a final newline.
 * @throws {Error} When the translated tag count differs from the source.
 */
export function renderArticle(article, fields, body, provenance) {
  if (fields.tags.length !== article.fields.tags.length)
    throw new Error("Translated tag count must match the source");
  const document = article.document.clone();
  for (const [field, action] of Object.entries(TRANSLATION_FIELD_POLICY)) {
    if (action === TRANSLATION_FIELD_ACTION.OMIT) document.delete(field);
    if (action !== TRANSLATION_FIELD_ACTION.TRANSLATE) continue;
    if (field === "tags") {
      if (document.has("tags")) {
        fields.tags.forEach((tag, index) =>
          document.setIn(["tags", index], tag)
        );
      }
    } else {
      document.set(field, fields[field]);
    }
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
