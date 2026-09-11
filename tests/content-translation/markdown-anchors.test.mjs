import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import remarkToc from "remark-toc";
import remarkCollapse from "remark-collapse";
import {
  prepareMarkdown,
  restoreMarkdown,
} from "../../scripts/content-translation/markdown.mjs";
import { validateMarkdown } from "../../scripts/content-translation/markdown-validation.mjs";
import { updateMarkdownAnchors } from "../../scripts/content-translation/markdown-anchors.mjs";

test("matches heading fragments to actual Astro output including duplicate and complex headings", async () => {
  const require = createRequire(import.meta.url);
  const astroRequire = createRequire(require.resolve("astro/package.json"));
  const { createMarkdownProcessor } = await import(
    pathToFileURL(astroRequire.resolve("@astrojs/markdown-remark")).href
  );
  const processor = await createMarkdownProcessor({
    syntaxHighlight: false,
    remarkPlugins: [remarkToc, [remarkCollapse, { test: "Table of contents" }]],
  });
  const originalHeadings = [
    "## Installation",
    "## Installation",
    "## Français **gras** `a+b` &amp; <em>mot</em> --",
    "### 中文😀 {texte}",
  ];
  const translatedHeadings = [
    "## Setup",
    "## Setup",
    "## English **bold** `a+b` &amp; <em>word</em> --",
    "### 日本語😀 {text}",
  ];
  const sourceRendered = await processor.render(originalHeadings.join("\n\n"));
  const translatedRendered = await processor.render(
    translatedHeadings.join("\n\n")
  );
  const originalIds = sourceRendered.metadata.headings.map(
    heading => heading.slug
  );
  const translatedIds = translatedRendered.metadata.headings.map(
    heading => heading.slug
  );
  assert.equal(translatedIds[1], "setup-1");
  const links = originalIds
    .map(
      (id, index) =>
        `[Link ${index}](#${index === 3 ? encodeURIComponent(id) : id})`
    )
    .join("\n\n");
  const body =
    originalHeadings.join("\n\n") +
    "\n\n" +
    links +
    "\n\n[Reference][ref]\n\n[ref]: #" +
    originalIds[1] +
    "\n";
  const plan = prepareMarkdown(body);
  const response = plan.text
    .replaceAll("Installation", "Setup")
    .replace("Français", "English")
    .replace("gras", "bold")
    .replace("mot", "word")
    .replace("中文", "日本語")
    .replace("texte", "text");
  const result = updateMarkdownAnchors(plan, restoreMarkdown(plan, response));
  assert.deepEqual(result.diagnostics, []);
  for (const [index, id] of translatedIds.entries())
    assert.ok(
      result.body.includes(
        `[Link ${index}](#${index === 3 ? encodeURIComponent(id) : id})`
      ),
      id
    );
  assert.ok(result.body.includes("[ref]: #setup-1"));
  assert.deepEqual(validateMarkdown(plan, response, result.body), []);
  assert.ok(
    validateMarkdown(plan, response, restoreMarkdown(plan, response)).some(
      group => group.details.some(item => item.message.includes("link.url"))
    )
  );
});

test("keeps fixed IDs and external fragments and refuses ambiguous heading mappings", () => {
  const body =
    '## Installation\n\n<div id="fixed"></div>\n\n[Heading](#installation) [Fixed](#fixed) [External](https://example.com/#installation) [Page](./a.md#installation).\n';
  const plan = prepareMarkdown(body);
  const response = plan.text.replace("Installation", "Setup");
  const result = updateMarkdownAnchors(plan, restoreMarkdown(plan, response));
  assert.ok(result.body.includes("[Heading](#setup)"));
  for (const link of [
    "[Fixed](#fixed)",
    "https://example.com/#installation",
    "./a.md#installation",
  ])
    assert.ok(result.body.includes(link));
  assert.deepEqual(validateMarkdown(plan, response, result.body), []);
  for (const target of ["# Setup", "## Setup\n\n## Extra"]) {
    const changed = restoreMarkdown(
      plan,
      plan.text.replace("## Installation", target)
    );
    const unresolved = updateMarkdownAnchors(plan, changed);
    assert.ok(unresolved.body.includes("[Heading](#installation)"));
    assert.ok(
      unresolved.diagnostics.some(item => item.code === "anchor-unresolved")
    );
  }
  const conflict = prepareMarkdown(
    '## Installation\n\n<div id="setup"></div>\n\n[Heading](#installation).\n'
  );
  const ambiguous = updateMarkdownAnchors(
    conflict,
    restoreMarkdown(conflict, conflict.text.replace("Installation", "Setup"))
  );
  assert.ok(ambiguous.body.includes("[Heading](#installation)"));
  assert.ok(
    ambiguous.diagnostics.some(item => item.code === "anchor-ambiguous")
  );
  const invalid = prepareMarkdown("[Missing](#missing) and [Broken](#%XY).\n");
  assert.deepEqual(
    updateMarkdownAnchors(invalid, invalid.body).diagnostics.map(
      item => item.code
    ),
    ["anchor-unresolved", "anchor-invalid"]
  );
});

test("updates local heading anchors using the translated heading ID", () => {
  const body = "## Installation\n\nVoir [guide](#installation).\n";
  const plan = prepareMarkdown(body);
  const response = plan.text.replace("Installation", "Setup");
  const result = updateMarkdownAnchors(
    plan,
    restoreMarkdown(plan, response)
  ).body;
  assert.equal(
    result,
    body.replace("Installation", "Setup").replace("#installation", "#setup")
  );
  assert.deepEqual(validateMarkdown(plan, response, result), []);
});
