import type { CollectionEntry } from "astro:content";
import { SUPPORTED_LOCALES, type Locale } from "@/i18n/config";
import { getLocalizedPath } from "@/i18n/routes";
import { buildTagRelations, resolveTagTranslation } from "./localizedTags.mjs";
import getSortedPosts from "./getSortedPosts";
import { getPostSource, validatePostLocalizations } from "./postI18n";

export type TagRoute = { locale: Locale; tag: string; tagName: string };

/**
 * Adapt public blog entries to the shared tag relationship and route contract.
 * @param posts Blog entries, including drafts and scheduled posts.
 * @returns Public sorted posts, localized tag routes, and relationship diagnostics.
 * @throws {Error} When content identities or public tag routes conflict.
 */
export function getTagIndex(posts: CollectionEntry<"blog">[]) {
  validatePostLocalizations(posts);
  const publicPosts = getSortedPosts(posts);
  const relations = buildTagRelations(
    publicPosts.map(post => {
      const { baseId, locale } = getPostSource(post);
      return {
        baseId,
        locale,
        tags: post.data.tags,
        translation: post.data.translation,
      };
    })
  );
  const tags: TagRoute[] = SUPPORTED_LOCALES.flatMap(locale =>
    relations.tags
      .filter(tag => tag.locale === locale)
      .map(tag => ({ locale, tag: tag.slug, tagName: tag.tag }))
      .sort((a, b) => a.tag.localeCompare(b.tag))
  );
  return { posts: publicPosts, tags, relations };
}

/**
 * Link each language to a unique public tag route or its tag collection.
 * @param index Public tag index used to generate the detail routes.
 * @param tag Current tag route from the same index.
 * @returns Language links and fallback diagnostics for build-time logging.
 */
export function getTagLanguageLinks(
  index: ReturnType<typeof getTagIndex>,
  tag: TagRoute
) {
  const links: Partial<Record<Locale, string>> = {};
  const diagnostics: string[] = [];
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === tag.locale) {
      links[locale] = getLocalizedPath(
        locale,
        `/tags/${encodeURIComponent(tag.tag)}/`
      );
      continue;
    }
    const translated = resolveTagTranslation(
      index.relations,
      tag.locale,
      tag.tagName,
      locale
    );
    const target =
      translated.status === "resolved"
        ? index.tags.find(
            item =>
              item.locale === locale && item.tagName === translated.value.tag
          )
        : undefined;
    if (target) {
      links[locale] = getLocalizedPath(
        locale,
        `/tags/${encodeURIComponent(target.tag)}/`
      );
    } else {
      links[locale] = getLocalizedPath(locale, "/tags/");
      const reason =
        translated.status === "missing"
          ? translated.reason
          : translated.status === "resolved"
            ? "unreachable-target"
            : "ambiguous-mapping";
      diagnostics.push(
        `Tag language fallback: ${tag.locale}/${tag.tag} -> ${locale}/tags (${reason})`
      );
    }
  }
  return { links, diagnostics };
}
