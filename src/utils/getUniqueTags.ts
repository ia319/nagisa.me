import type { CollectionEntry } from "astro:content";
import type { Locale } from "@/i18n/config";
import { filterPostsByLocale } from "./postI18n";
import { slugifyStr } from "./slugify";
import postFilter from "./postFilter";

interface Tag {
  tag: string;
  tagName: string;
}

const getUniqueTags = (posts: CollectionEntry<"blog">[], locale?: Locale) => {
  const targetPosts = locale ? filterPostsByLocale(posts, locale) : posts;

  const tags: Tag[] = targetPosts
    .filter(postFilter)
    .flatMap(post => post.data.tags)
    .map(tag => ({ tag: slugifyStr(tag), tagName: tag }))
    .filter(
      (value, index, self) =>
        self.findIndex(tag => tag.tag === value.tag) === index
    )
    .sort((tagA, tagB) => tagA.tag.localeCompare(tagB.tag));
  return tags;
};

export default getUniqueTags;
