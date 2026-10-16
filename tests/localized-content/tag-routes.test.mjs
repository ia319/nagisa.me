import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createSiteModuleLoader, siteRoot as root } from "./site-modules.mjs";

const registry = {
  defaultLocale: "fr",
  locales: {
    fr: { label: "Français", dir: "ltr" },
    en: { label: "English", dir: "ltr" },
    ar: { label: "العربية", dir: "rtl" },
  },
};
const { moduleUrl, setPosts, setTags } = await createSiteModuleLoader(registry);
const { getTagIndex, getTagLanguageLinks } = await import(
  moduleUrl(path.join(root, "src/utils/getTagIndex.ts"))
);
const { default: getPostsByTag } = await import(
  moduleUrl(path.join(root, "src/utils/getPostsByTag.ts"))
);
function post(id, tags, data = {}) {
  return {
    id,
    filePath: path.join(root, "src/data/blog", id + ".md"),
    data: { tags, title: id, pubDatetime: new Date("2020-01-01"), ...data },
  };
}
function definition(id, name, data = {}) {
  return {
    id: id.toLowerCase(),
    filePath: path.join(root, "src/data/tags", id + ".md"),
    data: { name, ...data },
  };
}
const posts = [
  post("guide", ["tools", "tools"]),
  post("guide.en", ["tools"]),
  post("other", ["tools", "astro"]),
];
const definitions = [
  definition("tools", "Outils", { aliases: ["outils"] }),
  definition("tools.en", "Tools", { aliases: ["old-tools"] }),
];

test("uses literal IDs, localized names and unique public article counts", () => {
  const before = structuredClone(posts);
  const index = getTagIndex(posts, definitions);
  const french = index.tags.find(
    item => item.locale === "fr" && item.tag === "tools"
  );
  assert.equal(french.tagName, "Outils");
  assert.equal(french.count, 2);
  assert.deepEqual(
    getPostsByTag(index.posts, "tools", "en").map(item => item.id),
    ["guide.en"]
  );
  assert.deepEqual(getPostsByTag(index.posts, "Tools", "en"), []);
  assert.deepEqual(getTagLanguageLinks(index, french), {
    fr: "/fr/tags/tools",
    en: "/en/tags/tools",
    ar: "/ar/tags",
  });
  assert.deepEqual(posts, before);
  definitions[0].data.name = "Nouveau";
  assert.equal(
    getTagIndex(posts, definitions).tags.find(item => item.tag === "tools").tag,
    "tools"
  );
  definitions[0].data.name = "Outils";
  assert.ok(
    index.diagnostics.some(item => /astro.*other.md/.test(item.message))
  );
});

test("does not fall back to another language, draft metadata, or empty tag documents", () => {
  const index = getTagIndex(
    [
      ...posts,
      post("draft.ar", ["tools"], { draft: true }),
      post("future.ar", ["tools"], { pubDatetime: new Date("2999-01-01") }),
    ],
    [
      definitions[0],
      definition("tools.en", "Hidden", { draft: true }),
      definition("empty", "Empty"),
    ]
  );
  const english = index.tags.find(item => item.locale === "en");
  assert.equal(english.tagName, "tools");
  assert.equal(english.entry, undefined);
  assert.ok(
    !index.tags.some(item => item.tag === "empty" || item.locale === "ar")
  );
});

test("validates physical paths, single-segment IDs and localized identities before filtering", () => {
  assert.throws(
    () =>
      getTagIndex(posts, [
        definition("tools", "A"),
        definition("tools.fr", "B"),
      ]),
    /same base path and locale/
  );
  assert.throws(
    () => getTagIndex(posts, [definition("nested/tools", "A")]),
    /Invalid tag ID/
  );
  assert.throws(
    () => getTagIndex(posts, [{ ...definitions[0], filePath: undefined }]),
    /source path/
  );
  assert.throws(() => getTagIndex([post("a", ["a/b"])], []), /Invalid tag ID/);
  assert.throws(
    () => getTagIndex([post("a", []), post("a.fr", [])], []),
    /same base path and locale/
  );
  assert.throws(
    () =>
      getTagIndex(posts, [definition("Tools", "A"), definition("tools", "B")]),
    /differ only by case/
  );
});

test("rejects public tag routes that collide within one language", () => {
  const cases = [
    { articles: [post("a", ["Tools", "tools"])], docs: [] },
    { articles: [post("a", ["Tools"]), post("b", ["tools"])], docs: [] },
    {
      articles: [post("a", ["Tools", "tools"])],
      docs: [definition("tools", "Outils")],
    },
    { articles: [post("a", ["Café", "Cafe\u0301"])], docs: [] },
  ];
  for (const { articles, docs } of cases)
    assert.throws(
      () => getTagIndex(articles, docs),
      /Tag routes .+ and .+ collide in locale "fr" on case-insensitive file systems/
    );
});

