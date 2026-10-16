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
const manifestFile = path.join(
  siteRoot,
  "src/generated/contentGitMetaManifest.json"
);
const sources = new Map([
  ["astro:content", contentSource],
  ["astro/components/viewtransitions.css", "export {};"],
  [
    "astro:env/client",
    "export const PUBLIC_GOOGLE_SITE_VERIFICATION = undefined;",
  ],
  [
    "astro:assets",
    `import {createComponent, render} from ${JSON.stringify(runtimeUrl)}; export const Font = createComponent(() => render\`\`);`,
  ],
  [
    "astro:transitions",
    `import {createComponent, render} from ${JSON.stringify(runtimeUrl)}; export const ClientRouter = createComponent(() => render\`\`);`,
  ],
  [path.join(siteRoot, "src/styles/global.css"), "export {};"],
  [
    manifestFile,
    "export const entries = {}; export default {version: 1, entries};",
  ],
]);
for (const file of ["components/Header.astro", "components/Footer.astro"])
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
const { default: RawTagDetail } = await import(
  await componentUrl(
    path.join(siteRoot, "src/pages/[locale]/tags/[tag]/[...page].astro")
  )
);
const { default: RawOverview } = await import(
  await componentUrl(path.join(siteRoot, "src/pages/[locale]/tags/index.astro"))
);
const { default: Main } = await import(
  await componentUrl(path.join(siteRoot, "src/layouts/Main.astro"))
);
const { rendered } = await import(moduleUrl("astro:content"));
const { entries: gitEntries } = await import(moduleUrl(manifestFile));
const { SITE } = await import(moduleUrl(path.join(siteRoot, "src/config.ts")));
const { default: RawLayout } = await import(
  await componentUrl(path.join(siteRoot, "src/layouts/Layout.astro"))
);
const { createComponent } = await import(runtimeUrl);
// Astro 5.16's container omits the configured site from its render context.
function withSite(component) {
  return createComponent((result, props, slots) => {
    const createAstro = result.createAstro;
    result.createAstro = (...args) => {
      const astro = createAstro(...args);
      astro.site = new URL(SITE.website);
      return astro;
    };
    return component(result, props, slots);
  });
}
const TagDetail = withSite(RawTagDetail);
const Overview = withSite(RawOverview);
const Layout = withSite(RawLayout);
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
    assert.match(html, /<p class="mt-2 mb-6"[^>]*>/);
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

test("shows Git metadata only for published custom introductions on the first page", async t => {
  const enabled = SITE.contentGitMeta.enabled;
  t.after(() => {
    SITE.contentGitMeta.enabled = enabled;
  });
  SITE.contentGitMeta.enabled = true;
  const cases = [
    { docs: [], expected: false },
    { docs: [entry("frontend")], expected: false },
    {
      docs: [entry("frontend", { description: "  " }, "\n")],
      expected: false,
    },
    {
      docs: [entry("frontend", { draft: true, description: "Draft" }, "Body")],
      expected: false,
    },
    {
      docs: [entry("frontend.en", { description: "Other language" }, "Body")],
      expected: false,
    },
    { docs: [entry("frontend", { description: "Summary" })], expected: true },
    { docs: [entry("frontend", {}, "<p>Body only</p>")], expected: true },
  ];
  for (const { docs, expected } of cases) {
    const tag = getTagIndex([post("sample")], docs).tags[0];
    const html = await container.renderToString(TagDetail, detailOptions(tag));
    assert.equal(html.includes("首次提交于"), expected);
    if (expected) {
      assert.ok(html.includes("未知"));
      assert.ok(html.includes("data-pagefind-ignore"));
      assert.ok(html.indexOf("首次提交于") < html.indexOf("<hr"));
    }
    const pageTwo = await container.renderToString(
      TagDetail,
      detailOptions(tag, 2)
    );
    assert.ok(!pageTwo.includes("首次提交于"));
  }
  SITE.contentGitMeta.enabled = false;
  const tag = getTagIndex(
    [post("sample")],
    [entry("frontend", { description: "Summary" }, "<p>Body</p>")]
  ).tags[0];
  const html = await container.renderToString(TagDetail, detailOptions(tag));
  assert.ok(!html.includes("首次提交于") && !html.includes("<aside"));
});

