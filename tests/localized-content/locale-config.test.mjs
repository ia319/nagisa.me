import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import localeRegistry from "../../locales.config.mjs";
import { validateLocaleRegistry } from "../../scripts/locale-config/registry.mjs";
import { validateUiDictionaries } from "../../scripts/locale-config/ui.mjs";
import {
  createRootLocaleRoutes,
  createVercelConfig,
  serializeVercelConfig,
} from "../../scripts/locale-config/vercel.mjs";

function runConfigCheck(currentText) {
  const checkUrl = new URL(
    "../../scripts/locale-config/check.mjs",
    import.meta.url
  );
  const vercelPath = fileURLToPath(
    new URL("../../vercel.json", import.meta.url)
  );
  const source = `
    import fs from "node:fs/promises";
    const readFile = fs.readFile;
    fs.readFile = async (path, ...args) => path === ${JSON.stringify(vercelPath)}
      ? ${JSON.stringify(currentText)} : readFile(path, ...args);
    fs.writeFile = async () => { throw new Error("Configuration checks must not write files"); };
    await import(${JSON.stringify(checkUrl.href)});
  `;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    }
  );
}

test("accepts equivalent configuration regardless of JSON formatting", async t => {
  const config = createVercelConfig({}, localeRegistry);
  const pretty = serializeVercelConfig(config);
  const reordered = structuredClone(config);
  reordered.routes = reordered.routes.map(route =>
    Object.fromEntries(Object.entries(route).reverse())
  );
  const cases = [
    ["repository formatting", pretty],
    ["Vercel compact formatting", `${JSON.stringify(config)}\n`],
    ["Windows line endings", pretty.replaceAll("\n", "\r\n")],
    ["no final newline", pretty.trimEnd()],
    ["reordered object fields", serializeVercelConfig(reordered)],
  ];
  for (const [name, text] of cases) {
    await t.test(name, () => {
      const result = runConfigCheck(text);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(
        result.stdout,
        /Locale registry and vercel.json are synchronized/
      );
    });
  }
});

test("rejects changed locale routes despite valid JSON", async t => {
  const mutations = [
    [
      "destination",
      config => {
        config.routes[0].dest = "/wrong/";
      },
    ],
    [
      "route order",
      config => {
        config.routes.reverse();
      },
    ],
    [
      "missing route",
      config => {
        config.routes.pop();
      },
    ],
    [
      "duplicate route",
      config => {
        config.routes.push(config.routes[0]);
      },
    ],
    [
      "cookie condition",
      config => {
        config.routes[0].has[0].value.eq = "wrong";
      },
    ],
    [
      "header condition",
      config => {
        config.routes.find(
          route => route.has?.[0]?.type === "header"
        ).has[0].value.re = "^wrong$";
      },
    ],
    [
      "response header",
      config => {
        config.routes[0].headers.Vary = "Cookie";
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const config = createVercelConfig({}, localeRegistry);
      mutate(config);
      const result = runConfigCheck(JSON.stringify(config));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /vercel.json is not synchronized/);
      assert.equal(result.stdout, "");
    });
  }
});

test("preserves unrelated deployment settings during configuration checks", () => {
  const config = createVercelConfig(
    {
      regions: ["sin1"],
      routes: [{ src: "^/api/(.*)$", dest: "/api/$1" }],
    },
    localeRegistry
  );
  const result = runConfigCheck(JSON.stringify(config));
  assert.equal(result.status, 0, result.stderr);
});

test("rejects malformed JSON and invalid routes", () => {
  for (const text of ["invalid JSON", '{"routes":{}}']) {
    const result = runConfigCheck(text);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
});

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
