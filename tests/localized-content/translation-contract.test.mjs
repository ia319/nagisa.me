import assert from "node:assert/strict";
import test from "node:test";
import {
  getTranslationFieldAction,
  resolveTranslationSource,
  TRANSLATION_FIELD_ACTION,
  TRANSLATION_FIELD_POLICY,
  TRANSLATION_FRONTMATTER_OVERRIDES,
  TRANSLATION_MARKDOWN_BODY_ACTION,
  TRANSLATION_PROVIDER,
} from "../../src/content/translationContract.mjs";

test("defines the Ollama translation metadata provider", () => {
  assert.equal(TRANSLATION_PROVIDER, "ollama");
});

test("classifies every blog schema field with a deterministic action", () => {
  assert.deepEqual(TRANSLATION_FIELD_POLICY, {
    author: TRANSLATION_FIELD_ACTION.COPY,
    pubDatetime: TRANSLATION_FIELD_ACTION.COPY,
    modDatetime: TRANSLATION_FIELD_ACTION.COPY,
    title: TRANSLATION_FIELD_ACTION.TRANSLATE,
    featured: TRANSLATION_FIELD_ACTION.COPY,
    draft: TRANSLATION_FIELD_ACTION.FORCE_DRAFT,
    tags: TRANSLATION_FIELD_ACTION.TRANSLATE,
    ogImage: TRANSLATION_FIELD_ACTION.COPY,
    description: TRANSLATION_FIELD_ACTION.TRANSLATE,
    canonicalURL: TRANSLATION_FIELD_ACTION.OMIT,
    hideEditPost: TRANSLATION_FIELD_ACTION.COPY,
    timezone: TRANSLATION_FIELD_ACTION.COPY,
    translation: TRANSLATION_FIELD_ACTION.REBUILD,
  });
  assert.equal(
    TRANSLATION_MARKDOWN_BODY_ACTION,
    TRANSLATION_FIELD_ACTION.TRANSLATE
  );
  assert.deepEqual(TRANSLATION_FRONTMATTER_OVERRIDES, { draft: true });
  assert.equal(
    getTranslationFieldAction("customField"),
    TRANSLATION_FIELD_ACTION.PRESERVE
  );
});

test("resolves a declared source by base path and source locale", () => {
  const source = { baseId: "guides/article", locale: "fr", id: "source" };
  const target = {
    baseId: "guides/article",
    locale: "pt-BR",
    translation: { sourceLocale: "fr" },
  };

  assert.deepEqual(resolveTranslationSource(target, [source]), {
    status: "resolved",
    sourceLocale: "fr",
    source,
  });
});

test("keeps a diagnostic result when the declared source is missing", () => {
  const target = {
    baseId: "guides/article",
    locale: "zh-Hant",
    translation: { sourceLocale: "fr" },
  };

  assert.deepEqual(resolveTranslationSource(target, []), {
    status: "missing-source",
    sourceLocale: "fr",
  });
});

test("distinguishes original content and invalid self references", () => {
  assert.deepEqual(
    resolveTranslationSource({ baseId: "guides/article", locale: "fr" }, []),
    { status: "not-translated" }
  );
  assert.deepEqual(
    resolveTranslationSource(
      {
        baseId: "guides/article",
        locale: "fr",
        translation: { sourceLocale: "fr" },
      },
      []
    ),
    { status: "source-is-target", sourceLocale: "fr" }
  );
});
