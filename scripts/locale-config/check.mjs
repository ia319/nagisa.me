#!/usr/bin/env node

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import localeRegistry from "../../locales.config.mjs";
import { UI_DICTIONARIES } from "../../src/i18n/ui-dictionaries.mjs";
import { validateUiDictionaries } from "./ui.mjs";
import { createVercelConfig, serializeVercelConfig } from "./vercel.mjs";

validateUiDictionaries(localeRegistry, UI_DICTIONARIES);

const vercelConfigPath = fileURLToPath(
  new URL("../../vercel.json", import.meta.url)
);
const currentText = await fs.readFile(vercelConfigPath, "utf8");
const currentConfig = JSON.parse(currentText);
const expectedText = serializeVercelConfig(
  createVercelConfig(currentConfig, localeRegistry)
);

if (currentText !== expectedText) {
  process.stderr.write(
    "vercel.json is not synchronized with locales.config.mjs. Run pnpm locales:generate.\n"
  );
  process.exit(1);
}

process.stdout.write("Locale registry and vercel.json are synchronized.\n");
