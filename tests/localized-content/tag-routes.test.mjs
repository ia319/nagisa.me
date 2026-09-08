import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createSiteModuleLoader, siteRoot as root } from "./site-modules.mjs";

const registry = {
  defaultLocale: "fr",
  locales: {
    fr: { label: "Français", dir: "ltr" },
    en: { label: "English", dir: "ltr" },
    ar: { label: "العربية", dir: "rtl" },
    "pt-BR": { label: "Português", dir: "ltr" },
  },
};
const { moduleUrl, setPosts } = await createSiteModuleLoader(registry);

const { getTagIndex, getTagLanguageLinks } = await import(
  moduleUrl(path.join(root, "src/utils/getTagIndex.ts"))
);
const { default: getUniqueTags } = await import(
  moduleUrl(path.join(root, "src/utils/getUniqueTags.ts"))
);
const { default: getPostsByTag } = await import(
  moduleUrl(path.join(root, "src/utils/getPostsByTag.ts"))
);

function post(id, tags, sourceLocale, extra = {}) {
  return {
    id,
    filePath: path.join(root, "src/data/blog", `${id}.md`),
    data: {
      tags,
      title: id,
      pubDatetime: new Date("2020-01-01"),
      draft: false,
      ...(sourceLocale
        ? {
            translation: { sourceLocale, provider: "ollama", model: "example" },
          }
        : {}),
      ...extra,
    },
  };
}
const posts = [
  post("guide", ["Outils"]),
  post("guide.en", ["Tools"], "fr"),
  post("guide.ar", ["أدوات"], "en"),
];

test("public tag collections and detail data contain only the selected language", () => {
  const before = structuredClone(posts);
  const index = getTagIndex(posts);
  assert.deepEqual(getUniqueTags(posts, "fr"), [
    { tag: "outils", tagName: "Outils" },
  ]);
  assert.deepEqual(getUniqueTags(posts, "en"), [
    { tag: "tools", tagName: "Tools" },
  ]);
  assert.deepEqual(
    getPostsByTag(index.posts, "tools", "en").map(post => post.id),
    ["guide.en"]
  );
  assert.deepEqual(getPostsByTag(index.posts, "tools", "fr"), []);
  assert.deepEqual(getUniqueTags(posts, "pt-BR"), []);
  assert.deepEqual(posts, before);
});

test("switches to unique public translations and logs missing-language fallbacks", () => {
  const index = getTagIndex(posts);
  const current = index.tags.find(tag => tag.locale === "fr");
  const { links, diagnostics } = getTagLanguageLinks(index, current);
  assert.equal(links.fr, "/fr/tags/outils");
  assert.equal(links.en, "/en/tags/tools");
  assert.equal(
    links.ar,
    "/ar/tags/" +
      encodeURIComponent(index.tags.find(tag => tag.locale === "ar").tag)
  );
  assert.equal(links["pt-BR"], "/pt-BR/tags");
  assert.ok(
    diagnostics.some(message => message.includes("missing-translation"))
  );
});

test("excludes drafts and future posts from tag pages and cross-language references", () => {
  const hidden = [
    posts[0],
    post("guide.en", ["Tools"], "fr", { draft: true }),
    post("guide.ar", ["أدوات"], "fr", { pubDatetime: new Date("2999-01-01") }),
  ];
  const index = getTagIndex(hidden);
  assert.equal(index.posts.length, 1);
  assert.equal(index.tags.length, 1);
  const { links } = getTagLanguageLinks(index, index.tags[0]);
  assert.equal(links.en, "/en/tags");
  assert.equal(links.ar, "/ar/tags");
  assert.deepEqual(getPostsByTag(hidden, "tools", "en"), []);
});

test("keeps ambiguous mappings on collections but preserves the current tag link", () => {
  const index = getTagIndex([
    ...posts,
    post("second", ["Outils"]),
    post("second.en", ["Utilities"], "fr"),
  ]);
  const tag = index.tags.find(tag => tag.locale === "fr");
  const { links, diagnostics } = getTagLanguageLinks(index, tag);
  assert.equal(links.fr, "/fr/tags/outils");
  assert.equal(links.en, "/en/tags");
  assert.equal(links.ar, "/ar/tags");
  assert.ok(diagnostics.some(message => message.includes("ambiguous-mapping")));
});

