export const DEFAULT_LOCALE = "zh";

export const SUPPORTED_LOCALES = ["zh", "en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  zh: "中文",
  en: "English",
};

export function isLocale(value: string | undefined): value is Locale {
  return SUPPORTED_LOCALES.some(locale => locale === value);
}

export function normalizeLocale(value: string | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