test("retains article Git date, hash, link and partial-history rules for tags", async t => {
  const original = {
    enabled: SITE.contentGitMeta.enabled,
    timezone: SITE.timezone,
    repository: SITE.repository,
  };
  t.after(() => {
    SITE.contentGitMeta.enabled = original.enabled;
    SITE.timezone = original.timezone;
    SITE.repository = original.repository;
  });
  SITE.contentGitMeta.enabled = true;
  SITE.timezone = "Asia/Tokyo";
  const first = { hash: "a".repeat(40), isoDate: "2024-02-01T18:30:00Z" };
  const last = { hash: "b".repeat(64), isoDate: "2024-02-02T21:00:00Z" };
  const cases = [
    {
      name: "first",
      meta: { firstCommitted: first, lastCommitted: first },
      commits: [first],
    },
    {
      name: "edited",
      meta: { firstCommitted: first, lastCommitted: last },
      commits: [first, last],
      edited: true,
    },
    { name: "missing", meta: {}, commits: [], unknown: true },
    { name: "first-only", meta: { firstCommitted: first }, commits: [first] },
    {
      name: "last-only",
      meta: { lastCommitted: last, commitCount: 2 },
      commits: [last],
      unknown: true,
      edited: true,
    },
    {
      name: "single-last",
      meta: { lastCommitted: last, commitCount: 1 },
      commits: [],
      unknown: true,
    },
    {
      name: "plain-hash",
      meta: { firstCommitted: first, lastCommitted: last },
      commits: [first, last],
      edited: true,
      unlinked: true,
    },
  ];
  for (const item of cases) {
    const id = "git-" + item.name;
    gitEntries[`src/data/tags/${id}.md`] = item.meta;
    SITE.repository = item.unlinked ? "" : "https://github.com/example/blog";
    const tag = getTagIndex(
      [post("sample", [id])],
      [entry(id, { description: "Summary" })]
    ).tags[0];
    const html = await container.renderToString(TagDetail, detailOptions(tag));
    const meta = html.match(/<aside\b[\s\S]*?<\/aside>/)?.[0];
    assert.ok(meta, item.name);
    assert.equal(meta.includes("编辑于"), Boolean(item.edited), item.name);
    assert.equal(meta.includes("未知"), Boolean(item.unknown), item.name);
    assert.equal((meta.match(/<time\b/g) || []).length, item.commits.length);
    for (const commit of item.commits) {
      assert.ok(meta.includes(`datetime="${commit.isoDate}"`));
      assert.ok(
        meta.includes(
          commit === first ? "2024-02-02 03:30" : "2024-02-03 06:00"
        )
      );
      assert.ok(meta.includes(`title="提交 ${commit.hash}"`));
      assert.match(
        meta,
        new RegExp(">\\s*" + commit.hash.slice(0, 7) + "\\s*<")
      );
      if (!item.unlinked)
        assert.ok(
          meta.includes(
            `href="https://github.com/example/blog/commit/${commit.hash}"`
          )
        );
    }
    if (item.unlinked) assert.ok(!meta.includes("<a "));
  }
});

test("uses the current language tag file history independently of related articles", async t => {
  const enabled = SITE.contentGitMeta.enabled;
  t.after(() => {
    SITE.contentGitMeta.enabled = enabled;
  });
  SITE.contentGitMeta.enabled = true;
  const id = "git-localized";
  const docs = [
    entry(id, { description: "中文介绍" }),
    entry(id + ".en", { description: "English introduction" }),
  ];
  const hashes = { zh: "c".repeat(40), en: "d".repeat(40) };
  for (const locale of ["zh", "en"])
    gitEntries[`src/data/tags/${id}${locale === "en" ? ".en" : ""}.md`] = {
      firstCommitted: { hash: hashes[locale], isoDate: "2024-01-01T00:00:00Z" },
    };
  const posts = [post("sample", [id]), post("sample.en", [id])];
  const before = new Map();
  for (const tag of getTagIndex(posts, docs).tags) {
    const html = await container.renderToString(TagDetail, detailOptions(tag));
    const meta = html.match(/<aside\b[\s\S]*?<\/aside>/)?.[0];
    assert.ok(meta.includes(hashes[tag.locale]));
    assert.ok(!meta.includes(hashes[tag.locale === "en" ? "zh" : "en"]));
    assert.ok(
      meta.includes(tag.locale === "en" ? "First committed" : "首次提交于")
    );
    before.set(tag.locale, meta);
  }
  posts.push(post("another", [id]), post("another.en", [id]));
  for (const tag of getTagIndex(posts, docs).tags) {
    assert.equal(tag.count, 2);
    const html = await container.renderToString(TagDetail, detailOptions(tag));
    assert.equal(
      html.match(/<aside\b[\s\S]*?<\/aside>/)?.[0],
      before.get(tag.locale)
    );
  }
});

