import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import localeRegistry from "../../locales.config.mjs";
import { UI_DICTIONARIES } from "../../src/i18n/ui-dictionaries.mjs";
import { validateUiDictionaries } from "../../scripts/locale-config/ui.mjs";
import { createSiteModuleLoader, siteRoot } from "./site-modules.mjs";

const registry = {
  defaultLocale: "fr",
  locales: {
    ...localeRegistry.locales,
    fr: { label: "Français", dir: "ltr" },
    ar: { label: "العربية", dir: "rtl" },
    "pt-BR": { label: "Português", dir: "ltr" },
    "zh-Hant": { label: "繁體中文", dir: "ltr" },
  },
};
const dictionaries = {
  ...UI_DICTIONARIES,
  fr: {
    ...UI_DICTIONARIES.en,
    "translation.sourceLanguage": "Langue source :",
    "translation.model": "Modèle de traduction :",
  },
  ar: {
    ...UI_DICTIONARIES.en,
    "translation.sourceLanguage": "اللغة المصدر:",
    "translation.model": "نموذج الترجمة:",
  },
  "pt-BR": { ...UI_DICTIONARIES.en },
  "zh-Hant": { ...UI_DICTIONARIES.zh },
};
const sources = new Map([
  ["astro/components/viewtransitions.css", "export {};"],
  [
    path.join(siteRoot, "src/i18n/ui-dictionaries.mjs"),
    `export const UI_DICTIONARIES = ${JSON.stringify(dictionaries)};`,
  ],
  [
    path.join(siteRoot, "src/utils/contentGitMeta.ts"),
    "export function getContentGitMeta() { return undefined; }",
  ],
]);
const { moduleUrl, componentUrl } = await createSiteModuleLoader(
  registry,
  sources
);
const { SITE } = await import(moduleUrl(path.join(siteRoot, "src/config.ts")));
const { LOCALE_LABELS } = await import(
  moduleUrl(path.join(siteRoot, "src/i18n/config.ts"))
);
const { getPostTranslations } = await import(
  moduleUrl(path.join(siteRoot, "src/utils/postI18n.ts"))
);
const { default: TranslationSource } = await import(
  await componentUrl(
    path.join(siteRoot, "src/components/TranslationSource.astro")
  )
);

const layoutFile = path.join(siteRoot, "src/layouts/PostDetails.astro");
// Render the real article layout and metadata components; unrelated visual widgets only pass slots through.
for (const match of readFileSync(layoutFile, "utf8").matchAll(
  /from "(@\/[^"\n]+\.astro)"/g
)) {
  const file = path.join(siteRoot, "src", match[1].slice(2));
  if (
    !["TranslationSource.astro", "ContentGitMeta.astro"].includes(
      path.basename(file)
    )
  )
    sources.set(file, "<slot />");
}
const bodyFile = path.join(
  siteRoot,
  "tests/localized-content/MemoryBody.astro"
);
sources.set(bodyFile, "<p>Article body</p>");
const bodyUrl = await componentUrl(bodyFile);
sources.set(
  "astro:content",
  `import Content from ${JSON.stringify(bodyUrl)}; export async function render() { return { Content }; }`
);
const iconFile = path.join(
  siteRoot,
  "tests/localized-content/MemoryIcon.astro"
);
sources.set(iconFile, "<span></span>");
const iconUrl = await componentUrl(iconFile);
for (const match of readFileSync(layoutFile, "utf8").matchAll(
  /from "(@\/[^"\n]+\.svg)"/g
))
  sources.set(
    path.join(siteRoot, "src", match[1].slice(2)),
    `export { default } from ${JSON.stringify(iconUrl)};`
  );
const { default: PostDetails } = await import(await componentUrl(layoutFile));
const container = await AstroContainer.create();

function post(sourceId, sourceLocale, model = "example:12b", extra = {}) {
  return {
    id: sourceId.toLowerCase(),
    filePath: path.join(siteRoot, "src/data/blog", `${sourceId}.md`),
    data: {
      title: "Example article",
      description: "Example",
      tags: [],
      pubDatetime: new Date("2020-01-01"),
      ...(sourceLocale
        ? { translation: { sourceLocale, provider: "ollama", model } }
        : {}),
      ...extra,
    },
  };
}

function renderSource(post, posts, locale) {
  return container.renderToString(TranslationSource, {
    props: { post, locale, translations: getPostTranslations(posts, post) },
  });
}

