import type { CollectionEntry } from "astro:content";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";

type BlogPost = CollectionEntry<"blog">;

type ParsedPostId = {
  baseId: string;
  locale: Locale;
};

export function parsePostId(id: string): ParsedPostId {
  const pathSegments = id.split("/");
  const filename = pathSegments.pop() ?? id;
  const match = filename.match(/^(.*)\.([^.]+)$/);

  if (!match || !isLocale(match[2])) {
    return { baseId: id, locale: DEFAULT_LOCALE };
  }

  const baseFilename = match[1];
  const baseId = [...pathSegments, baseFilename].filter(Boolean).join("/");
  return { baseId, locale: match[2] };
}

export function getPostLocale(postOrId: BlogPost | string): Locale {
  const id = typeof postOrId === "string" ? postOrId : postOrId.id;
  return parsePostId(id).locale;
}

export function getPostBaseId(postOrId: BlogPost | string) {
  const id = typeof postOrId === "string" ? postOrId : postOrId.id;
  return parsePostId(id).baseId;
}

export function stripLocaleFromPostSlug(slug: string) {
  const match = slug.match(/^(.*)\.([^.]+)$/);
  return match && isLocale(match[2]) ? match[1] : slug;
}

export function filterPostsByLocale(posts: BlogPost[], locale: Locale) {
  return posts.filter(post => getPostLocale(post) === locale);
}

export function findPostTranslation(
  posts: BlogPost[],
  post: BlogPost,
  locale: Locale
) {
  const baseId = getPostBaseId(post);
  return posts.find(
    candidate =>
      getPostBaseId(candidate) === baseId && getPostLocale(candidate) === locale
  );
}
