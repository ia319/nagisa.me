import type { CollectionEntry } from "astro:content";
import { PAGES_PATH } from "@/content.config";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import {
  getRelativeContentFilePath,
  getSourceIdFromContentFilePath,
  parseLocalizedSourceId,
  type ParsedLocalizedSourceId,
} from "./contentSource";

type PageContent = CollectionEntry<"pages">;
export type PageContentReference = Pick<PageContent, "id" | "filePath">;

type ParsedPageContentId = ParsedLocalizedSourceId;

export function parsePageContentId(id: string): ParsedPageContentId {
  return parseLocalizedSourceId(id);
}

export function getRelativePageContentFilePath(filePath: string | undefined) {
  return getRelativeContentFilePath(filePath, PAGES_PATH);
}

function getSourceIdFromFilePath(filePath: string | undefined) {
  return getSourceIdFromContentFilePath(filePath, PAGES_PATH);
}

export function getPageContentSourceId(
  pageContentOrId: PageContentReference | string
) {
  if (typeof pageContentOrId === "string") return pageContentOrId;

  const sourceId = getSourceIdFromFilePath(pageContentOrId.filePath);

  if (!sourceId) {
    throw new Error(
      `Unable to resolve page content source path for "${pageContentOrId.id}". ` +
        `Expected filePath to point inside ${PAGES_PATH}.`
    );
  }

  return sourceId;
}

export function getPageContentLocale(
  pageContentOrId: PageContentReference | string
) {
  return parsePageContentId(getPageContentSourceId(pageContentOrId)).locale;
}

export function getPageContentBaseId(
  pageContentOrId: PageContentReference | string
) {
  return parsePageContentId(getPageContentSourceId(pageContentOrId)).baseId;
}

export function findLocalizedPageContent(
  pageContents: PageContent[],
  baseId: string,
  locale: Locale
) {
  const currentLocaleContent = pageContents.find(
    pageContent =>
      getPageContentBaseId(pageContent) === baseId &&
      getPageContentLocale(pageContent) === locale
  );

  if (currentLocaleContent) return currentLocaleContent;

  return pageContents.find(
    pageContent =>
      getPageContentBaseId(pageContent) === baseId &&
      getPageContentLocale(pageContent) === DEFAULT_LOCALE
  );
}