test("preserves literal casing across languages and ignores unpublished routes", () => {
  const index = getTagIndex(
    [
      post("a", ["Tools", "Tools"]),
      post("b", ["Tools"]),
      post("a.en", ["tools"]),
      post("draft", ["tools"], { draft: true }),
      post("future", ["tools"], { pubDatetime: new Date("2999-01-01") }),
    ],
    []
  );
  assert.deepEqual(
    index.tags.map(({ locale, tag, count }) => ({ locale, tag, count })),
    [
      { locale: "fr", tag: "Tools", count: 2 },
      { locale: "en", tag: "tools", count: 1 },
    ]
  );
});

const overview = await import(
  moduleUrl(path.join(root, "src/pages/[locale]/tags/index.astro"))
);
const detail = await import(
  moduleUrl(path.join(root, "src/pages/[locale]/tags/[tag]/[...page].astro"))
);
const legacy = await import(
  moduleUrl(path.join(root, "src/pages/tags/[tag]/[...page].astro"))
);
const paginate = (data, options) =>
  Array.from({ length: Math.ceil(data.length / options.pageSize) }, (_, i) => ({
    params: { ...options.params, page: i ? String(i + 1) : undefined },
    props: {
      ...options.props,
      page: {
        data: data.slice(i * options.pageSize, (i + 1) * options.pageSize),
        currentPage: i + 1,
        lastPage: Math.ceil(data.length / options.pageSize),
      },
    },
  }));

test("generates language collections and canonical plus legacy routes with real pagination", async () => {
  setPosts([
    ...Array.from({ length: 15 }, (_, i) => post("post-" + i, ["tools"])),
    posts[1],
  ]);
  setTags(definitions);
  const collections = await overview.getStaticPaths();
  assert.deepEqual(
    collections.map(item => item.props.tags.map(tag => tag.tagName)),
    [["Outils"], ["Tools"], []]
  );
  const pages = await detail.getStaticPaths({ paginate });
  const canonical = pages.filter(
    item => item.params.locale === "fr" && item.params.tag === "tools"
  );
  const aliases = pages.filter(
    item => item.params.locale === "fr" && item.params.tag === "outils"
  );
  assert.ok(canonical.length > 1);
  assert.equal(aliases.length, canonical.length);
  for (const [i, item] of aliases.entries()) {
    assert.equal(item.props.redirectTag, "tools");
    assert.equal(item.props.page.currentPage, i + 1);
    assert.equal(item.props.languageLinks.en, "/en/tags/tools");
  }
  const unprefixed = await legacy.getStaticPaths({ paginate });
  assert.equal(unprefixed.length, canonical.length * 2);
  assert.ok(
    unprefixed.every(item => item.props.redirectPath === "/fr/tags/tools")
  );
  assert.ok(unprefixed.some(item => item.props.page.currentPage === 2));
});

test("excludes case-conflicting aliases from localized and legacy pages", async t => {
  const logs = [];
  t.mock.method(process.stderr, "write", message => {
    logs.push(String(message));
    return true;
  });
  setPosts([post("a", ["tools"]), post("b", ["other"])]);
  setTags([
    definition("tools", "Outils", { aliases: ["Tools", "Old", "legacy"] }),
    definition("other", "Autres", { aliases: ["old"] }),
  ]);
  const routes = await detail.getStaticPaths({ paginate });
  const unprefixed = await legacy.getStaticPaths({ paginate });
  for (const pages of [routes, unprefixed])
    assert.deepEqual(pages.map(item => item.params.tag).sort(), [
      "legacy",
      "other",
      "tools",
    ]);
  assert.ok(logs.some(message => /Tools.*reserved ID/.test(message)));
  assert.ok(logs.some(message => /Old.*old.*fr/.test(message)));
  setPosts([post("a", ["Tools", "tools"])]);
  await assert.rejects(
    detail.getStaticPaths({ paginate }),
    /Tag routes.*collide/
  );
});

test("warns for unknown IDs while keeping their routes", async t => {
  const logs = [];
  t.mock.method(process.stderr, "write", message => {
    logs.push(String(message));
    return true;
  });
  setPosts([post("unknown", ["missing"])]);
  setTags([]);
  const routes = await detail.getStaticPaths({ paginate });
  assert.equal(routes[0].params.tag, "missing");
  assert.equal(routes[0].props.tagName, "missing");
  assert.ok(logs.some(message => /missing.*unknown.md/.test(message)));
});