test("indexes only custom introductions and excludes navigation, metadata and article cards", async t => {
  const enabled = SITE.contentGitMeta.enabled;
  t.after(() => {
    SITE.contentGitMeta.enabled = enabled;
  });
  SITE.contentGitMeta.enabled = true;
  const cases = [
    { docs: [], blocks: [] },
    { docs: [entry("frontend")], blocks: [] },
    { docs: [entry("frontend", { description: "  " }, "\n")], blocks: [] },
    {
      docs: [entry("frontend", { draft: true, description: "Hidden" }, "Body")],
      blocks: [],
    },
    {
      docs: [entry("frontend.en", { description: "Other language" }, "Body")],
      blocks: [],
    },
    {
      docs: [entry("frontend", { description: "Custom summary" })],
      blocks: ["h1", "p"],
    },
    {
      docs: [entry("frontend", {}, "<p>Unique introduction</p>")],
      blocks: ["h1", "div"],
    },
    {
      docs: [
        entry(
          "frontend",
          { description: "Custom summary" },
          "<p>Unique introduction</p>"
        ),
      ],
      blocks: ["h1", "p", "div"],
    },
  ];
  for (const { docs, blocks } of cases) {
    const tag = getTagIndex([post("sample")], docs).tags[0];
    const html = await container.renderToString(TagDetail, detailOptions(tag));
    const indexed = [
      ...html.matchAll(
        /<(h1|p|div)\b[^>]*data-pagefind-body(?:="[^"]*")?[^>]*>([\s\S]*?)<\/\1>/g
      ),
    ];
    assert.deepEqual(
      indexed.map(match => match[1]),
      blocks
    );
    assert.equal(
      (html.match(/data-pagefind-body/g) || []).length,
      blocks.length
    );
    const content = indexed.map(match => match[2]).join(" ");
    assert.equal(content.includes("Custom summary"), blocks.includes("p"));
    assert.equal(
      content.includes("Unique introduction"),
      blocks.includes("div")
    );
    assert.equal(content.includes("Astro"), blocks.length > 0);
    assert.ok(!content.includes("所有带有标签"));
    for (const excluded of [
      "首次提交于",
      "相关文章",
      "查看文章",
      "Article sample",
      "Article summary",
      "2020",
    ])
      assert.ok(!content.includes(excluded), excluded);
    const pageTwo = await container.renderToString(
      TagDetail,
      detailOptions(tag, 2)
    );
    assert.ok(!pageTwo.includes("data-pagefind-body"));
  }
  const overview = await container.renderToString(Overview, {
    props: {
      locale: "zh",
      tags: getTagIndex(
        [post("sample")],
        [entry("frontend", { description: "Custom summary" })]
      ).tags,
    },
    request: new Request("https://example.com/zh/tags"),
  });
  assert.ok(!overview.includes("data-pagefind-body"));
  const main = await container.renderToString(Main, {
    props: { locale: "en", pageTitle: "Posts", pageDesc: "All posts" },
    request: new Request("https://example.com/en/posts"),
  });
  assert.ok(!main.includes("data-pagefind-body"));
});

