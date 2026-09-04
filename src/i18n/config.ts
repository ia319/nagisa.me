import localeRegistry from "../../locales.config.mjs";

export type Locale = keyof typeof localeRegistry.locales;
export type LocaleDirection = (typeof localeRegistry.locales)[Locale]["dir"];

export const DEFAULT_LOCALE: Locale = localeRegistry.defaultLocale;
export const SUPPORTED_LOCALES = Object.freeze(
  Object.keys(localeRegistry.locales) as Locale[]
);
export const LOCALE_LABELS = Object.fromEntries(
  SUPPORTED_LOCALES.map(locale => [
    locale,
    localeRegistry.locales[locale].label,
  ])
) as Record<Locale, string>;
export const LOCALE_DIRECTIONS = Object.fromEntries(
  SUPPORTED_LOCALES.map(locale => [locale, localeRegistry.locales[locale].dir])
) as Record<Locale, LocaleDirection>;

export function isLocale(value: string | undefined): value is Locale {
  return SUPPORTED_LOCALES.some(locale => locale === value);
}

export function normalizeLocale(value: string | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * Resolve the configured writing direction for a locale.
 * @param locale Configured locale code.
 * @returns The locale writing direction.
 */
export function getLocaleDirection(locale: Locale): LocaleDirection {
  return LOCALE_DIRECTIONS[locale];
}
