import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import registry from "../../locales.config.mjs";
import remarkTagHeadings from "../../src/content/tagHeadings.mjs";
import { createSiteModuleLoader, siteRoot } from "./site-modules.mjs";

const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve("astro/package.json"));
const { createMarkdownProcessor } = await import(
  pathToFileURL(astroRequire.resolve("@astrojs/markdown-remark")).href
);
const processor = await createMarkdownProcessor({
  syntaxHighlight: false,
  remarkPlugins: [remarkTagHeadings],
});
const runtimeUrl = pathToFileURL(
  require.resolve("astro/compiler-runtime")
).href;
const contentSource = `import {createComponent,render,unescapeHTML} from ${JSON.stringify(runtimeUrl)};
export const rendered = [];
export async function getCollection() { return []; }
export async function renderEntry(entry) {
  rendered.push(entry.filePath);
  return {Content:createComponent(() => render\`\${unescapeHTML(entry.body)}\`)};
}
export {renderEntry as render};`;
const sources = new Map([
  ["astro:content", contentSource],
  ["astro/components/viewtransitions.css", "export {};"],
]);
for (const file of [
  "layouts/Layout.astro",
  "components/Header.astro",
  "components/Footer.astro",
])
  sources.set(path.join(siteRoot, "src", file), "<slot />");
sources.set(
  path
    .join(siteRoot, "src/pages/[locale]/tags/[tag]/[...page].astro")
    .replaceAll("\\", "/") + "?astro&type=style&index=0&lang.css",
  "export {};"
);
const { moduleUrl, componentUrl } = await createSiteModuleLoader(
  registry,
  sources
);
const iconFile = path.join(
  siteRoot,
  "tests/localized-content/TagTestIcon.astro"
);
sources.set(iconFile, "<span aria-hidden='true'></span>");
const iconUrl = await componentUrl(iconFile);
for (const file of [
  "components/Datetime.astro",
  "components/Pagination.astro",
  "components/LinkButton.astro",
]) {
  for (const match of readFileSync(
    path.join(siteRoot, "src", file),
    "utf8"
  ).matchAll(/from "(@\/[^"\n]+\.svg)"/g))
    sources.set(
      path.join(siteRoot, "src", match[1].slice(2)),
      `export {default} from ${JSON.stringify(iconUrl)};`
    );
}
const { getTagIndex } = await import(
  moduleUrl(path.join(siteRoot, "src/utils/getTagIndex.ts"))
);
const { default: TagDetail } = await import(
  await componentUrl(
    path.join(siteRoot, "src/pages/[locale]/tags/[tag]/[...page].astro")
  )
);
const { default: Overview } = await import(
  await componentUrl(path.join(siteRoot, "src/pages/[locale]/tags/index.astro"))
);
const { default: Main } = await import(
  await componentUrl(path.join(siteRoot, "src/layouts/Main.astro"))
);
const { rendered } = await import(moduleUrl("astro:content"));
const container = await AstroContainer.create();

const post = (id, tags = ["frontend"]) => ({
  id,
  filePath: path.join(siteRoot, "src/data/blog", id + ".md"),
  data: {
    title: "Article " + id,
    description: "Article summary",
    tags,
    pubDatetime: new Date("2020-01-01"),
  },
});
const entry = (id, data = {}, body = "") => ({
  id,
  collection: "tags",
  filePath: path.join(siteRoot, "src/data/tags", id + ".md"),
  data: { name: "Astro", ...data },
  body,
});
function detailOptions(tag, currentPage = 1, total = 1) {
  return {
    request: new Request(
      "https://example.com/" +
        tag.locale +
        "/tags/" +
        tag.tag +
        (currentPage > 1 ? "/" + currentPage : "")
    ),
    params: { locale: tag.locale, tag: tag.tag },
    props: {
      ...tag,
      languageLinks: {},
      page: {
        currentPage,
        lastPage: currentPage,
        total,
        data: [post("sample")],
        url: {
          current: "/" + tag.locale + "/tags/" + tag.tag,
          prev:
            currentPage > 1 ? "/" + tag.locale + "/tags/" + tag.tag : undefined,
          next: undefined,
        },
      },
    },
  };
}

test("normalizes h1 headings only for tag Markdown and retains heading anchors", async () => {
  const markdown =
    "# Introduction\n\n## Details\n\n[Details](#details)\n\n\`\`\`md\n# Code stays literal\n\`\`\`\n";
  const tag = await processor.render(markdown, {
    fileURL: pathToFileURL(path.join(siteRoot, "src/data/tags/frontend.md")),
  });
  assert.ok(!tag.code.includes("<h1"));
  assert.match(tag.code, /<h2 id="introduction">/);
  assert.match(tag.code, /<h3 id="details">/);
  assert.match(tag.code, /href="#details"/);
  const article = await processor.render(markdown, {
    fileURL: pathToFileURL(path.join(siteRoot, "src/data/blog/guide.md")),
  });
  assert.match(article.code, /<h1 id="introduction">/);
  const withoutH1 = await processor.render("## Topic", {
    fileURL: pathToFileURL(path.join(siteRoot, "src/data/tags/frontend.md")),
  });
  assert.match(withoutH1.code, /<h2 id="topic">/);
});

