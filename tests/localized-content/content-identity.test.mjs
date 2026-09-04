import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLocalizedContentIdentity,
  validateLocalizedContentIdentities,
} from "../../src/utils/localizedContentIdentity.mjs";

const config = {
  defaultLocale: "fr",
  supportedLocales: ["fr", "pt-BR", "zh-Hant", "ar"],
};

test("uses the base path as identity for any configured locale", () => {
  assert.deepEqual(parseLocalizedContentIdentity("guides/article", config), {
    baseId: "guides/article",
    locale: "fr",
    hasLocaleSuffix: false,
  });
  assert.deepEqual(
    parseLocalizedContentIdentity("guides/article.pt-BR", config),
    {
      baseId: "guides/article",
      locale: "pt-BR",
      hasLocaleSuffix: true,
    }
  );
  assert.deepEqual(
    parseLocalizedContentIdentity("guides/article.zh-Hant", config),
    {
      baseId: "guides/article",
      locale: "zh-Hant",
      hasLocaleSuffix: true,
    }
  );
});

test("keeps ordinary dotted filenames in the default locale", () => {
  assert.deepEqual(
    parseLocalizedContentIdentity("releases/version.2", config),
    {
      baseId: "releases/version.2",
      locale: "fr",
      hasLocaleSuffix: false,
    }
  );
  assert.deepEqual(parseLocalizedContentIdentity("notes/article.de", config), {
    baseId: "notes/article.de",
    locale: "fr",
    hasLocaleSuffix: false,
  });
});

test("rejects locale suffix casing that would collide on Windows", () => {
  assert.throws(
    () => parseLocalizedContentIdentity("article.PT-br", config),
    /must use configured casing "pt-BR"/
  );
});

test("rejects explicit default suffixes", () => {
  assert.throws(
    () => validateLocalizedContentIdentities(["article.fr"], config),
    /must omit the ".fr" suffix/
  );
});

test("rejects duplicate language variants", () => {
  assert.throws(
    () =>
      validateLocalizedContentIdentities(
        ["article.pt-BR", "article.pt-BR"],
        config
      ),
    /define the same base path and locale/
  );
});

test("rejects base paths that differ only by case", () => {
  assert.throws(
    () =>
      validateLocalizedContentIdentities(
        ["Guides/article", "guides/article.pt-BR"],
        config
      ),
    /base paths differ only by case/
  );
});

test("accepts one variant per locale for the same base path", () => {
  assert.deepEqual(
    validateLocalizedContentIdentities(
      ["guides/article", "guides/article.pt-BR", "guides/article.ar"],
      config
    ).map(identity => [identity.baseId, identity.locale]),
    [
      ["guides/article", "fr"],
      ["guides/article", "pt-BR"],
      ["guides/article", "ar"],
    ]
  );
});
