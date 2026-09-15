import {
  inlineContainers,
  markdownEntries,
  parseMarkdown,
} from "./markdown-syntax.mjs";

export const placeholderPattern = /__KEEP_\d+_\d+__/g;
const pathPattern =
  /(?:[A-Za-z]:[\\/]|\.{0,2}\/|[\p{L}\p{N}_.-]+\/)[\p{L}\p{N}_.~%+@:/\\-]+|[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.(?:md|mdx|json|ya?ml|[cm]?[jt]sx?|astro|css|html|toml|sh|ps1)\b/gu;

/** @typedef {{token: string, value: string, start: number, end: number, kind: string}} ProtectedValue */
/** @typedef {{before: ProtectedValue, after: ProtectedValue, value: string, indentation: string}} BlockSeparator */
/** @typedef {import("./markdown-syntax.mjs").Diagnostic} Diagnostic */

/**
 * Protect non-translatable values without hiding ordinary Markdown formatting.
 * @param {string} body LF-normalized Markdown source.
 * @returns {{body: string, text: string, tree: import("mdast").Root, protected: ProtectedValue[], separators: BlockSeparator[], needsTranslation: boolean, diagnostics: Diagnostic[]}} One masked body and locally retained originals.
 */
export function prepareMarkdown(body) {
  const { tree, resources } = parseMarkdown(body);
  const spans = resources.map(({ start, end, kind }) => ({ start, end, kind }));
  const diagnostics = [];
  const sourceEntries = markdownEntries(tree);
  for (const match of body.matchAll(placeholderPattern))
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: "literal-placeholder",
    });
  for (const { node, parent } of sourceEntries) {
    const from = node.position.start.offset;
    const to = node.position.end.offset;
    const raw = body.slice(from, to);
    if (node.type === "break")
      spans.push({ start: from, end: to - 1, kind: "hard-break" });
    if (
      node.type === "text" ||
      ["image", "imageReference"].includes(node.type)
    ) {
      for (const [pattern, kind] of [
        [pathPattern, "path"],
        [/\\[!-/:-@[-\x60{-~]/g, "escape"],
      ]) {
        for (const match of raw.matchAll(pattern))
          spans.push({
            start: from + match.index,
            end: from + match.index + match[0].length,
            kind,
          });
      }
    }
    if (
      [
        "code",
        "inlineCode",
        "html",
        "definition",
        "footnoteReference",
      ].includes(node.type)
    ) {
      const kind =
        node.type === "code"
          ? "code-block"
          : node.type === "html"
            ? "html"
            : node.type;
      spans.push({ start: from, end: to, kind });
      if (node.type === "html" && !inlineContainers.has(parent?.type))
        diagnostics.push({
          code: "protected-html-block",
          source: node.position.start,
          message:
            "Raw HTML is retained locally; review its visible text manually",
        });
    }
    if (
      ["linkReference", "imageReference"].includes(node.type) &&
      node.referenceType !== "full"
    ) {
      spans.push({ start: from, end: to, kind: "reference-label" });
      diagnostics.push({
        code: "protected-reference-label",
        source: node.position.start,
        message:
          "Shortcut or collapsed reference text is retained because it also identifies the target",
      });
    }
    if (node.type === "link" && !raw.startsWith("[")) {
      spans.push({ start: from, end: to, kind: "autolink" });
      if (!raw.startsWith("<") && /[，。；：！？]/u.test(node.url))
        diagnostics.push({
          code: "source-url-boundary",
          source: node.position.start,
          message:
            "The source Markdown parser includes punctuation or surrounding prose in this bare URL: " +
            JSON.stringify(node.url) +
            ". The URL is preserved, not shortened; review the source boundary.",
        });
    }
    if (node.type === "footnoteDefinition" && node.children.length)
      spans.push({
        start: from,
        end: node.children[0].position.start.offset,
        kind: "footnote-label",
      });
  }
  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  let salt = 0;
  while (body.includes("__KEEP_" + salt + "_")) salt++;
  let cursor = 0;
  let text = "";
  const protectedValues = [];
  for (const span of spans) {
    if (span.start < cursor || span.end <= span.start) continue;
    const token = "__KEEP_" + salt + "_" + protectedValues.length + "__";
    text += body.slice(cursor, span.start) + token;
    protectedValues.push({
      ...span,
      token,
      value: body.slice(span.start, span.end),
    });
    cursor = span.end;
  }
  text += body.slice(cursor);
  const separators = [];
  for (let index = 1; index < protectedValues.length; index++) {
    const before = protectedValues[index - 1];
    const after = protectedValues[index];
    if (
      ![before, after].every(item =>
        ["code-block", "html", "definition"].includes(item.kind)
      )
    )
      continue;
    const indentation = body.slice(
      body.lastIndexOf("\n", before.start - 1) + 1,
      before.start
    );
    const afterLineEnd = body.indexOf("\n", after.end);
    const suffix = body.slice(
      after.end,
      afterLineEnd < 0 ? body.length : afterLineEnd
    );
    const value = body.slice(before.end, after.start);
    if (
      /^[ \t]*$/.test(indentation) &&
      /^[ \t]*$/.test(suffix) &&
      /^[ \t]*\n(?:[ \t]*\n)+[ \t]*$/.test(value)
    )
      separators.push({ before, after, value, indentation });
  }
  const needsTranslation = sourceEntries.some(({ node }) => {
    if (
      node.type !== "text" &&
      !["image", "imageReference"].includes(node.type)
    )
      return false;
    let cursor = node.position.start.offset;
    let visible = "";
    const end = node.position.end.offset;
    for (const span of protectedValues) {
      if (span.end <= cursor || span.start >= end) continue;
      visible += body.slice(cursor, Math.max(cursor, span.start));
      cursor = Math.min(end, span.end);
    }
    visible += body.slice(cursor, end);
    return /[\p{L}\p{N}]/u.test(visible);
  });
  return {
    body,
    text,
    tree,
    protected: protectedValues,
    separators,
    needsTranslation,
    diagnostics,
  };
}

/**
 * Resolve safe block-separator repairs and explain boundaries that cannot be restored.
 * @param {ReturnType<typeof prepareMarkdown>} plan Protected blocks and original separators.
 * @param {string} translation Complete model body before restoration.
 * @returns {{edits: {start: number, end: number, value: string}[], unresolved: {separator: BlockSeparator, reason: string}[]}} Safe replacement ranges and unresolved boundaries for post-write review.
 */
export function resolveBlockSeparators(plan, translation) {
  const occurrences = new Map();
  for (const match of translation.matchAll(placeholderPattern)) {
    if (!occurrences.has(match[0])) occurrences.set(match[0], []);
    occurrences.get(match[0]).push(match.index);
  }
  const edits = [];
  const unresolved = [];
  for (const separator of plan.separators) {
    const before = occurrences.get(separator.before.token) ?? [];
    const after = occurrences.get(separator.after.token) ?? [];
    // Missing and repeated tokens already receive their own validation findings.
    if (before.length !== 1 || after.length !== 1) continue;
    const start = before[0] + separator.before.token.length;
    const end = after[0];
    const gap = translation.slice(start, end);
    if (start <= end && gap === separator.value) continue;
    const prefix = translation.slice(
      translation.lastIndexOf("\n", before[0] - 1) + 1,
      before[0]
    );
    const tokenEnd = after[0] + separator.after.token.length;
    const lineEnd = translation.indexOf("\n", tokenEnd);
    const suffix = translation.slice(
      tokenEnd,
      lineEnd < 0 ? translation.length : lineEnd
    );
    let reason;
    if (start > end) reason = "the placeholders changed order";
    else if (!/^[ \t\n]*$/.test(gap))
      reason = "new content separates the placeholders";
    else if (prefix !== separator.indentation || !/^[ \t]*$/.test(suffix))
      reason =
        "the placeholders no longer have their original standalone block context";
    if (reason) unresolved.push({ separator, reason });
    else edits.push({ start, end, value: separator.value });
  }
  return { edits, unresolved };
}

/**
 * Restore protected content and unambiguous block boundaries without guessing missing text.
 * @param {ReturnType<typeof prepareMarkdown>} plan Local originals and placeholder identities.
 * @param {string} translation Complete model body.
 * @returns {string} Best-effort restored Markdown for the saved draft.
 */
export function restoreMarkdown(plan, translation) {
  const { edits } = resolveBlockSeparators(plan, translation);
  for (const edit of edits.sort((left, right) => right.start - left.start))
    translation =
      translation.slice(0, edit.start) +
      edit.value +
      translation.slice(edit.end);
  const values = new Map(plan.protected.map(item => [item.token, item.value]));
  const hardBreaks = new Set(
    plan.protected
      .filter(item => item.kind === "hard-break")
      .map(item => item.token)
  );
  return translation.replace(
    /(__KEEP_\d+_\d+__)([ \t]*\n)?/g,
    (match, token, newline = "") => {
      // A hard-break token owns one newline, including when the model removes or pads it.
      if (hardBreaks.has(token)) return values.get(token) + "\n";
      return values.has(token) ? values.get(token) + newline : match;
    }
  );
}
