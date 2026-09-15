export const TRANSLATION_PROVIDER = "ollama";

export const TRANSLATION_FIELD_ACTION = /** @type {const} */ ({
  TRANSLATE: "translate",
  COPY: "copy",
  FORCE_DRAFT: "force-draft",
  OMIT: "omit",
  REBUILD: "rebuild",
  PRESERVE: "preserve",
});

export const TRANSLATION_FIELD_POLICY = Object.freeze(
  /** @type {const} */ ({
    author: TRANSLATION_FIELD_ACTION.COPY,
    pubDatetime: TRANSLATION_FIELD_ACTION.COPY,
    modDatetime: TRANSLATION_FIELD_ACTION.COPY,
    title: TRANSLATION_FIELD_ACTION.TRANSLATE,
    featured: TRANSLATION_FIELD_ACTION.COPY,
    draft: TRANSLATION_FIELD_ACTION.FORCE_DRAFT,
    tags: TRANSLATION_FIELD_ACTION.TRANSLATE,
    ogImage: TRANSLATION_FIELD_ACTION.COPY,
    description: TRANSLATION_FIELD_ACTION.TRANSLATE,
    canonicalURL: TRANSLATION_FIELD_ACTION.OMIT,
    hideEditPost: TRANSLATION_FIELD_ACTION.COPY,
    timezone: TRANSLATION_FIELD_ACTION.COPY,
    translation: TRANSLATION_FIELD_ACTION.REBUILD,
  })
);

export const TRANSLATION_MARKDOWN_BODY_ACTION =
  TRANSLATION_FIELD_ACTION.TRANSLATE;

export const TRANSLATION_FRONTMATTER_OVERRIDES = Object.freeze({
  draft: true,
});

/**
 * Resolve how the translation generator must handle a frontmatter field.
 * Unknown fields are preserved in the output without being sent to the model.
 * @param {string} field Frontmatter field name.
 * @returns {(typeof TRANSLATION_FIELD_ACTION)[keyof typeof TRANSLATION_FIELD_ACTION]} Field action.
 */
export function getTranslationFieldAction(field) {
  return Object.hasOwn(TRANSLATION_FIELD_POLICY, field)
    ? TRANSLATION_FIELD_POLICY[field]
    : TRANSLATION_FIELD_ACTION.PRESERVE;
}

/**
 * Resolve the source content declared by translation metadata.
 * @template {Readonly<{baseId: string, locale: string}>} T
 * @param {Readonly<{baseId: string, locale: string, translation?: {sourceLocale: string}}>} content Target content descriptor.
 * @param {readonly T[]} candidates Available localized content descriptors.
 * @returns {{status: "not-translated"} | {status: "source-is-target", sourceLocale: string} | {status: "missing-source", sourceLocale: string} | {status: "resolved", sourceLocale: string, source: T}} Source resolution result.
 */
export function resolveTranslationSource(content, candidates) {
  if (!content.translation) {
    return { status: "not-translated" };
  }

  const { sourceLocale } = content.translation;

  if (sourceLocale === content.locale) {
    return { status: "source-is-target", sourceLocale };
  }

  const source = candidates.find(
    candidate =>
      candidate.baseId === content.baseId && candidate.locale === sourceLocale
  );

  return source
    ? { status: "resolved", sourceLocale, source }
    : { status: "missing-source", sourceLocale };
}
