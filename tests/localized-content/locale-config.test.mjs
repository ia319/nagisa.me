import assert from "node:assert/strict";
import test from "node:test";
import localeRegistry from "../../locales.config.mjs";
import { validateLocaleRegistry } from "../../scripts/locale-config/registry.mjs";
import { validateUiDictionaries } from "../../scripts/locale-config/ui.mjs";
import {
  createRootLocaleRoutes,
  createVercelConfig,
  serializeVercelConfig,
} from "../../scripts/locale-config/vercel.mjs";

test("validates arbitrary canonical locales and defaults", () => {
  const registry = {
    defaultLocale: "fr",
    locales: {
      fr: { label: "Français", dir: "ltr" },
      "pt-BR": { label: "Português do Brasil", dir: "ltr" },
      "zh-Hant": { label: "繁體中文", dir: "ltr" },
      ar: { label: "العربية", dir: "rtl" },
    },
  };

  assert.deepEqual(validateLocaleRegistry(registry), registry);
});

test("rejects non-canonical and case-colliding locale codes", () => {
  assert.throws(
    () =>
      validateLocaleRegistry({
        defaultLocale: "pt-br",
        locales: {
          "pt-br": { label: "Português", dir: "ltr" },
        },
      }),
    /canonical BCP 47 form "pt-BR"/
  );

  assert.throws(
    () =>
      validateLocaleRegistry({
        defaultLocale: "en",
        locales: {
          en: { label: "English", dir: "ltr" },
          EN: { label: "English", dir: "ltr" },
        },
      }),
    /case-insensitive collision/
  );
});

test("requires a configured default locale and valid direction", () => {
  assert.throws(
    () =>
      validateLocaleRegistry({
        defaultLocale: "fr",
        locales: {
          en: { label: "English", dir: "ltr" },
        },
      }),
    /must exist/
  );

  assert.throws(
    () =>
      validateLocaleRegistry({
        defaultLocale: "en",
        locales: {
          en: { label: "English", dir: "auto" },
        },
      }),
    /must be "ltr" or "rtl"/
  );
});

test("lists missing UI keys for every configured locale", () => {
  assert.throws(
    () =>
      validateUiDictionaries(
        {
          defaultLocale: "en",
          locales: {
            en: { label: "English", dir: "ltr" },
            fr: { label: "Français", dir: "ltr" },
            de: { label: "Deutsch", dir: "ltr" },
          },
        },
        {
          en: { greeting: "Hello", farewell: "Goodbye" },
          fr: { greeting: "Bonjour" },
          de: {},
        }
      ),
    error => {
      assert.match(error.message, /Locale "fr" is missing UI keys: farewell/);
      assert.match(
        error.message,
        /Locale "de" is missing UI keys: greeting, farewell/
      );
      return true;
    }
  );
});

test("orders specific Accept-Language routes before base locales", () => {
  const routes = createRootLocaleRoutes({
    defaultLocale: "fr",
    locales: {
      fr: { label: "Français", dir: "ltr" },
      pt: { label: "Português", dir: "ltr" },
      "pt-BR": { label: "Português do Brasil", dir: "ltr" },
    },
  });
  const headerRoutes = routes.filter(
    route => route.has?.[0]?.key === "accept-language"
  );

  assert.deepEqual(
    headerRoutes.map(route => route.dest),
    ["/pt-BR/", "/fr/", "/pt/"]
  );
  assert.match(headerRoutes[0].has[0].value.re, /^\^\[pP\]/);
  assert.equal(routes.at(-1).dest, "/fr/");
});

test("preserves non-root Vercel configuration", () => {
  const currentConfig = {
    $schema: "https://openapi.vercel.sh/vercel.json",
    regions: ["sin1"],
    routes: [
      { src: "^/$", dest: "/legacy/" },
      { src: "^/api/(.*)$", dest: "/api/$1" },
    ],
  };
  const nextConfig = createVercelConfig(currentConfig, localeRegistry);

  assert.deepEqual(nextConfig.regions, ["sin1"]);
  assert.deepEqual(nextConfig.routes.at(-1), {
    src: "^/api/(.*)$",
    dest: "/api/$1",
  });
  assert.equal(
    nextConfig.routes.filter(route => route.src === "^/$").length,
    Object.keys(localeRegistry.locales).length * 2 + 1
  );
  assert.ok(serializeVercelConfig(nextConfig).endsWith("\n"));
});
