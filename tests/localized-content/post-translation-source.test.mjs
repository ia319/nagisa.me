import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createSiteModuleLoader, siteRoot } from "./site-modules.mjs";

const registry = {
  defaultLocale: "fr",
  locales: {
    fr: { label: "Français", dir: "ltr" },
    ar: { label: "العربية", dir: "rtl" },
    "pt-BR": { label: "Português", dir: "ltr" },
    "zh-Hant": { label: "繁體中文", dir: "ltr" },
  },
};
const { moduleUrl } = await createSiteModuleLoader(registry);
const { getPostTranslations, getPostTranslationSource } = await import(
  moduleUrl(path.join(siteRoot, "src/utils/postI18n.ts"))
);
const { getPath } = await import(
  moduleUrl(path.join(siteRoot, "src/utils/getPath.ts"))
);

function post(sourceId, sourceLocale, data = {}) {
  return {
    id: sourceId.toLowerCase(),
    filePath: path.join(siteRoot, "src/data/blog", `${sourceId}.md`),
    data: {
      ...data,
      ...(sourceLocale
        ? {
            translation: {
              sourceLocale,
              provider: "ollama",
              model: "example:12b",
            },
          }
        : {}),
    },
  };
}

test("resolves the declared source by actual base path with any default or regional locale", () => {
  for (const sourceId of ["Nested/Guide", "Nested/Guide.fr"]) {
    const original = post(sourceId);
    const translated = post("Nested/Guide.pt-BR", "fr");
    const unrelated = post("Elsewhere/Guide");
    const variants = getPostTranslations(
      [unrelated, original, translated],
      translated
    );
    const result = getPostTranslationSource(translated, variants);
    assert.equal(result.status, "resolved");
    assert.equal(result.source.post, original);
    assert.equal(
      getPath(result.source.post.id, result.source.post.filePath),
      "/fr/posts/nested/guide"
    );
  }
});

test("follows the directly declared source instead of guessing an original language", () => {
  const french = post("guide");
  const portuguese = post("guide.pt-BR", "fr");
  const arabic = post("guide.ar", "pt-BR");
  const result = getPostTranslationSource(
    arabic,
    getPostTranslations([french, portuguese, arabic], arabic)
  );
  assert.equal(result.status, "resolved");
  assert.equal(result.source.post, portuguese);
  assert.equal(
    getPath(result.source.post.id, result.source.post.filePath),
    "/pt-BR/posts/guide"
  );
});

test("returns no source for originals, missing variants, drafts, or self references", () => {
  const original = post("guide");
  assert.deepEqual(
    getPostTranslationSource(
      original,
      getPostTranslations([original], original)
    ),
    { status: "not-translated" }
  );
  const translated = post("guide.zh-Hant", "fr");
  for (const candidates of [
    [translated],
    [translated, post("another")],
    [translated, post("guide", undefined, { draft: true })],
  ]) {
    assert.equal(
      getPostTranslationSource(
        translated,
        getPostTranslations(candidates, translated)
      ).status,
      "missing-source"
    );
  }
  const self = post("guide.ar", "ar");
  assert.equal(
    getPostTranslationSource(self, getPostTranslations([self], self)).status,
    "source-is-target"
  );
});

test("retains scheduled sources because their non-draft detail routes exist", () => {
  const original = post("guide", undefined, {
    pubDatetime: new Date("2999-01-01"),
  });
  const translated = post("guide.ar", "fr");
  const before = structuredClone([original, translated]);
  const result = getPostTranslationSource(
    translated,
    getPostTranslations([original, translated], translated)
  );
  assert.equal(result.status, "resolved");
  assert.deepEqual([original, translated], before);
});
