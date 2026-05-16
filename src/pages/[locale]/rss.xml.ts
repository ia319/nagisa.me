import type { APIRoute } from "astro";
import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { getPath } from "@/utils/getPath";
import getSortedPosts from "@/utils/getSortedPosts";
import { normalizeLocale, SUPPORTED_LOCALES } from "@/i18n/config";
import { SITE } from "@/config";

export function getStaticPaths() {
  return SUPPORTED_LOCALES.map(locale => ({
    params: { locale },
  }));
}

export const GET: APIRoute = async ({ params }) => {
  const locale = normalizeLocale(params.locale);
  const posts = await getCollection("blog");
  const sortedPosts = getSortedPosts(posts, locale);

  return rss({
    title: SITE.title,
    description: SITE.desc,
    site: SITE.website,
    items: sortedPosts.map(({ data, id, filePath }) => ({
      link: getPath(id, filePath, { locale }),
      title: data.title,
      description: data.description,
      pubDate: new Date(data.modDatetime ?? data.pubDatetime),
    })),
  });
};
