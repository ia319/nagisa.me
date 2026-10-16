import type { CollectionEntry } from "astro:content";
import { SUPPORTED_LOCALES, type Locale } from "@/i18n/config";
import { getLocalizedPath } from "@/i18n/routes";
import { getTagAliases, getTagReferenceDiagnostics } from "./localizedTags.mjs";
import { getTagDefinitions, resolveTagDefinition } from "./tagContent";
import getSortedPosts from "./getSortedPosts";
import getUniqueTags from "./getUniqueTags";
import { validatePostLocalizations } from "./postI18n";

export type TagRoute = {
  locale: Locale;
  tag: string;
  tagName: string;
  count: number;
  description?: string;
  entry?: CollectionEntry<"tags">;
};

/** Build routes from public articles, with metadata selected by fixed ID and language. */
export function getTagIndex(
  posts: CollectionEntry<"blog">[],
  entries: CollectionEntry<"tags">[]
) {
  validatePostLocalizations(posts);
  const definitions = getTagDefinitions(entries);
  const knownIds = new Set(definitions.map(item => item.id));
  const diagnostics = getTagReferenceDiagnostics(
    posts.map(post => ({
      path: post.filePath ?? post.id,
      tags: post.data.tags,
    })),
    knownIds
  );
  const publicPosts = getSortedPosts(posts);
  const tags: TagRoute[] = SUPPORTED_LOCALES.flatMap(locale =>
    getUniqueTags(publicPosts, locale).map(({ tag, count }) => {
      const definition = resolveTagDefinition(definitions, tag, locale);
      return {
        locale,
        tag,
        count,
        tagName: definition?.name ?? tag,
        description: definition?.description,
        entry: definition?.entry,
      };
    })
  );
  // Static output must remain distinct on case-insensitive file systems.
  const routesByCase = new Map<string, string>();
  for (const { locale, tag } of tags) {
    const key = JSON.stringify([locale, tag.normalize("NFC").toLowerCase()]);
    const other = routesByCase.get(key);
    if (other !== undefined && other !== tag)
      throw new Error(
        `Tag routes ${JSON.stringify(other)} and ${JSON.stringify(tag)} collide in locale ${JSON.stringify(locale)} on case-insensitive file systems`
      );
    routesByCase.set(key, tag);
  }
  const reservedIds = new Set([
    ...knownIds,
    ...posts.flatMap(post => post.data.tags),
  ]);
  const legacy = getTagAliases(definitions, tags, reservedIds);
  return {
    posts: publicPosts,
    tags,
    aliases: legacy.aliases,
    diagnostics: [...diagnostics, ...legacy.diagnostics],
  };
}

/** Link to the same ID only when that language has a public route. */
export function getTagLanguageLinks(
  index: ReturnType<typeof getTagIndex>,
  tag: TagRoute
) {
  const links: Partial<Record<Locale, string>> = {};
  for (const locale of SUPPORTED_LOCALES) {
    const exists = index.tags.some(
      item => item.locale === locale && item.tag === tag.tag
    );
    links[locale] = getLocalizedPath(
      locale,
      exists ? `/tags/${encodeURIComponent(tag.tag)}/` : "/tags/"
    );
  }
  return links;
}
