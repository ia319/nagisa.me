#!/usr/bin/env node

import { parseArgs } from "node:util";
import { setDefaultLocale } from "./default-locale.mjs";

const help = `Usage: pnpm locales:set-default <locale> [--from <locale>]

Set a configured default locale, preserve content languages by renaming
unsuffixed blog and page files, then synchronize vercel.json.

  --from <locale>  Original language of remaining unsuffixed files
                  (default: the configured locale before the change)
  -h, --help      Show this help without changing files

Run from the project root. Unchanged items are skipped.
Completed changes remain on failure.
`;

try {
  const { values, positionals } = parseArgs({
    options: {
      from: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help || (positionals.length === 0 && values.from === undefined)) {
    process.stdout.write(help);
  } else {
    if (positionals.length !== 1) {
      throw new Error(
        "Provide exactly one target locale. Run pnpm locales:set-default --help."
      );
    }
    await setDefaultLocale(
      process.cwd(),
      positionals[0],
      values.from,
      message => process.stdout.write(`${message}\n`)
    );
  }
} catch (error) {
  process.stderr.write(`locales:set-default: ${error.message}\n`);
  process.exitCode = 1;
}
