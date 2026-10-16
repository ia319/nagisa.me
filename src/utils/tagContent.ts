import type { CollectionEntry } from "astro:content";
import { TAGS_PATH } from "@/content.config";
import type { Locale } from "@/i18n/config";
import {
  getSourceIdFromContentFilePath,
  validateLocalizedSourceIds,
} from "./contentSource";
import { isTagSegment } from "./localizedTags.mjs";

/** Validate physical filenames before selecting a language or filtering drafts. */
export function getTagDefinitions(entries: CollectionEntry<"tags">[]) {
  const sourceIds = entries.map(entry => {
    const sourceId = getSourceIdFromContentFilePath(entry.filePath, TAGS_PATH);
    if (!sourceId)
      throw new Error(
        `Unable to resolve tag source path: ${entry.filePath ?? entry.id}`
      );
    return sourceId;
  });
  const identities = validateLocalizedSourceIds(sourceIds);
  return entries.map((entry, index) => {
    const { baseId: id, locale } = identities[index];
    if (!isTagSegment(id))
      throw new Error(
        `Invalid tag ID ${JSON.stringify(id)} in ${entry.filePath}`
      );
    return { id, locale, ...entry.data, entry };
  });
}

/** Resolve only published metadata in the requested language; no language fallback. */
export function resolveTagDefinition(
  definitions: ReturnType<typeof getTagDefinitions>,
  id: string,
  locale: Locale
) {
  return definitions.find(
    item => item.id === id && item.locale === locale && !item.draft
  );
}
