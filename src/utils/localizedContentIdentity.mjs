function getLocaleSuffix(filename) {
  const match = filename.match(/^(.*)\.([^.]+)$/);

  return match ? { baseFilename: match[1], suffix: match[2] } : undefined;
}

function getCaseKey(value) {
  return value.normalize("NFC").toLowerCase();
}

function getIdentityConfig(config) {
  const supportedLocales = [...config.supportedLocales];

  if (!supportedLocales.includes(config.defaultLocale)) {
    throw new Error(
      `Default locale "${config.defaultLocale}" must be included in supportedLocales.`
    );
  }

  return {
    defaultLocale: config.defaultLocale,
    supportedLocales,
    localesByCase: new Map(
      supportedLocales.map(locale => [getCaseKey(locale), locale])
    ),
  };
}

/**
 * Parse a content source ID without treating an unknown dotted suffix as a locale.
 * @param {string} sourceId Extension-free, content-root-relative source ID.
 * @param {{defaultLocale: string, supportedLocales: readonly string[]}} config Locale identity configuration.
 * @returns {{baseId: string, locale: string, hasLocaleSuffix: boolean}} Parsed localized content identity.
 * @throws {Error} When a locale suffix only differs from configured casing.
 */
export function parseLocalizedContentIdentity(sourceId, config) {
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw new Error("Content source ID must be a non-empty string.");
  }

  const identityConfig = getIdentityConfig(config);
  const pathSegments = sourceId.split("/");
  const filename = pathSegments.pop() ?? sourceId;
  const localeSuffix = getLocaleSuffix(filename);

  if (!localeSuffix) {
    return {
      baseId: sourceId,
      locale: identityConfig.defaultLocale,
      hasLocaleSuffix: false,
    };
  }

  const exactLocale = identityConfig.supportedLocales.find(
    locale => locale === localeSuffix.suffix
  );

  if (!exactLocale) {
    const caseMatchedLocale = identityConfig.localesByCase.get(
      getCaseKey(localeSuffix.suffix)
    );

    if (caseMatchedLocale) {
      throw new Error(
        `Locale suffix "${localeSuffix.suffix}" in "${sourceId}" must use configured casing "${caseMatchedLocale}".`
      );
    }

    return {
      baseId: sourceId,
      locale: identityConfig.defaultLocale,
      hasLocaleSuffix: false,
    };
  }

  if (localeSuffix.baseFilename.length === 0) {
    throw new Error(`Localized content source "${sourceId}" has no base name.`);
  }

  return {
    baseId: [...pathSegments, localeSuffix.baseFilename]
      .filter(Boolean)
      .join("/"),
    locale: exactLocale,
    hasLocaleSuffix: true,
  };
}

/**
 * Validate localized source IDs and return their parsed identities in input order.
 * @param {readonly string[]} sourceIds Extension-free source IDs to validate.
 * @param {{defaultLocale: string, supportedLocales: readonly string[]}} config Locale identity configuration.
 * @returns {{baseId: string, locale: string, hasLocaleSuffix: boolean}[]} Parsed identities.
 * @throws {Error} When default suffixes, duplicate variants, or case collisions exist.
 */
export function validateLocalizedContentIdentities(sourceIds, config) {
  const identities = sourceIds.map(sourceId => ({
    sourceId,
    parsed: parseLocalizedContentIdentity(sourceId, config),
  }));
  const baseIdsByCase = new Map();
  const sourceIdsByIdentity = new Map();

  for (const { sourceId, parsed } of identities) {
    if (parsed.hasLocaleSuffix && parsed.locale === config.defaultLocale) {
      throw new Error(
        `Default locale content "${sourceId}" must omit the ".${config.defaultLocale}" suffix.`
      );
    }

    const baseCaseKey = getCaseKey(parsed.baseId);
    const existingBaseId = baseIdsByCase.get(baseCaseKey);

    if (existingBaseId && existingBaseId !== parsed.baseId) {
      throw new Error(
        `Localized content base paths differ only by case: "${existingBaseId}" and "${parsed.baseId}".`
      );
    }

    baseIdsByCase.set(baseCaseKey, parsed.baseId);

    const identityKey = `${baseCaseKey}\0${getCaseKey(parsed.locale)}`;
    const existingSourceId = sourceIdsByIdentity.get(identityKey);

    if (existingSourceId) {
      throw new Error(
        `Localized content sources "${existingSourceId}" and "${sourceId}" define the same base path and locale.`
      );
    }

    sourceIdsByIdentity.set(identityKey, sourceId);
  }

  return identities.map(({ parsed }) => parsed);
}
