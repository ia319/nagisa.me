import { DEFAULT_LOCALE, isLocale, type Locale } from "./config";

function normalizePath(pathname: string) {
  if (!pathname) return "/";
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return path.replace(/\/{2,}/g, "/");
}

export function getLocaleFromPathname(pathname: string): Locale {
  const [firstSegment] = normalizePath(pathname).split("/").filter(Boolean);
  return isLocale(firstSegment) ? firstSegment : DEFAULT_LOCALE;
}

export function stripLocaleFromPathname(pathname: string) {
  const segments = normalizePath(pathname).split("/").filter(Boolean);
  if (isLocale(segments[0])) {
    segments.shift();
  }
  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

export function getLocalizedPath(locale: Locale, pathname = "/") {
  const cleanPath = stripLocaleFromPathname(pathname);
  return cleanPath === "/" ? `/${locale}/` : `/${locale}${cleanPath}`;
}

export function switchLocaleInPath(pathname: string, locale: Locale) {
  return getLocalizedPath(locale, pathname);
}
