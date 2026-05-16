import type { CollectionEntry } from "astro:content";
import type { Locale } from "@/i18n/config";
import { filterPostsByLocale } from "./postI18n";
import postFilter from "./postFilter";

const getSortedPosts = (posts: CollectionEntry<"blog">[], locale?: Locale) => {
  const targetPosts = locale ? filterPostsByLocale(posts, locale) : posts;

  return targetPosts
    .filter(postFilter)
    .sort(
      (a, b) =>
        Math.floor(
          new Date(b.data.modDatetime ?? b.data.pubDatetime).getTime() / 1000
        ) -
        Math.floor(
          new Date(a.data.modDatetime ?? a.data.pubDatetime).getTime() / 1000
        )
    );
};

export default getSortedPosts;
