import type { APIRoute } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";
import { getPostRoutePath } from "@/utils/getPath";
import { generateOgImageForPost } from "@/utils/generateOgImages";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { getPostLocale } from "@/utils/postI18n";
import { SITE } from "@/config";

export async function getStaticPaths() {
  if (!SITE.dynamicOgImage) {
    return [];
  }

  const posts = await getCollection("blog").then(p =>
    p.filter(
      post =>
        !post.data.draft &&
        !post.data.ogImage &&
        getPostLocale(post) === DEFAULT_LOCALE
    )
  );

  return posts.map(post => ({
    params: {
      slug: getPostRoutePath(post.id, post.filePath),
    },
    props: post,
  }));
}

export const GET: APIRoute = async ({ props }) => {
  if (!SITE.dynamicOgImage) {
    return new Response(null, {
      status: 404,
      statusText: "Not found",
    });
  }

  const buffer = await generateOgImageForPost(props as CollectionEntry<"blog">);
  return new Response(new Uint8Array(buffer), {
    headers: { "Content-Type": "image/png" },
  });
};