test("renders missing, draft, name-only and description-only metadata with localized fallback", async () => {
  const cases = [
    { docs: [], name: "frontend", summary: "所有带有标签" },
    {
      docs: [entry("frontend", { draft: true, description: "Hidden" })],
      name: "frontend",
      summary: "所有带有标签",
    },
    {
      docs: [entry("frontend.en", { description: "English only" })],
      name: "frontend",
      summary: "所有带有标签",
    },
    { docs: [entry("frontend")], name: "Astro", summary: "所有带有标签" },
    {
      docs: [entry("frontend", { description: "Custom summary" })],
      name: "Astro",
      summary: "Custom summary",
    },
  ];
  for (const item of cases) {
    const tag = getTagIndex([post("sample")], item.docs).tags[0];
    const count = rendered.length;
    const html = await container.renderToString(TagDetail, detailOptions(tag));
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, new RegExp(item.summary));
    assert.match(
      html,
      new RegExp('aria-current="page"[^>]*>\\s*' + item.name + "\\s*<")
    );
    assert.ok(!html.includes("Hidden") && !html.includes("English only"));
    assert.ok(!html.includes("查看文章"));
    assert.equal(rendered.length, count);
    assert.match(html, /<p class="mt-2 mb-6">/);
    assert.match(html, /<h3\b[^>]*>\s*Article sample\s*<\/h3>/);
  }
  const english = getTagIndex([post("sample.en")], [entry("frontend")]).tags[0];
  const html = await container.renderToString(
    TagDetail,
    detailOptions(english)
  );
  assert.ok(html.includes("All the articles with the tag"));
  assert.ok(!html.includes("所有带有标签"));
  assert.match(html, /1 article\s*</);
});

test("renders the selected tag Markdown once, with a jump link before the introduction", async () => {
  const markdown = await processor.render(
    "# Introduction\n\nRead the guide.\n\n## Details",
    { fileURL: pathToFileURL(path.join(siteRoot, "src/data/tags/frontend.md")) }
  );
  const tag = getTagIndex(
    [post("sample")],
    [entry("frontend", { description: "Start here" }, markdown.code)]
  ).tags[0];
  const before = rendered.length;
  const html = await container.renderToString(TagDetail, detailOptions(tag));
  assert.equal(rendered.length, before + 1);
  assert.equal(rendered.at(-1), tag.entry.filePath);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.ok(
    html.indexOf('href="#related-articles"') < html.indexOf("Read the guide.")
  );
  assert.ok(
    html.indexOf("Read the guide.") < html.indexOf('id="related-articles"')
  );
  assert.match(html, /aria-labelledby="related-articles-title"/);
  assert.ok(!/class="[^"]*lowercase[^"]*"[^>]*[^<]*Astro/.test(html));
});

test("keeps long introductions off subsequent pages and links back to the canonical introduction", async () => {
  const tag = getTagIndex(
    [post("sample")],
    [
      entry(
        "frontend",
        { description: "Summary" },
        "<p>" + "Long introduction. ".repeat(200) + "</p>"
      ),
    ]
  ).tags[0];
  const before = rendered.length;
  const html = await container.renderToString(
    TagDetail,
    detailOptions(tag, 2, 12)
  );
  assert.equal(rendered.length, before);
  assert.ok(!html.includes("Long introduction"));
  assert.match(html, /href="\/zh\/tags\/frontend#main-content"/);
  assert.ok(html.includes("返回标签介绍"));
  assert.ok(html.includes("第 2 页") && html.includes("12 篇文章"));
  assert.match(html, /href="\/zh\/tags\/frontend"[^>]*>\s*Astro\s*<\/a>/);
});

test("preserves alias pagination and encodes a canonical ID exactly once", async () => {
  const tag = { tag: "old", tagName: "Old", locale: "zh", count: 1 };
  const options = detailOptions(tag, 2);
  options.props.redirectTag = "主题";
  const response = await container.renderToResponse(TagDetail, options);
  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    "/zh/tags/" + encodeURIComponent("主题") + "/2"
  );
});

test("renders vertical overview rows with localized names, counts and summaries", async () => {
  const index = getTagIndex(
    [post("one"), post("two", ["frontend", "missing"])],
    [entry("frontend", { description: "Custom summary" })]
  );
  const html = await container.renderToString(Overview, {
    props: { locale: "zh", tags: index.tags },
    request: new Request("https://example.com/zh/tags"),
  });
  assert.match(html, /divide-y divide-border/);
  assert.ok(html.includes("Custom summary") && html.includes("2 篇文章"));
  assert.match(html, /href="\/zh\/tags\/frontend"[^>]*>\s*Astro\s*<\/a>/);
  assert.ok(html.includes("所有带有标签"));
  assert.match(html, /aria-current="page"[^>]*>\s*标签\s*<\/span>/);
  const empty = await container.renderToString(Overview, {
    props: { locale: "en", tags: [] },
    request: new Request("https://example.com/en/tags"),
  });
  assert.ok(empty.includes("All the tags used in posts."));
  assert.equal((empty.match(/<h1\b/g) || []).length, 1);
  assert.ok(!empty.includes("<h2"));
});

test("retains the default description style and post breadcrumb behavior on other pages", async () => {
  const html = await container.renderToString(Main, {
    props: { locale: "en", pageTitle: "Posts", pageDesc: "All posts" },
    request: new Request("https://example.com/en/posts/2"),
  });
  assert.match(html, /<p class="mt-2 mb-6 italic">\s*All posts\s*<\/p>/);
  assert.ok(html.includes("Posts (page 2)"));
});
