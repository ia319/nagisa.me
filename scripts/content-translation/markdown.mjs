import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const parserOptions = {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
};
const placeholderPattern = /__KEEP_\d+_\d+__/g;
const pathPattern =
  /(?:[A-Za-z]:[\\/]|\.{0,2}\/|[\p{L}\p{N}_.-]+\/)[\p{L}\p{N}_.~%+@:/\\-]+|[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.(?:md|mdx|json|ya?ml|[cm]?[jt]sx?|astro|css|html|toml|sh|ps1)\b/gu;

/** @typedef {{token: string, value: string, pair?: string, side?: "open" | "close"}} ProtectedValue */
/** @typedef {{start: number, end: number, text: string, protected: ProtectedValue[]}} MarkdownSegment */

function structure(node) {
  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "position" ||
      (node.type === "text" && key === "value") ||
      (["image", "imageReference"].includes(node.type) && key === "alt")
    )
      continue;
    if (key === "children") {
      const children = value
        .filter(child => child.type !== "text")
        .map(structure);
      // MDAST does not represent HTML nesting, so retain the raw tag sequence.
      result.html = children.filter(child => child.type === "html");
      // Inline phrases may move during translation; block order and nesting may not.
      if (
        [
          "paragraph",
          "heading",
          "tableCell",
          "emphasis",
          "strong",
          "delete",
          "link",
          "linkReference",
        ].includes(node.type)
      ) {
        children.sort((a, b) => {
          const left = JSON.stringify(a);
          const right = JSON.stringify(b);
          return left < right ? -1 : left > right ? 1 : 0;
        });
      }
      result[key] = children;
    } else result[key] = value;
  }
  return result;
}

/**
 * Plan source-position replacements without serializing the Markdown AST.
 * @param {string} body LF-normalized Markdown source.
 * @returns {{body: string, segments: MarkdownSegment[], diagnostics: {code: string, message: string}[]}} Protected fragments and preservation diagnostics.
 */
