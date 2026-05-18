import type { Locale } from "@/i18n/config";
import { getPostLocale, getPostSource } from "./postI18n";
import { slugifyStr } from "./slugify";

type GetPathOptions = {
  includeBase?: boolean;
  includeLocale?: boolean;
  locale?: Locale;
};

function joinUrlPath(segments: (string | undefined)[]) {
  return `/${segments.filter(Boolean).join("/")}`;
}

export type PostDirectorySegment = {
  name: string;
  slug: string;
};

export function getPostDirectorySegments(
  id: string,
  filePath: string | undefined
): PostDirectorySegment[] {
  return getPostSource({ id, filePath })
    .directorySegments.filter(segment => !segment.startsWith("_"))
    .map(segment => ({ name: segment, slug: slugifyStr(segment) }));
}

export function getPostRoutePath(id: string, filePath: string | undefined) {
  const postSource = getPostSource({ id, filePath });
  const pathSegments = getPostDirectorySegments(id, filePath).map(
    segment => segment.slug
  );
  const slug = slugifyStr(postSource.slug);

  return [...pathSegments, slug].filter(Boolean).join("/");
}

/**
 * Get full path of a blog post
 * @param id - id of the blog post (aka slug)
 * @param filePath - the blog post full file location
 * @param options - controls base path and locale prefix generation
 * @returns blog post path
 */
export function getPath(
  id: string,
  filePath: string | undefined,
  options: boolean | GetPathOptions = {}
) {
  const normalizedOptions =
    typeof options === "boolean"
      ? { includeBase: options, includeLocale: false }
      : options;

  const {
    includeBase = true,
    includeLocale = true,
    locale = getPostLocale({ id, filePath }),
  } = normalizedOptions;

  const postRoutePath = getPostRoutePath(id, filePath);

  const basePath = includeBase ? "posts" : "";

  const localePath = includeLocale ? locale : "";

  return joinUrlPath([localePath, basePath, postRoutePath]);
}
