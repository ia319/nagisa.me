import type { CollectionEntry } from "astro:content";
import { BLOG_PATH } from "@/content.config";
import type { Locale } from "@/i18n/config";
import {
  getRelativeContentFilePath,
  getSourceIdFromContentFilePath,
  parseLocalizedSourceId,
  validateLocalizedSourceIds,
  type ParsedLocalizedSourceId,
} from "./contentSource";

type BlogPost = CollectionEntry<"blog">;
export type BlogPostReference = Pick<BlogPost, "id" | "filePath">;

type ParsedPostId = ParsedLocalizedSourceId;

export type PostSource = ParsedPostId & {
  sourceId: string;
  slug: string;
  directorySegments: string[];
};

export function parsePostId(id: string): ParsedPostId {
  return parseLocalizedSourceId(id);
}

export function getRelativeBlogFilePath(filePath: string | undefined) {
  return getRelativeContentFilePath(filePath, BLOG_PATH);
}

function getSourceIdFromFilePath(filePath: string | undefined) {
  return getSourceIdFromContentFilePath(filePath, BLOG_PATH);
}

export function getPostSourceId(postOrId: BlogPostReference | string) {
  if (typeof postOrId === "string") return postOrId;

  const sourceId = getSourceIdFromFilePath(postOrId.filePath);

  if (!sourceId) {
    throw new Error(
      `Unable to resolve blog source path for post "${postOrId.id}". ` +
        `Expected filePath to point inside ${BLOG_PATH}.`
    );
  }

  return sourceId;
}

export function getPostSource(
  postOrId: BlogPostReference | string
): PostSource {
  const sourceId = getPostSourceId(postOrId);
  const parsedPostId = parsePostId(sourceId);
  const baseIdSegments = parsedPostId.baseId.split("/").filter(Boolean);
  const slug = baseIdSegments.pop() ?? parsedPostId.baseId;

  return {
    ...parsedPostId,
    sourceId,
    slug,
    directorySegments: baseIdSegments,
  };
}

export function getPostLocale(postOrId: BlogPostReference | string): Locale {
  return getPostSource(postOrId).locale;
}

export function getPostBaseId(postOrId: BlogPostReference | string) {
  return getPostSource(postOrId).baseId;
}

export function filterPostsByLocale(posts: BlogPost[], locale: Locale) {
  return posts.filter(post => getPostLocale(post) === locale);
}

/**
 * Validate every blog source before routes select individual language variants.
 * @param posts Blog collection entries to validate.
 * @returns Nothing.
 * @throws {Error} When two files conflict or use an invalid localized filename.
 */
export function validatePostLocalizations(posts: BlogPost[]): void {
  validateLocalizedSourceIds(posts.map(getPostSourceId));
}

/**
 * Index the available translations that share a post's base path.
 * @param posts Blog collection entries containing possible translations.
 * @param post Post whose translations should be selected.
 * @returns Available translations keyed by locale.
 * @throws {Error} When localized source identities are invalid.
 */
export function getPostTranslations(posts: BlogPost[], post: BlogPost) {
  validatePostLocalizations(posts);
  const baseId = getPostBaseId(post);
  const translations = new Map<Locale, BlogPost>();

  for (const candidate of posts) {
    if (getPostBaseId(candidate) !== baseId) continue;
    translations.set(getPostLocale(candidate), candidate);
  }

  return translations;
}
