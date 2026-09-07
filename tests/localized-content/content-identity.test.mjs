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

test("accepts either default-locale filename without changing identity", () => {
  assert.deepEqual(
    validateLocalizedContentIdentities(["guides/article.fr"], config),
    [{ baseId: "guides/article", locale: "fr", hasLocaleSuffix: true }]
  );
  assert.deepEqual(
    validateLocalizedContentIdentities(["guides/article"], config),
    [{ baseId: "guides/article", locale: "fr", hasLocaleSuffix: false }]
  );
});

test("preserves explicit language identities when the default changes", () => {
  assert.deepEqual(
    validateLocalizedContentIdentities(
      ["guides/article.fr", "guides/article.zh-Hant"],
      { ...config, defaultLocale: "zh-Hant" }
    ).map(identity => [identity.baseId, identity.locale]),
    [
      ["guides/article", "fr"],
      ["guides/article", "zh-Hant"],
    ]
  );
});

test("rejects implicit and explicit default variants in either order", () => {
  for (const sourceIds of [
    ["guides/article", "guides/article.fr"],
    ["guides/article.fr", "guides/article"],
    ["about", "about.fr"],
    ["home-intro.fr", "home-intro"],
  ]) {
    assert.throws(
      () => validateLocalizedContentIdentities(sourceIds, config),
      error => {
        assert.match(error.message, /define the same base path and locale/);
        for (const sourceId of sourceIds) {
          assert.ok(error.message.includes(`"${sourceId}"`));
        }
        return true;
      }
    );
  }
});

test("validates all page identities including pages without a route", () => {
  assert.throws(
    () =>
      validateLocalizedContentIdentities(
        ["about.fr", "home-intro", "unused/page", "unused/page.fr"],
        config
      ),
    /"unused\/page" and "unused\/page.fr" define the same base path and locale/
  );
  assert.doesNotThrow(() =>
    validateLocalizedContentIdentities(
      ["about.fr", "about.ar", "home-intro", "nested/about.fr"],
      config
    )
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
