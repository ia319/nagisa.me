import { validateLocaleRegistry } from "./registry.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate that every configured locale provides the default UI key set.
 * @param {unknown} registry Shared locale registry input.
 * @param {unknown} dictionaries UI dictionaries keyed by locale.
 * @returns {void}
 * @throws {Error} When dictionaries or translated values are incomplete.
 */
export function validateUiDictionaries(registry, dictionaries) {
  const validatedRegistry = validateLocaleRegistry(registry);

  if (!isRecord(dictionaries)) {
    throw new Error("UI dictionaries must be an object.");
  }

  const defaultDictionary = dictionaries[validatedRegistry.defaultLocale];

  if (!isRecord(defaultDictionary)) {
    throw new Error(
      `Default locale "${validatedRegistry.defaultLocale}" must have a UI dictionary.`
    );
  }

  const requiredKeys = Object.keys(defaultDictionary);
  const errors = [];

  if (requiredKeys.length === 0) {
    errors.push(
      `Default locale "${validatedRegistry.defaultLocale}" UI dictionary must not be empty.`
    );
  }

  for (const locale of Object.keys(validatedRegistry.locales)) {
    const dictionary = dictionaries[locale];

    if (!isRecord(dictionary)) {
      errors.push(
        `Locale "${locale}" is missing UI keys: ${requiredKeys.join(", ")}.`
      );
      continue;
    }

    const missingKeys = requiredKeys.filter(
      key => !Object.hasOwn(dictionary, key)
    );

    if (missingKeys.length > 0) {
      errors.push(
        `Locale "${locale}" is missing UI keys: ${missingKeys.join(", ")}.`
      );
    }

    for (const [key, value] of Object.entries(dictionary)) {
      if (typeof value !== "string") {
        errors.push(`Locale "${locale}" UI key "${key}" must be a string.`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}
