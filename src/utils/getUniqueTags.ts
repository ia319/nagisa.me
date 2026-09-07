import type { CollectionEntry } from "astro:content";
import type { Locale } from "@/i18n/config";
import { getTagIndex } from "./getTagIndex";

const getUniqueTags = (posts: CollectionEntry<"blog">[], locale: Locale) => {
  return getTagIndex(posts)
    .tags.filter(tag => tag.locale === locale)
    .map(({ tag, tagName }) => ({ tag, tagName }));
};

export default getUniqueTags;
