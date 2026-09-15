import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { markdownEntries, parseMarkdown } from "./markdown-syntax.mjs";

/** @typedef {import("./markdown-syntax.mjs").Diagnostic} Diagnostic */

// Resolve the compiler owned by Astro so heading IDs follow the installed site's rules.
const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve("astro/package.json"));
const markdownEntry = astroRequire.resolve("@astrojs/markdown-remark");
const markdownRequire = createRequire(markdownEntry);
const [
  { rehypeHeadingIds },
  { unified },
  { default: remarkRehype },
  { default: remarkSmartypants },
  { default: rehypeRaw },
] = await Promise.all([
  import(pathToFileURL(markdownEntry).href),
  import(pathToFileURL(markdownRequire.resolve("unified")).href),
  import(pathToFileURL(markdownRequire.resolve("remark-rehype")).href),
  import(pathToFileURL(markdownRequire.resolve("remark-smartypants")).href),
  import(pathToFileURL(markdownRequire.resolve("rehype-raw")).href),
]);
const headingProcessor = unified()
  .use(remarkSmartypants)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeHeadingIds)
  .use(rehypeRaw);

function headingState(tree) {
  const sourceHeadings = new Map(
    markdownEntries(tree)
      .filter(({ node }) => node.type === "heading")
      .map(entry => [entry.node.position.start.offset, entry])
  );
  const html = headingProcessor.runSync(structuredClone(tree));
  const headings = [];
  const fixedIds = new Set();
  const ids = new Map();
  function visit(node) {
    const id = node.properties?.id;
    if (typeof id === "string") {
      ids.set(id, (ids.get(id) ?? 0) + 1);
      const source = /^h[1-6]$/.test(node.tagName)
        ? sourceHeadings.get(node.position?.start.offset)
        : undefined;
      if (source) headings.push({ ...source, slug: id });
      else fixedIds.add(id);
    }
    node.children?.forEach(visit);
  }
  visit(html);
  return { headings, fixedIds, ids };
}

/**
 * Resolve local heading fragments only when their source and target identities are unambiguous.
 * @param {ReturnType<typeof import("./markdown.mjs").prepareMarkdown>} plan Original Markdown and protected values.
 * @param {import("mdast").Root} targetTree Restored or saved target syntax tree.
 * @returns {{urls: Map<string, string>, diagnostics: Diagnostic[]}} Allowed fragment replacements and unresolved-link findings.
 */
export function resolveMarkdownAnchors(plan, targetTree) {
  const links = markdownEntries(plan.tree).filter(
    ({ node }) =>
      ["link", "definition"].includes(node.type) &&
      node.url.startsWith("#") &&
      node.url !== "#"
  );
  if (!links.length) return { urls: new Map(), diagnostics: [] };
  const source = headingState(plan.tree);
  const target = headingState(targetTree);
  const aligned =
    source.headings.length === target.headings.length &&
    source.headings.every(
      (heading, index) =>
        heading.path === target.headings[index].path &&
        heading.node.depth === target.headings[index].node.depth
    );
  const urls = new Map();
  const diagnostics = [];
  for (const { node } of links) {
    let id;
    try {
      id = decodeURIComponent(node.url.slice(1));
    } catch {
      diagnostics.push({
        code: "anchor-invalid",
        source: node.position.start,
        message:
          "Invalid encoded source fragment " +
          JSON.stringify(node.url) +
          "; target was not changed",
      });
      continue;
    }
    if (!id) continue;
    if (source.fixedIds.has(id)) {
      if (!target.fixedIds.has(id))
        diagnostics.push({
          code: "anchor-missing-fixed-id",
          source: node.position.start,
          message:
            "Fixed anchor " +
            JSON.stringify(node.url) +
            " is missing from the saved body; target was not changed",
        });
      continue;
    }
    const index = source.headings.findIndex(heading => heading.slug === id);
    if (index < 0 || source.ids.get(id) !== 1 || !aligned) {
      diagnostics.push({
        code: "anchor-unresolved",
        source: node.position.start,
        message:
          "Cannot reliably match " +
          JSON.stringify(node.url) +
          " to a translated heading; target was not changed (" +
          (index < 0
            ? "no matching source heading or fixed ID"
            : source.ids.get(id) !== 1
              ? "duplicate source ID"
              : "heading structure changed") +
          ")",
      });
      continue;
    }
    const translated = target.headings[index].slug;
    if (target.ids.get(translated) !== 1 || target.fixedIds.has(translated)) {
      diagnostics.push({
        code: "anchor-ambiguous",
        source: node.position.start,
        message:
          "Translated heading ID " +
          JSON.stringify(translated) +
          " is not unique; " +
          JSON.stringify(node.url) +
          " was not changed",
      });
      continue;
    }
    urls.set(
      node.url,
      "#" +
        (/%[\da-f]{2}/i.test(node.url)
          ? encodeURIComponent(translated)
          : translated)
    );
  }
  return { urls, diagnostics };
}

/**
 * Update local heading fragments only when source and translated heading structure agree.
 * @param {ReturnType<typeof import("./markdown.mjs").prepareMarkdown>} plan Original Markdown and its syntax tree.
 * @param {string} body Restored draft body.
 * @returns {{body: string, diagnostics: Diagnostic[]}} Deterministic anchor updates and unresolved-link findings.
 */
export function updateMarkdownAnchors(plan, body) {
  try {
    const parsed = parseMarkdown(body);
    const { urls, diagnostics } = resolveMarkdownAnchors(plan, parsed.tree);
    const replacements = parsed.resources.filter(
      item =>
        item.kind === "url" &&
        urls.has(item.node.url) &&
        urls.get(item.node.url) !== item.node.url
    );
    for (const item of replacements.sort(
      (left, right) => right.start - left.start
    ))
      body =
        body.slice(0, item.start) +
        urls.get(item.node.url) +
        body.slice(item.end);
    return { body, diagnostics };
  } catch (error) {
    // Anchor analysis must not prevent saving a draft; validation runs again after publication.
    return {
      body,
      diagnostics: [
        {
          code: "anchor-processing",
          message: `Anchor analysis failed; fragments were kept: ${error.message}`,
        },
      ],
    };
  }
}