test("refuses an unreachable mapped target and rejects duplicate public URLs", () => {
  const index = getTagIndex(posts);
  const current = index.tags.find(tag => tag.locale === "fr");
  index.tags = index.tags.filter(tag => tag.locale !== "en");
  const { links, diagnostics } = getTagLanguageLinks(index, current);
  assert.equal(links.en, "/en/tags");
  assert.ok(
    diagnostics.some(message => message.includes("unreachable-target"))
  );
  assert.throws(
    () => getTagIndex([post("a", ["Tools"]), post("b", ["tools"])]),
    /Tag route collision/
  );
  assert.doesNotThrow(() =>
    getTagIndex([post("a", ["Tools"]), post("b", ["Tools"])])
  );
  assert.throws(
    () => getTagIndex([post("a", ["A"]), post("a.fr", ["B"])]),
    /same base path and locale/
  );
});

const collectionPage = await import(
  moduleUrl(path.join(root, "src/pages/[locale]/tags/index.astro"))
);
const detailPath = path.join(
  root,
  "src/pages/[locale]/tags/[tag]/[...page].astro"
);
const detailPage = await import(moduleUrl(detailPath));

test("collection pages expose only their language's public tags", async () => {
  setPosts([
    ...posts,
    post("hidden.pt-BR", ["Oculto"], undefined, { draft: true }),
  ]);
  const routes = await collectionPage.getStaticPaths();
  assert.deepEqual(
    routes.map(route => route.params.locale),
    Object.keys(registry.locales)
  );
  assert.deepEqual(
    routes.map(route => route.props.tags.map(tag => tag.tagName)),
    [["Outils"], ["Tools"], ["أدوات"], []]
  );
});

test("detail pages pass public articles and resolved links to pagination and Header", async t => {
  const logs = [];
  t.mock.method(process.stderr, "write", message => {
    logs.push(String(message));
    return true;
  });
  setPosts([
    ...posts,
    post("second", ["Outils"]),
    post("hidden.en", ["Tools"], undefined, { draft: true }),
  ]);
  const calls = [];
  const routes = await detailPage.getStaticPaths({
    paginate(data, options) {
      calls.push({ data, options });
      return [{ params: options.params, props: options.props }];
    },
  });
  assert.equal(routes.length, 3);
  const french = calls.find(call => call.options.params.locale === "fr");
  assert.deepEqual(
    french.data.map(post => post.id),
    ["guide", "second"]
  );
  const english = calls.find(call => call.options.params.locale === "en");
  assert.deepEqual(
    english.data.map(post => post.id),
    ["guide.en"]
  );
  assert.equal(english.options.props.tagName, "Tools");
  assert.equal(english.options.props.languageLinks.fr, "/fr/tags/outils");
  assert.equal(french.options.props.languageLinks.en, "/en/tags/tools");
  assert.equal(french.options.props.languageLinks["pt-BR"], "/pt-BR/tags");
  assert.ok(french.options.pageSize > 0);
  assert.ok(logs.some(message => message.includes("missing-translation")));
  const template = readFileSync(detailPath, "utf8");
  assert.match(
    template,
    /<Header locale=\{locale\} languageLinks=\{languageLinks\}/
  );
  assert.match(template, /<h1\b[^>]*>[\s\S]*?\$\{tagName\}[\s\S]*?<\/h1>/);
});

test("page generation logs ambiguous relationships and rejects route collisions", async t => {
  const logs = [];
  t.mock.method(process.stderr, "write", message => {
    logs.push(String(message));
    return true;
  });
  setPosts([
    ...posts,
    post("second", ["Outils"]),
    post("second.en", ["Utilities"], "fr"),
  ]);
  const routes = await detailPage.getStaticPaths({
    paginate(_data, options) {
      return [options];
    },
  });
  const french = routes.find(route => route.params.locale === "fr");
  assert.equal(french.props.languageLinks.en, "/en/tags");
  assert.ok(
    logs.some(message => message.includes("Ambiguous tag relationship"))
  );
  assert.ok(logs.some(message => message.includes("ambiguous-mapping")));
  setPosts([post("a", ["Tools"]), post("b", ["tools"])]);
  await assert.rejects(collectionPage.getStaticPaths(), /Tag route collision/);
  await assert.rejects(
    detailPage.getStaticPaths({
      paginate() {
        assert.fail("must reject before pagination");
      },
    }),
    /Tag route collision/
  );
});
