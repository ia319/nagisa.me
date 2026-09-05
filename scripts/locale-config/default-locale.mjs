import fs from "node:fs/promises";
import path from "node:path";
import { validateLocalizedContentIdentities } from "../../src/utils/localizedContentIdentity.mjs";
import { validateLocaleRegistry } from "./registry.mjs";
import { validateUiDictionaries } from "./ui.mjs";
import { createVercelConfig, serializeVercelConfig } from "./vercel.mjs";

async function readProjectText(root, relativePath) {
  const filePath = path.join(root, relativePath);
  if (
    (await fs.realpath(filePath)) !== filePath ||
    !(await fs.lstat(filePath)).isFile()
  ) {
    throw new Error(
      `Expected a regular file without symbolic links: ${relativePath}`
    );
  }
  return fs.readFile(filePath, "utf8");
}

async function collectContentFiles(root, directory) {
  const directoryPath = path.join(root, directory);
  if ((await fs.realpath(directoryPath)) !== directoryPath) {
    throw new Error(
      `Content directory must not use symbolic links: ${directory}`
    );
  }

  const files = [];
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Match the content loaders: ignore dot paths and underscore-prefixed files.
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Content paths must not use symbolic links: ${relativePath}`
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await collectContentFiles(root, relativePath)));
    } else if (!entry.name.startsWith("_") && entry.name.endsWith(".md")) {
      if (!entry.isFile()) {
        throw new Error(`Expected a regular Markdown file: ${relativePath}`);
      }
      files.push(relativePath);
    }
  }
  return files;
}

async function assertRenameTargetAvailable(root, target) {
  const targetPath = path.join(root, target);
  const filename = path.basename(target).normalize("NFC").toLowerCase();
  const entries = await fs.readdir(path.dirname(targetPath));
  if (entries.some(name => name.normalize("NFC").toLowerCase() === filename)) {
    throw new Error(`Rename target already exists: ${target}`);
  }
}

/**
 * Switch the default locale while preserving the language of unsuffixed content.
 * @param {string} root Project root containing the shared registry and content.
 * @param {string} targetLocale Configured locale to use as the default.
 * @param {string | undefined} fromLocale Original locale of remaining unsuffixed files.
 * @param {(message: string) => void} report Progress and recovery message sink.
 * @returns {Promise<void>} Resolves after configuration and filenames are synchronized.
 * @throws {Error} When preflight fails or a write fails; completed changes remain.
 */
export async function setDefaultLocale(root, targetLocale, fromLocale, report) {
  root = await fs.realpath(root);
  const registryText = await readProjectText(root, "locales.config.mjs");
  const { default: registry } = await import(
    `data:text/javascript;base64,${Buffer.from(registryText, "utf8").toString("base64")}`
  );
  const validatedRegistry = validateLocaleRegistry(registry);
  const originalLocale = fromLocale ?? validatedRegistry.defaultLocale;
  const supportedLocales = Object.keys(validatedRegistry.locales);

  for (const locale of [targetLocale, originalLocale]) {
    if (!supportedLocales.includes(locale)) {
      throw new Error(
        `Locale "${locale}" is not configured. Available locales: ${supportedLocales.join(", ")}.`
      );
    }
  }

  const uiText = await readProjectText(root, "src/i18n/ui-dictionaries.mjs");
  const { UI_DICTIONARIES } = await import(
    `data:text/javascript;base64,${Buffer.from(uiText, "utf8").toString("base64")}`
  );
  const nextRegistry = { ...registry, defaultLocale: targetLocale };
  validateUiDictionaries(registry, UI_DICTIONARIES);
  validateUiDictionaries(nextRegistry, UI_DICTIONARIES);

  let nextRegistryText = registryText;
  if (validatedRegistry.defaultLocale !== targetLocale) {
    // Edit only the literal value in the registry's static data declaration.
    const declarations = [
      ...registryText.matchAll(
        /^([\t ]*(?:defaultLocale|"defaultLocale"|'defaultLocale')\s*:\s*)(["'])([^"'\r\n]+)\2/gm
      ),
    ];
    const declaration = declarations[0];
    if (
      declarations.length !== 1 ||
      declaration[3] !== validatedRegistry.defaultLocale
    ) {
      throw new Error(
        "locales.config.mjs must declare defaultLocale once as a string literal on its own line."
      );
    }
    const valueStart = declaration.index + declaration[1].length + 1;
    nextRegistryText = (
      registryText.slice(0, valueStart) +
      targetLocale +
      registryText.slice(valueStart + declaration[3].length)
    )
      .replace(/^\uFEFF/, "")
      .replaceAll("\r\n", "\n");
    const { default: rewrittenRegistry } = await import(
      `data:text/javascript;base64,${Buffer.from(nextRegistryText, "utf8").toString("base64")}`
    );
    if (JSON.stringify(rewrittenRegistry) !== JSON.stringify(nextRegistry)) {
      throw new Error(
        "Cannot safely replace the defaultLocale literal in locales.config.mjs."
      );
    }
  }

  const vercelText = await readProjectText(root, "vercel.json");
  const nextVercelText = serializeVercelConfig(
    createVercelConfig(JSON.parse(vercelText), nextRegistry)
  );
  const renames = [];
  const unchanged = [];

  for (const collection of ["src/data/blog", "src/data/pages"]) {
    try {
      await fs.lstat(path.join(root, collection));
    } catch (error) {
      // Empty content collections need not have a directory in a fresh clone.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const files = await collectContentFiles(root, collection);
    const sourceIds = files.map(file => file.slice(collection.length + 1, -3));
    const identities = validateLocalizedContentIdentities(sourceIds, {
      defaultLocale: originalLocale,
      supportedLocales,
    });
    const targets = files.map((file, index) => {
      const identity = identities[index];
      if (identity.hasLocaleSuffix || originalLocale === targetLocale) {
        unchanged.push(file);
        return file;
      }
      const target = `${file.slice(0, -3)}.${originalLocale}.md`;
      renames.push({ source: file, target });
      return target;
    });
    validateLocalizedContentIdentities(
      targets.map(file => file.slice(collection.length + 1, -3)),
      { defaultLocale: targetLocale, supportedLocales }
    );
  }

  // Include directories and other non-content entries in target collision checks.
  for (const { target } of renames) {
    await assertRenameTargetAvailable(root, target);
  }

  const actions = [
    {
      path: "locales.config.mjs",
      before: registryText,
      after: nextRegistryText,
    },
    ...renames.map(rename => ({ path: rename.source, ...rename })),
    { path: "vercel.json", before: vercelText, after: nextVercelText },
  ];
  const completed = [];
  if (!fromLocale && originalLocale === targetLocale) {
    report(
      `Skip filename migration: default locale is already ${targetLocale}; no historical source locale was supplied.`
    );
  }

  for (const [index, action] of actions.entries()) {
    try {
      if (action.source) {
        const sourcePath = path.join(root, action.source);
        const targetPath = path.join(root, action.target);
        if (
          (await fs.realpath(sourcePath)) !== sourcePath ||
          !(await fs.lstat(sourcePath)).isFile()
        ) {
          throw new Error(
            `Source is no longer a regular file: ${action.source}`
          );
        }
        await assertRenameTargetAvailable(root, action.target);
        await fs.rename(sourcePath, targetPath);
        completed.push(`${action.source} -> ${action.target}`);
        report(`Renamed: ${completed.at(-1)}`);
      } else if (action.before === action.after) {
        report(`Skip unchanged configuration: ${action.path}`);
      } else {
        if ((await readProjectText(root, action.path)) !== action.before) {
          throw new Error(
            `Configuration changed after preflight: ${action.path}`
          );
        }
        await fs.writeFile(path.join(root, action.path), action.after, "utf8");
        completed.push(action.path);
        report(`Updated: ${action.path}`);
      }
    } catch (error) {
      report(`Completed: ${completed.join("; ") || "none"}`);
      report(`Failed: ${action.path}: ${error.message}`);
      report(
        `Pending: ${
          actions
            .slice(index + 1)
            .filter(item => item.source || item.before !== item.after)
            .map(item => item.path)
            .join("; ") || "none"
        }`
      );
      report(
        `Keep completed changes. Resolve the failure, then retry: pnpm locales:set-default ${targetLocale} --from ${originalLocale}`
      );
      throw error;
    }
    if (index === 0) {
      for (const file of unchanged) report(`Skip unchanged filename: ${file}`);
    }
  }
  report(
    `Default locale synchronized: ${targetLocale}.${renames.length > 0 ? " After committing renamed content, run pnpm content:git-meta." : ""}`
  );
}
