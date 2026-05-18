import type { CollectionEntry } from "astro:content";
import { BLOG_PATH } from "@/content.config";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";

type BlogPost = CollectionEntry<"blog">;
export type BlogPostReference = Pick<BlogPost, "id" | "filePath">;

type ParsedPostId = {
  baseId: string;
  locale: Locale;
};

export type PostSource = ParsedPostId & {
  sourceId: string;
  slug: string;
  directorySegments: string[];
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

export function getRelativeBlogFilePath(filePath: string | undefined) {
  if (!filePath) return undefined;

  const normalizedFilePath = filePath.replaceAll("\\", "/");
  const normalizedBlogPath = BLOG_PATH.replaceAll("\\", "/").replace(
    /^\.?\//,
    ""
  );
  const blogPathIndex = normalizedFilePath.indexOf(`${normalizedBlogPath}/`);

  if (blogPathIndex < 0) return undefined;

  return normalizedFilePath.slice(
    blogPathIndex + normalizedBlogPath.length + 1
  );
}

function getSourceIdFromFilePath(filePath: string | undefined) {
  const relativeFilePath = getRelativeBlogFilePath(filePath);

  return relativeFilePath?.replace(/\.[^/.]+$/, "");
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
