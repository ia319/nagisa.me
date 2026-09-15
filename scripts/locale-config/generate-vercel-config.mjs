#!/usr/bin/env node

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import localeRegistry from "../../locales.config.mjs";
import { createVercelConfig, serializeVercelConfig } from "./vercel.mjs";

const vercelConfigPath = fileURLToPath(
  new URL("../../vercel.json", import.meta.url)
);
const currentText = await fs.readFile(vercelConfigPath, "utf8");
const currentConfig = JSON.parse(currentText);
const nextText = serializeVercelConfig(
  createVercelConfig(currentConfig, localeRegistry)
);

if (nextText === currentText) {
  process.stdout.write("vercel.json is already synchronized.\n");
} else {
  await fs.writeFile(vercelConfigPath, nextText, "utf8");
  process.stdout.write("Synchronized vercel.json with locales.config.mjs.\n");
}
