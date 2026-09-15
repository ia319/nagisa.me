#!/usr/bin/env node

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import localeRegistry from "../../locales.config.mjs";
import { UI_DICTIONARIES } from "../../src/i18n/ui-dictionaries.mjs";
import { validateUiDictionaries } from "./ui.mjs";
import { createVercelConfig } from "./vercel.mjs";

validateUiDictionaries(localeRegistry, UI_DICTIONARIES);

const vercelConfigPath = fileURLToPath(
  new URL("../../vercel.json", import.meta.url)
);
const currentConfig = JSON.parse(await fs.readFile(vercelConfigPath, "utf8"));
const expectedConfig = createVercelConfig(currentConfig, localeRegistry);

// Vercel rewrites JSON formatting before running the build command.
if (!isDeepStrictEqual(currentConfig, expectedConfig)) {
  process.stderr.write(
    "vercel.json is not synchronized with locales.config.mjs. Run pnpm locales:generate.\n"
  );
  process.exit(1);
}

process.stdout.write("Locale registry and vercel.json are synchronized.\n");
