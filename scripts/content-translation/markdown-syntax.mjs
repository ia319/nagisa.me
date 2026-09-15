import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export const inlineContainers = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
]);

/** @typedef {{line: number, column: number, offset?: number}} Point */
/** @typedef {{code: string, message: string, source?: Point, target?: Point}} Diagnostic */

/**
 * Parse Markdown and retain exact resource ranges for local restoration.
 * @param {string} text LF-normalized Markdown source.
 * @returns {{tree: import("mdast").Root, resources: {start: number, end: number, kind: string, node: import("mdast").Nodes}[]}} Syntax tree and source ranges for destinations, titles, and reference labels.
 */
export function parseMarkdown(text) {
  const resources = [];
  const enter = {};
  for (const [type, kind] of [
    ["resourceDestinationString", "url"],
    ["definitionDestinationString", "url"],
    ["resourceTitleString", "link-title"],
    ["referenceString", "reference-label"],
  ]) {
    enter[type] = function (token) {
      resources.push({
        start: token.start.offset,
        end: token.end.offset,
        kind,
        node: this.stack.at(-1),
      });
      // These standard token handlers buffer their contents; retain that parser behavior.
      this.buffer();
    };
  }
  const tree = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown(), { enter }],
  });
  return { tree, resources };
}

/**
 * Traverse Markdown in source order while preserving parent and structural-path identity.
 * @param {import("mdast").Root} tree Parsed Markdown tree.
 * @returns {{node: import("mdast").Nodes, path: string, parent?: import("mdast").Nodes}[]} Preorder entries for syntax protection, heading alignment, and review grouping.
 */
export function markdownEntries(tree) {
  const result = [];
  function visit(node, path, parent) {
    result.push({ node, path, parent });
    node.children?.forEach((child, index) =>
      visit(child, path + ".children[" + index + "]", node)
    );
  }
  visit(tree, "body");
  return result;
}
