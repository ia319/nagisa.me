import type { CollectionEntry } from "astro:content";
import type { Locale } from "@/i18n/config";
import { getPostLocale } from "./postI18n";

/** Count each public article once per ID, preserving the literal route segment. */
const getUniqueTags = (posts: CollectionEntry<"blog">[], locale: Locale) => {
  const counts = new Map<string, number>();
  for (const post of posts) {
    if (getPostLocale(post) !== locale) continue;
    for (const tag of new Set(post.data.tags))
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, count]) => ({ tag, count }));
};

export default getUniqueTags;
