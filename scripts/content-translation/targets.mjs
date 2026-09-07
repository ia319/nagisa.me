import {
  parseLocalizedContentIdentity,
  validateLocalizedContentIdentities,
} from "../../src/utils/localizedContentIdentity.mjs";

/** @typedef {Readonly<{path: string, kind: "file" | "directory" | "symlink"}>} FileState */

function validateSnapshotPath(value) {
  if (
    typeof value !== "string" ||
    /[\\:\u0000-\u001f]/.test(value) ||
    value.split("/").some(part => !part || part === "." || part === "..")
  ) {
    throw new Error(
      `Expected a normalized blog-relative path: ${JSON.stringify(value)}`
    );
  }
}

/**
 * Plan same-directory targets against a caller-supplied filesystem snapshot.
 * Real paths, permissions, and final write checks belong to the CLI boundary.
 * @param {{sourcePath: string, files: readonly FileState[], targetLocales: readonly string[], config: {defaultLocale: string, supportedLocales: readonly string[]}, fromLocale?: string, force?: boolean}} input Source path, languages, and existing entry states.
 * @returns {{source: {baseId: string, locale: string, hasLocaleSuffix: boolean}, targets: {path: string, locale: string, overwrite: boolean}[]}} Source identity and validated output paths.
 * @throws {Error} When languages, content identities, or target paths conflict.
 */
export function planTranslationTargets({
  sourcePath,
  files,
  targetLocales,
  config,
  fromLocale,
  force = false,
}) {
  validateSnapshotPath(sourcePath);
  if (
    !sourcePath.endsWith(".md") ||
    sourcePath.split("/").some(part => part.startsWith(".")) ||
    sourcePath.split("/").at(-1).startsWith("_")
  ) {
    throw new Error("Source must be a blog Markdown content file");
  }
  for (const file of files) validateSnapshotPath(file.path);
  if (
    !targetLocales.length ||
    new Set(targetLocales).size !== targetLocales.length
  )
    throw new Error("Provide at least one unique target locale");
  for (const locale of targetLocales) {
    if (!config.supportedLocales.includes(locale))
      throw new Error(`Target locale is not configured: ${locale}`);
  }
  const source = parseLocalizedContentIdentity(sourcePath.slice(0, -3), config);
  if (fromLocale !== undefined && fromLocale !== source.locale)
    throw new Error(`Source locale is ${source.locale}, not ${fromLocale}`);
  const contentPaths = files
    .filter(
      file =>
        file.kind === "file" &&
        file.path.endsWith(".md") &&
        !file.path.split("/").some(part => part.startsWith(".")) &&
        !file.path.split("/").at(-1).startsWith("_")
    )
    .map(file => file.path);
  if (!contentPaths.includes(sourcePath)) contentPaths.push(sourcePath);
  const identities = validateLocalizedContentIdentities(
    contentPaths.map(value => value.slice(0, -3)),
    config
  );
  const targets = targetLocales.map(locale => {
    const existing = identities.findIndex(
      identity =>
        identity.baseId === source.baseId && identity.locale === locale
    );
    const target =
      existing >= 0
        ? contentPaths[existing]
        : `${source.baseId}${locale === config.defaultLocale ? "" : `.${locale}`}.md`;
    const caseKey = target.normalize("NFC").toLowerCase();
    const matches = files.filter(
      file => file.path.normalize("NFC").toLowerCase() === caseKey
    );
    if (matches.some(file => file.path !== target))
      throw new Error(`Target path differs only by case: ${target}`);
    if (matches.some(file => file.kind !== "file"))
      throw new Error(`Target is not a regular file: ${target}`);
    if (matches.length && !force)
      throw new Error(
        `Target already exists: ${target}; use --force to replace it`
      );
    return { path: target, locale, overwrite: matches.length > 0 };
  });
  return { source, targets };
}
