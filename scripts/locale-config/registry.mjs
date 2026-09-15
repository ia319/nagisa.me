const LOCALE_DIRECTIONS = new Set(["ltr", "rtl"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize the shared locale registry.
 * @param {unknown} registry Shared locale registry input.
 * @returns {{defaultLocale: string, locales: Record<string, {label: string, dir: "ltr" | "rtl"}>}} Validated registry data.
 * @throws {Error} When the registry contains an invalid locale definition.
 */
export function validateLocaleRegistry(registry) {
  if (!isRecord(registry)) {
    throw new Error("Locale registry must be an object.");
  }

  const { defaultLocale, locales } = registry;

  if (typeof defaultLocale !== "string" || defaultLocale.length === 0) {
    throw new Error(
      "Locale registry defaultLocale must be a non-empty string."
    );
  }

  if (!isRecord(locales) || Object.keys(locales).length === 0) {
    throw new Error("Locale registry must define at least one locale.");
  }

  const validatedLocales = {};
  const localeCodesByCase = new Map();

  for (const [locale, value] of Object.entries(locales)) {
    const caseKey = locale.toLowerCase();
    const existingLocale = localeCodesByCase.get(caseKey);

    if (existingLocale) {
      throw new Error(
        `Locale registry contains a case-insensitive collision: ${existingLocale} and ${locale}.`
      );
    }

    localeCodesByCase.set(caseKey, locale);

    let canonicalLocale;

    try {
      [canonicalLocale] = Intl.getCanonicalLocales(locale);
    } catch {
      throw new Error(`Locale code "${locale}" is not valid BCP 47.`);
    }

    if (canonicalLocale !== locale) {
      throw new Error(
        `Locale code "${locale}" must use canonical BCP 47 form "${canonicalLocale}".`
      );
    }

    if (!isRecord(value)) {
      throw new Error(`Locale "${locale}" configuration must be an object.`);
    }

    const { dir, label } = value;

    if (typeof label !== "string" || label.trim().length === 0) {
      throw new Error(`Locale "${locale}" label must be a non-empty string.`);
    }

    if (typeof dir !== "string" || !LOCALE_DIRECTIONS.has(dir)) {
      throw new Error(`Locale "${locale}" dir must be "ltr" or "rtl".`);
    }

    validatedLocales[locale] = {
      label: label.trim(),
      dir,
    };
  }

  if (!Object.hasOwn(validatedLocales, defaultLocale)) {
    throw new Error(
      `Default locale "${defaultLocale}" must exist in the locale registry.`
    );
  }

  return {
    defaultLocale,
    locales: validatedLocales,
  };
}