test("publishes localized collection metadata and canonical URLs on every tag page", async () => {
  const cases = [
    { postId: "sample", docs: [], summary: "所有带有标签 “frontend” 的文章。" },
    {
      postId: "sample",
      docs: [entry("frontend")],
      summary: "所有带有标签 “Astro” 的文章。",
    },
    {
      postId: "sample",
      docs: [entry("frontend", { description: "中文说明" })],
      summary: "中文说明",
    },
    {
      postId: "sample.en",
      docs: [
        entry("frontend", { description: "中文说明" }),
        entry("frontend.en", {
          name: "English tag",
          description: "English summary",
        }),
      ],
      summary: "English summary",
    },
    {
      postId: "sample.en",
      docs: [
        entry("frontend", { description: "中文说明" }),
        entry("frontend.en", { draft: true, description: "Draft summary" }),
      ],
      summary: 'All the articles with the tag "frontend".',
    },
    {
      postId: "sample.en",
      tagId: "主题",
      docs: [entry("主题.en", { name: "Topic", description: "Topic summary" })],
      summary: "Topic summary",
    },
  ];
  for (const { postId, tagId = "frontend", docs, summary } of cases) {
    const tag = getTagIndex([post(postId, [tagId])], docs).tags[0];
    for (const page of [1, 2]) {
      const html = await container.renderToString(
        TagDetail,
        detailOptions(tag, page)
      );
      const blocks = [
        ...html.matchAll(
          /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
        ),
      ];
      assert.equal(blocks.length, 1);
      const data = JSON.parse(blocks[0][1]);
      const canonical =
        "https://example.com/" +
        tag.locale +
        "/tags/" +
        encodeURIComponent(tagId) +
        (page > 1 ? "/" + page : "");
      assert.equal(data["@type"], "CollectionPage");
      assert.equal(
        data.name,
        (tag.locale === "zh" ? "标签： " : "Tag: ") +
          tag.tagName +
          " | " +
          SITE.title
      );
      assert.equal(data.description, summary);
      assert.equal(data.url, canonical);
      assert.ok(!("datePublished" in data) && !("dateModified" in data));
      assert.ok(!blocks[0][1].includes("undefined"));
      assert.ok(html.includes('rel="canonical" href="' + canonical + '"'));
      assert.ok(
        !html.includes('property="article:published_time"') &&
          !html.includes('property="article:modified_time"')
      );
      const descriptions = [
        ...html.matchAll(
          /<meta (?:name|property)="(description|og:description|twitter:description)" content="([^"]*)"/g
        ),
      ];
      assert.equal(descriptions.length, 3);
      for (const [, name, value] of descriptions)
        assert.equal(
          value.replace(/&#34;|&quot;/g, '"').replaceAll("&amp;", "&"),
          summary,
          name
        );
    }
  }
});

test("retains article structured data and omits unavailable dates", async () => {
  const published = new Date("2024-01-01T00:00:00Z");
  const edited = new Date("2024-02-01T00:00:00Z");
  const cases = [
    { pubDatetime: published, modDatetime: edited },
    { pubDatetime: published },
    { pubDatetime: published, modDatetime: null },
    {},
  ];
  for (const dates of cases) {
    const html = await container.renderToString(Layout, {
      props: {
        locale: "en",
        title: "Article",
        ...dates,
        canonicalURL: "https://example.net/original-article",
      },
      request: new Request("https://example.com/en/posts/sample"),
    });
    const data = JSON.parse(
      html.match(
        /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/
      )[1]
    );
    assert.equal(data["@type"], "BlogPosting");
    assert.equal(data.headline, "Article");
    assert.equal(data.author[0].name, SITE.author);
    assert.equal("datePublished" in data, Boolean(dates.pubDatetime));
    assert.equal("dateModified" in data, Boolean(dates.modDatetime));
    if (dates.pubDatetime)
      assert.equal(data.datePublished, published.toISOString());
    if (dates.modDatetime)
      assert.equal(data.dateModified, edited.toISOString());
    assert.equal(
      html.includes('property="article:published_time"'),
      Boolean(dates.pubDatetime)
    );
    assert.equal(
      html.includes('property="article:modified_time"'),
      Boolean(dates.modDatetime)
    );
    assert.ok(
      html.includes(
        'rel="canonical" href="https://example.net/original-article"'
      )
    );
    assert.ok(!html.includes('"undefined"'));
  }
  const collection = await container.renderToString(Layout, {
    props: {
      locale: "en",
      structuredDataType: "CollectionPage",
      pubDatetime: published,
      modDatetime: edited,
    },
    request: new Request("https://example.com/en/tags/example"),
  });
  assert.ok(
    !collection.includes("datePublished") &&
      !collection.includes("dateModified")
  );
  assert.ok(
    !collection.includes("article:published_time") &&
      !collection.includes("article:modified_time")
  );
});

test("preserves content text without letting it close the JSON-LD script", async () => {
  const title = "Example </script><script>unexpected()</script>";
  const description = 'A <tag> & "quoted" description';
  const html = await container.renderToString(Layout, {
    props: {
      locale: "en",
      structuredDataType: "CollectionPage",
      title,
      description,
    },
    request: new Request("https://example.com/en/tags/example"),
  });
  const blocks = [
    ...html.matchAll(
      /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
    ),
  ];
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0][1].includes("\\u003c/script>"));
  const data = JSON.parse(blocks[0][1]);
  assert.equal(data.name, title);
  assert.equal(data.description, description);
  assert.ok(!blocks[0][1].includes("<"));
});
