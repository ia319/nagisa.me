import type { Locale } from "./config";

/**
 * Format a post date with the active locale and content timezone.
 * @param value Date value to format.
 * @param locale Active locale.
 * @param timeZone IANA timezone used by the content.
 * @returns Localized post date.
 */
export function formatPostDate(
  value: Date,
  locale: Locale,
  timeZone: string
): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(value);
}

/**
 * Format a one-based calendar month with the active locale.
 * @param month One-based calendar month.
 * @param locale Active locale.
 * @returns Localized full month name.
 * @throws {RangeError} When the month is outside 1 through 12.
 */
export function formatMonthName(month: number, locale: Locale): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(
      `Month must be an integer from 1 through 12: ${month}`
    );
  }

  return new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, month - 1, 1)));
}
