import type { CollectionEntry } from "astro:content";
import type { Locale } from "@/i18n/config";
import getSortedPosts from "./getSortedPosts";

const getPostsByTag = (
  posts: CollectionEntry<"blog">[],
  tag: string,
  locale?: Locale
) =>
  getSortedPosts(
    posts.filter(post => post.data.tags.includes(tag)),
    locale
  );

export default getPostsByTag;