export function prepareMarkdown(body) {
  const tree = fromMarkdown(body, parserOptions);
  /** @type {MarkdownSegment[]} */
  const segments = [];
  const diagnostics = [];
  let salt = 0;
  while (body.includes(`__KEEP_${salt}_`)) salt++;
  let tokenIndex = 0;

  function segment(container) {
    if (!container.children.length) return;
    const start = container.children[0].position.start.offset;
    const end = container.children.at(-1).position.end.offset;
    const spans = [];
    function protect(from, to, pair, side) {
      if (to > from) spans.push({ start: from, end: to, pair, side });
    }
    function inline(node) {
      const from = node.position.start.offset;
      const to = node.position.end.offset;
      const raw = body.slice(from, to);
      if (node.type === "link" && node.url.startsWith("#"))
        diagnostics.push({
          code: "review-heading-anchor",
          message: `Review anchor ${node.url} after translating headings`,
        });
      if (node.type === "text") {
        for (const pattern of [
          placeholderPattern,
          pathPattern,
          /\\[!-/:-@[-`{-~]/g,
        ]) {
          for (const match of raw.matchAll(pattern))
            protect(from + match.index, from + match.index + match[0].length);
        }
      } else if (
        ["linkReference", "imageReference"].includes(node.type) &&
        node.referenceType !== "full"
      ) {
        protect(from, to);
        diagnostics.push({
          code: "protected-reference-label",
          message: `Keep shortcut or collapsed reference label at offset ${from}; changing it would change its target`,
        });
      } else if (["image", "imageReference"].includes(node.type)) {
        // The alt label ends at the matching unescaped bracket, not at a URL bracket.
        let depth = 1;
        let close = 2;
        for (; close < raw.length; close++) {
          if (raw[close] === "\\") {
            close++;
            continue;
          }
          if (raw[close] === "[") depth++;
          if (raw[close] === "]" && --depth === 0) break;
        }
        protect(from, from + 2, `image:${from}`, "open");
        inline({
          type: "text",
          position: {
            start: { offset: from + 2 },
            end: { offset: from + close },
          },
        });
        protect(from + close, to, `image:${from}`, "close");
      } else if (
        node.children &&
        (node.type !== "link" || raw.startsWith("["))
      ) {
        const children = node.children;
        if (!children.length) {
          protect(from, to);
          return;
        }
        protect(
          from,
          children[0].position.start.offset,
          `${node.type}:${from}`,
          "open"
        );
        children.forEach(inline);
        protect(
          children.at(-1).position.end.offset,
          to,
          `${node.type}:${from}`,
          "close"
        );
      } else {
        protect(from, to);
      }
    }
    container.children.forEach(inline);
    // Keep continuation prefixes inside list items and blockquotes at their source locations.
    for (const match of body.slice(start, end).matchAll(/\n[\t >]*/g)) {
      const from = start + match.index;
      if (!spans.some(span => span.start <= from && span.end > from))
        protect(from, from + match[0].length);
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    let cursor = start;
    let text = "";
    let prose = "";
    const protectedValues = [];
    for (const span of spans) {
      if (span.start < cursor) continue;
      const value = body.slice(cursor, span.start);
      prose += value;
      const token = `__KEEP_${salt}_${tokenIndex++}__`;
      text += value + token;
      protectedValues.push({
        token,
        value: body.slice(span.start, span.end),
        pair: span.pair,
        side: span.side,
      });
      cursor = span.end;
    }
    prose += body.slice(cursor, end);
    text += body.slice(cursor, end);
    if (/[\p{L}\p{N}]/u.test(prose))
      segments.push({ start, end, text, protected: protectedValues });
  }

  function visit(node) {
    if (["paragraph", "heading", "tableCell"].includes(node.type)) {
      segment(node);
    } else if (node.type === "html") {
      diagnostics.push({
        code: "protected-html-block",
        message: `Keep raw HTML block at offset ${node.position.start.offset}; review its visible text manually`,
      });
    } else if (node.children) {
      node.children.forEach(visit);
    }
    if (node.type === "definition" && node.url.startsWith("#")) {
      diagnostics.push({
        code: "review-heading-anchor",
        message: `Review anchor ${node.url} after translating headings`,
      });
    }
  }
  visit(tree);
  return { body, segments, diagnostics };
}

/**
 * Restore protected fragments and reject changed Markdown structure.
 * @param {ReturnType<typeof prepareMarkdown>} plan Original body and segment positions.
 * @param {readonly string[]} translations Model results in segment order.
 * @returns {string} Translated Markdown retaining unedited source ranges.
 * @throws {Error} When results, placeholders, pairing, or Markdown structure are invalid.
 */
export function restoreMarkdown(plan, translations) {
  if (translations.length !== plan.segments.length)
    throw new Error("Markdown segment count mismatch");
  let body = plan.body;
  for (let index = plan.segments.length - 1; index >= 0; index--) {
    const segment = plan.segments[index];
    const output = translations[index];
    if (
      typeof output !== "string" ||
      !output.trim() ||
      /[\r\n\u0000]/.test(output)
    )
      throw new Error(`Invalid Markdown result for segment ${index}`);
    const expected = new Map(segment.protected.map(item => [item.token, item]));
    const found = output.match(placeholderPattern) ?? [];
    if (
      found.length !== expected.size ||
      new Set(found).size !== expected.size ||
      found.some(token => !expected.has(token))
    )
      throw new Error(`Invalid placeholders in Markdown segment ${index}`);
    if (!/[\p{L}\p{N}]/u.test(output.replace(placeholderPattern, ""))) {
      throw new Error(`Missing translated text in Markdown segment ${index}`);
    }
    const stack = [];
    for (const token of found) {
      const item = expected.get(token);
      if (item.side === "open") stack.push(item.pair);
      if (item.side === "close" && stack.pop() !== item.pair)
        throw new Error(`Invalid syntax pairing in Markdown segment ${index}`);
    }
    if (stack.length)
      throw new Error(`Unclosed syntax in Markdown segment ${index}`);
    const restored = output.replace(
      placeholderPattern,
      token => expected.get(token).value
    );
    body = body.slice(0, segment.start) + restored + body.slice(segment.end);
  }
  if (
    JSON.stringify(structure(fromMarkdown(body, parserOptions))) !==
    JSON.stringify(structure(fromMarkdown(plan.body, parserOptions)))
  ) {
    throw new Error(
      "Translated Markdown changed the source structure or protected values"
    );
  }
  return body;
}