test("renders localized labels, language names, and source links without a fixed source language", async () => {
  for (const [locale, sourceLocale, expectedLabel, expectedModelLabel] of [
    ["zh", "en", "源语言：", "翻译模型："],
    ["en", "fr", "Source language:", "Translated with:"],
    ["ar", "pt-BR", "اللغة المصدر:", "نموذج الترجمة:"],
    ["fr", "zh-Hant", "Langue source :", "Modèle de traduction :"],
  ]) {
    const original = post(`guide.${sourceLocale}`);
    const translated = post(`guide.${locale}`, sourceLocale);
    const html = await renderSource(translated, [original, translated], locale);
    assert.ok(html.includes(expectedLabel));
    assert.ok(html.includes(expectedModelLabel));
    assert.ok(
      html.includes(
        new Intl.DisplayNames([locale], { type: "language" }).of(sourceLocale)
      )
    );
    assert.ok(html.includes(`href="/${sourceLocale}/posts/guide"`));
    assert.ok(html.includes(`hreflang="${sourceLocale}"`));
    assert.match(html, /<bdi dir="ltr">example:12b<\/bdi>/);
    assert.ok(html.includes("data-pagefind-ignore"));
  }
});

test("omits original attribution and renders missing, draft, and self sources as text", async () => {
  const original = post("guide");
  assert.equal((await renderSource(original, [original], "fr")).trim(), "");
  const translated = post("guide.en", "fr");
  for (const posts of [
    [translated],
    [translated, post("guide", undefined, undefined, { draft: true })],
  ]) {
    const html = await renderSource(translated, posts, "en");
    assert.ok(html.includes("French"));
    assert.ok(!html.includes("<a "));
    assert.ok(html.includes("example:12b"));
  }
  const self = post("guide.ar", "ar");
  assert.ok(!(await renderSource(self, [self], "ar")).includes("<a "));
});

test("falls back to registry labels or language codes when DisplayNames cannot provide a name", async t => {
  const translated = post("guide.en", "fr");
  const displayNames = Object.getOwnPropertyDescriptor(Intl, "DisplayNames");
  const sourceLabel = LOCALE_LABELS.fr;
  t.after(() => {
    Object.defineProperty(Intl, "DisplayNames", displayNames);
    LOCALE_LABELS.fr = sourceLabel;
  });
  for (const implementation of [
    undefined,
    class {
      static supportedLocalesOf() {
        return [];
      }
    },
    class {
      static supportedLocalesOf() {
        return ["en"];
      }
      of() {
        throw new RangeError("Unsupported source");
      }
    },
    class {
      static supportedLocalesOf() {
        return ["en"];
      }
      of() {
        return undefined;
      }
    },
  ]) {
    Object.defineProperty(Intl, "DisplayNames", {
      ...displayNames,
      value: implementation,
    });
    assert.ok(
      (await renderSource(translated, [translated], "en")).includes("Français")
    );
  }
  delete LOCALE_LABELS.fr;
  assert.match(
    await renderSource(translated, [translated], "en"),
    /<bdi>fr<\/bdi>/
  );
});

test("escapes model markup and isolates long mixed-direction model names", async () => {
  const model =
    'example/מודל-العربية:<script>alert("x")</script>&' + "long".repeat(80);
  const translated = post("guide.ar", "fr", model);
  const html = await renderSource(translated, [translated], "ar");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("wrap-anywhere"));
  assert.match(html, /<bdi dir="ltr">/);
});

test("article layout shows provenance above Git metadata with either Git setting", async t => {
  const enabled = SITE.contentGitMeta.enabled;
  t.after(() => {
    SITE.contentGitMeta.enabled = enabled;
  });
  const original = post("guide");
  const translated = post("guide.en", "fr");
  for (const gitEnabled of [false, true]) {
    SITE.contentGitMeta.enabled = gitEnabled;
    const html = await container.renderToString(PostDetails, {
      props: {
        locale: "en",
        post: translated,
        allPosts: [original, translated],
        posts: [],
      },
    });
    assert.ok(html.includes("Translated with:"));
    assert.ok(html.includes('href="/fr/posts/guide"'));
    if (gitEnabled) {
      assert.ok(
        html.indexOf("Translated with:") < html.indexOf("First committed")
      );
      assert.ok(html.includes("mt-2!"));
    } else assert.ok(!html.includes("First committed"));
  }
});

test("requires attribution UI keys in every configured dictionary", () => {
  validateUiDictionaries(localeRegistry, UI_DICTIONARIES);
  for (const key of ["translation.sourceLanguage", "translation.model"]) {
    const incomplete = structuredClone(UI_DICTIONARIES);
    const locale = Object.keys(localeRegistry.locales).find(
      locale => locale !== localeRegistry.defaultLocale
    );
    delete incomplete[locale][key];
    assert.throws(
      () => validateUiDictionaries(localeRegistry, incomplete),
      error => {
        assert.ok(error.message.includes(key));
        return true;
      }
    );
  }
});
