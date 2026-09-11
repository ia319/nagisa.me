import {
  inlineContainers,
  markdownEntries,
  parseMarkdown,
} from "./markdown-syntax.mjs";
import { placeholderPattern, resolveBlockSeparators } from "./markdown.mjs";
import { resolveMarkdownAnchors } from "./markdown-anchors.mjs";

/** @typedef {import("./markdown-syntax.mjs").Point} Point */
/** @typedef {import("./markdown-syntax.mjs").Diagnostic} Diagnostic */

const reviewContainers = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "code",
  "html",
  "definition",
  "footnoteDefinition",
  "listItem",
  "thematicBreak",
]);

/**
 * Assign related inline findings to the nearest reviewable block.
 * @param {ReturnType<typeof markdownEntries>} nodes Source-ordered tree entries.
 * @returns {Map<import("mdast").Nodes, import("mdast").Nodes>} Review owner for each node.
 */
function reviewOwners(nodes) {
  const owners = new Map();
  for (const { node, parent } of nodes) {
    const ownsReview =
      reviewContainers.has(node.type) &&
      !(node.type === "html" && inlineContainers.has(parent?.type));
    owners.set(node, ownsReview ? node : (owners.get(parent) ?? node));
  }
  return owners;
}

function properties(node) {
  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "position" ||
      key === "children" ||
      key === "data" ||
      (node.type === "text" && key === "value") ||
      (["image", "imageReference"].includes(node.type) && key === "alt")
    )
      continue;
    result[key] = value;
  }
  if (["image", "imageReference"].includes(node.type))
    result.prose = /[\p{L}\p{N}]/u.test(node.alt);
  if (node.children) {
    result.prose = node.children.some(
      child => child.type === "text" && /[\p{L}\p{N}]/u.test(child.value)
    );
    // Inline phrases can move, but their HTML tag order must remain intact.
    if (inlineContainers.has(node.type))
      result.html = node.children
        .filter(child => child.type === "html")
        .map(child => child.value);
  }
  return result;
}

function structure(node) {
  const result = properties(node);
  if (node.children) {
    result.children = node.children
      .filter(child => child.type !== "text")
      .map(structure);
    if (inlineContainers.has(node.type))
      result.children.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right), "en")
      );
  }
  return result;
}

function pointAt(text, offset) {
  const prefix = text.slice(0, offset);
  return {
    line: prefix.split("\n").length,
    column: offset - prefix.lastIndexOf("\n"),
    offset,
  };
}

function excerpt(body, node) {
  if (!node) return "<missing>";
  const value = body.slice(
    node.position.start.offset,
    node.position.end.offset
  );
  return (
    JSON.stringify(value.slice(0, 180)) + (value.length > 180 ? "..." : "")
  );
}

/**
 * Inspect saved Markdown and group related failures by their actual source/saved locations.
 * @param {ReturnType<typeof import("./markdown.mjs").prepareMarkdown>} plan Original Markdown and protected ranges.
 * @param {string} translation Model response before restoration.
 * @param {string} body Body read from the saved draft.
 * @returns {{code: string, details: Diagnostic[], original: string, saved: string, source?: Point, target?: Point}[]} Structured non-blocking groups with review excerpts and exact finding positions relative to the body.
 */
