import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
import { SITE } from "@/config";
import { isLocale, SUPPORTED_LOCALES, type Locale } from "@/i18n/config";
import { TRANSLATION_PROVIDER } from "@/content/translationContract.mjs";

export const BLOG_PATH = "src/data/blog";
export const PAGES_PATH = "src/data/pages";

const translationSchema = z
  .object({
    sourceLocale: z.custom<Locale>(
      value => typeof value === "string" && isLocale(value),
      {
        message: `translation.sourceLocale must be one of: ${SUPPORTED_LOCALES.join(", ")}`,
      }
    ),
    provider: z.literal(TRANSLATION_PROVIDER),
    model: z
      .string()
      .min(1, "translation.model must not be empty")
      .refine(value => value.trim() === value, {
        message: "translation.model must not have surrounding whitespace",
      }),
  })
  .strict();

const blog = defineCollection({
  loader: glob({ pattern: "**/[^_]*.md", base: `./${BLOG_PATH}` }),
  schema: ({ image }) =>
    z.object({
      author: z.string().default(SITE.author),
      pubDatetime: z.date(),
      modDatetime: z.date().optional().nullable(),
      title: z.string(),
      featured: z.boolean().optional(),
      draft: z.boolean().optional(),
      tags: z.array(z.string()).default(["others"]),
      ogImage: image().or(z.string()).optional(),
      description: z.string(),
      canonicalURL: z.string().optional(),
      hideEditPost: z.boolean().optional(),
      timezone: z.string().optional(),
      translation: translationSchema.optional(),
    }),
});

const pages = defineCollection({
  loader: glob({ pattern: "**/[^_]*.md", base: `./${PAGES_PATH}` }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
  }),
});

export const collections = { blog, pages };
