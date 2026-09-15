import { validateLocaleRegistry } from "./registry.mjs";

const ROOT_PATH_PATTERN = "^/$";
const ROOT_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-cache",
  Vary: "Cookie, Accept-Language",
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createHeaderPattern(locale) {
  const caseInsensitiveLocale = [...locale]
    .map(character => {
      if (!/[A-Za-z]/.test(character)) return character;
      return `[${character.toLowerCase()}${character.toUpperCase()}]`;
    })
    .join("");

  return `^${caseInsensitiveLocale}(?:[-,;\\s]|$)`;
}

/**
 * Create Vercel root routes for cookie and Accept-Language negotiation.
 * @param {unknown} registry Shared locale registry input.
 * @returns {object[]} Generated Vercel root routes.
 */
export function createRootLocaleRoutes(registry) {
  const validatedRegistry = validateLocaleRegistry(registry);
  const localeCodes = Object.keys(validatedRegistry.locales);
  const localeOrder = new Map(
    localeCodes.map((locale, index) => [locale, index])
  );
  const headerLocales = [...localeCodes].sort((localeA, localeB) => {
    const segmentDifference =
      localeB.split("-").length - localeA.split("-").length;

    if (segmentDifference !== 0) return segmentDifference;
    return localeOrder.get(localeA) - localeOrder.get(localeB);
  });

  const cookieRoutes = localeCodes.map(locale => ({
    src: ROOT_PATH_PATTERN,
    has: [
      {
        type: "cookie",
        key: "preferred_locale",
        value: { eq: locale },
      },
    ],
    headers: { ...ROOT_RESPONSE_HEADERS },
    dest: `/${locale}/`,
  }));
  const headerRoutes = headerLocales.map(locale => ({
    src: ROOT_PATH_PATTERN,
    has: [
      {
        type: "header",
        key: "accept-language",
        value: { re: createHeaderPattern(locale) },
      },
    ],
    headers: { ...ROOT_RESPONSE_HEADERS },
    dest: `/${locale}/`,
  }));

  return [
    ...cookieRoutes,
    ...headerRoutes,
    {
      src: ROOT_PATH_PATTERN,
      headers: { ...ROOT_RESPONSE_HEADERS },
      dest: `/${validatedRegistry.defaultLocale}/`,
    },
  ];
}

/**
 * Replace locale-owned root routes while preserving other Vercel settings.
 * @param {unknown} currentConfig Current Vercel configuration.
 * @param {unknown} registry Shared locale registry input.
 * @returns {Record<string, unknown>} Updated Vercel configuration.
 * @throws {Error} When the current routes field is invalid.
 */
export function createVercelConfig(currentConfig, registry) {
  if (!isRecord(currentConfig)) {
    throw new Error("Vercel configuration must be an object.");
  }

  const currentRoutes = currentConfig.routes ?? [];

  if (!Array.isArray(currentRoutes)) {
    throw new Error("Vercel configuration routes must be an array.");
  }

  const preservedRoutes = currentRoutes.filter(
    route => !isRecord(route) || route.src !== ROOT_PATH_PATTERN
  );

  return {
    ...currentConfig,
    routes: [...createRootLocaleRoutes(registry), ...preservedRoutes],
  };
}

/**
 * Serialize Vercel configuration using repository formatting rules.
 * @param {Record<string, unknown>} config Vercel configuration.
 * @returns {string} UTF-8 JSON text with LF and a final newline.
 */
export function serializeVercelConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