export function validateMarkdown(plan, translation, body) {
  const targetTree = parseMarkdown(body).tree;
  const expectedTree = structuredClone(plan.tree);
  const policy = resolveMarkdownAnchors(plan, targetTree);
  for (const { node } of markdownEntries(expectedTree))
    if (["link", "definition"].includes(node.type) && policy.urls.has(node.url))
      node.url = policy.urls.get(node.url);
  const sourceEntries = markdownEntries(expectedTree);
  const targetEntries = markdownEntries(targetTree);
  const sourceOwners = reviewOwners(sourceEntries);
  const targetOwners = reviewOwners(targetEntries);
  const sourcePartners = new Map();
  const targetPartners = new Map();
  const groups = [];
  const sourceGroups = new Map();
  const targetGroups = new Map();
  function add(
    code,
    message,
    sourceNode,
    targetNode,
    source = sourceNode?.position.start,
    target = targetNode?.position.start
  ) {
    let sourceOwner = sourceOwners.get(sourceNode) ?? sourceNode;
    let targetOwner = targetOwners.get(targetNode) ?? targetNode;
    sourceOwner ??= targetPartners.get(targetOwner);
    targetOwner ??= sourcePartners.get(sourceOwner);
    const sourceOffset = sourceOwner?.position.start.offset;
    const targetOffset = targetOwner?.position.start.offset;
    let group =
      sourceGroups.get(sourceOffset) ?? targetGroups.get(targetOffset);
    if (!group) {
      group = { sourceNode: sourceOwner, targetNode: targetOwner, details: [] };
      groups.push(group);
    }
    group.sourceNode ??= sourceOwner;
    group.targetNode ??= targetOwner;
    if (sourceOffset !== undefined) sourceGroups.set(sourceOffset, group);
    if (targetOffset !== undefined) targetGroups.set(targetOffset, group);
    if (
      !group.details.some(
        item =>
          item.code === code &&
          item.message === message &&
          item.source?.offset === source?.offset &&
          item.target?.offset === target?.offset
      )
    )
      group.details.push({ code, message, source, target });
  }
  function compare(source, target) {
    if (!source || !target) {
      add(
        "markdown-node",
        "Expected " +
          (source?.type ?? "no node") +
          ", received " +
          (target?.type ?? "no node"),
        source,
        target
      );
      return;
    }
    if (source.type !== target.type) {
      add(
        "markdown-node",
        "Expected " + source.type + ", received " + target.type,
        source,
        target
      );
      return;
    }
    sourcePartners.set(source, target);
    targetPartners.set(target, source);
    const left = properties(source);
    const right = properties(target);
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key]))
        add(
          "markdown-value",
          source.type +
            "." +
            key +
            ": expected " +
            JSON.stringify(left[key]) +
            ", received " +
            JSON.stringify(right[key]),
          source,
          target
        );
    }
    const sourceChildren =
      source.children?.filter(child => child.type !== "text") ?? [];
    const targetChildren =
      target.children?.filter(child => child.type !== "text") ?? [];
    if (inlineContainers.has(source.type)) {
      const remaining = [...targetChildren];
      for (const child of sourceChildren) {
        const key = JSON.stringify(structure(child));
        let index = remaining.findIndex(
          item => JSON.stringify(structure(item)) === key
        );
        if (index < 0)
          index = remaining.findIndex(item => item.type === child.type);
        compare(child, index < 0 ? undefined : remaining.splice(index, 1)[0]);
      }
      for (const child of remaining) compare(undefined, child);
    } else {
      let leftIndex = 0;
      let rightIndex = 0;
      while (
        leftIndex < sourceChildren.length ||
        rightIndex < targetChildren.length
      ) {
        const leftChild = sourceChildren[leftIndex];
        const rightChild = targetChildren[rightIndex];
        if (leftChild && rightChild && leftChild.type !== rightChild.type) {
          if (sourceChildren[leftIndex + 1]?.type === rightChild.type) {
            compare(leftChild, undefined);
            leftIndex++;
            continue;
          }
          if (targetChildren[rightIndex + 1]?.type === leftChild.type) {
            compare(undefined, rightChild);
            rightIndex++;
            continue;
          }
        }
        compare(leftChild, rightChild);
        leftIndex++;
        rightIndex++;
      }
    }
  }
  compare(expectedTree, targetTree);
  for (const { separator, reason } of resolveBlockSeparators(plan, translation)
    .unresolved) {
    const node = sourceEntries.findLast(
      entry =>
        entry.node.position.start.offset <= separator.before.start &&
        entry.node.position.end.offset >= separator.before.end
    )?.node;
    add(
      "block-separator-unresolved",
      "Kept the separator between " +
        separator.before.token +
        " and " +
        separator.after.token +
        " unchanged: " +
        reason,
      node,
      undefined,
      pointAt(plan.body, separator.before.end)
    );
  }
  for (const diagnostic of policy.diagnostics) {
    const node = sourceEntries.findLast(
      entry => entry.node.position.start.offset === diagnostic.source.offset
    )?.node;
    add(diagnostic.code, diagnostic.message, node);
  }
  const found = [...translation.matchAll(placeholderPattern)];
  const expected = new Set(plan.protected.map(item => item.token));
  for (const item of plan.protected) {
    const count = found.filter(match => match[0] === item.token).length;
    if (count === 1) continue;
    const node = sourceEntries.find(
      entry =>
        entry.node.position.start.offset <= item.start &&
        entry.node.position.end.offset >= item.end &&
        entry.node.type !== "root" &&
        !entry.node.children?.some(
          child =>
            child.position.start.offset <= item.start &&
            child.position.end.offset >= item.end
        )
    )?.node;
    add(
      count ? "placeholder-duplicate" : "placeholder-missing",
      item.token +
        " (" +
        item.kind +
        "): expected once, received " +
        count +
        "; original " +
        JSON.stringify(item.value.slice(0, 180)),
      node ?? {
        position: {
          start: pointAt(plan.body, item.start),
          end: pointAt(plan.body, item.end),
        },
      },
      undefined,
      pointAt(plan.body, item.start)
    );
  }
  const unknownTokens = new Set(
    found.map(match => match[0]).filter(token => !expected.has(token))
  );
  const originalTokens = new Map();
  for (const match of plan.body.matchAll(placeholderPattern))
    originalTokens.set(match[0], (originalTokens.get(match[0]) ?? 0) + 1);
  const savedTokens = new Map([...unknownTokens].map(token => [token, []]));
  for (const match of body.matchAll(placeholderPattern)) {
    const allowed = originalTokens.get(match[0]) ?? 0;
    if (allowed && !unknownTokens.has(match[0])) {
      originalTokens.set(match[0], allowed - 1);
      continue;
    }
    if (!savedTokens.has(match[0])) savedTokens.set(match[0], []);
    savedTokens.get(match[0]).push(match);
  }
  for (const [token, saved] of savedTokens) {
    if (!saved.length)
      add(
        "placeholder-unknown",
        "Unexpected " +
          token +
          " was not sent; it occurs in the model response but not in the saved body"
      );
    for (const match of saved) {
      const node = targetEntries.findLast(
        entry =>
          entry.node.position.start.offset <= match.index &&
          entry.node.position.end.offset >= match.index + token.length
      )?.node;
      add(
        expected.has(token) ? "placeholder-unrestored" : "placeholder-unknown",
        expected.has(token)
          ? token + " remains in the saved body after restoration"
          : "Unexpected " + token + " was not sent and remains visible",
        undefined,
        node,
        undefined,
        pointAt(body, match.index)
      );
    }
  }
  for (const match of body.matchAll(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
  )) {
    const node = targetEntries.findLast(
      entry =>
        entry.node.position.start.offset <= match.index &&
        entry.node.position.end.offset > match.index
    )?.node;
    add(
      "control-character",
      "Unexpected U+" +
        match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"),
      undefined,
      node,
      undefined,
      pointAt(body, match.index)
    );
  }
  return groups.map(group => {
    group.details.sort(
      (left, right) =>
        Number(!left.code.startsWith("placeholder-")) -
        Number(!right.code.startsWith("placeholder-"))
    );
    return {
      code: group.details[0].code,
      details: group.details,
      original: excerpt(plan.body, group.sourceNode),
      saved: excerpt(body, group.targetNode),
      source: group.sourceNode?.position.start,
      target: group.targetNode?.position.start,
    };
  });
}
