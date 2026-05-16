import { BLOG_PATH } from "@/content.config";
import type { Locale } from "@/i18n/config";
import { getPostLocale, stripLocaleFromPostSlug } from "./postI18n";
import { slugifyStr } from "./slugify";

type GetPathOptions = {
  includeBase?: boolean;
  includeLocale?: boolean;
  locale?: Locale;
};

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
    locale = getPostLocale(id),
  } = normalizedOptions;

  const pathSegments = filePath
    ?.replaceAll("\\", "/")
    .replace(BLOG_PATH, "")
    .split("/")
    .filter(path => path !== "") // remove empty string in the segments ["", "other-path"] <- empty string will be removed
    .filter(path => !path.startsWith("_")) // exclude directories start with underscore "_"
    .slice(0, -1) // remove the last segment_ file name_ since it's unnecessary
    .map(segment => slugifyStr(segment)); // slugify each segment path

  const basePath = includeBase ? "posts" : "";

  // Making sure `id` does not contain the directory
  const blogId = id.split("/");
  const rawSlug = blogId.length > 0 ? blogId.slice(-1).join("") : id;
  const slug = stripLocaleFromPostSlug(rawSlug);
  const localePath = includeLocale ? locale : "";

  // If not inside the sub-dir, simply return the file path
  if (!pathSegments || pathSegments.length < 1) {
    return ["", localePath, basePath, slug].filter(Boolean).join("/");
  }

  return ["", localePath, basePath, ...pathSegments, slug]
    .filter(Boolean)
    .join("/");
}
