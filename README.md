Astro site starter.

## Feature Changes

Review the following feature changes from the upstream project:

### Post Directory Tree

- Read nested directory structures under `src/data/blog`.
- Render posts by directory hierarchy instead of a flat post list.
- Pin `README.md` as the directory intro post.
- Resolve directory labels from the current locale intro title, then the default locale intro title, then the folder name.
- Treat files without locale suffixes as `DEFAULT_LOCALE` posts and intro posts.
- Limit the initial number of direct child directories and direct posts per directory through config.
- Collapse overflow directories and posts behind disclosure controls.
- Collapse and expand each directory independently.
- Filter posts by current locale by default, and enable default locale post fallback through config.
- Route fallback posts to their real source locale paths.
- Resolve post locale and route from the blog-relative source path.
- Generate post links as root-absolute paths to avoid duplicate locale prefixes in nested routes.

Use the default config in `src/config.ts`:

```ts
export const SITE = {
  postsTree: {
    maxSubdirectoriesPerDirectory: 6,
    maxPostsPerDirectory: 4,
    directoryIntroFileName: "README",
    directoryLabelFallback: "default-locale", // "default-locale" | "none"
    postLocaleFallback: "none", // "none" | "default-locale"
  },
};
```

### Language Routing And Switching

- Use `/zh/` and `/en/` as language page prefixes.
- Detect post locale from the blog filename suffix, and treat files without locale suffixes as `DEFAULT_LOCALE` posts.
- Provide a language switcher in the header with the existing icon component system.
- Generate language links from available post translations on post detail pages, and fall back to the target locale post list when a translation is missing.
- Route the root path `/` on Vercel by `preferred_locale` cookie, browser `Accept-Language`, then default locale order.
- Keep the root path `/` unchanged on Vercel through internal routing to the matching locale homepage.
- Store the `preferred_locale` cookie after language selection.
- Render the default locale homepage at `/` in local and non-Vercel environments.

Use the language config in `src/i18n/config.ts`:

```ts
export const DEFAULT_LOCALE = "zh";

export const SUPPORTED_LOCALES = ["zh", "en"] as const;
```

### Build Compatibility

- Copy Pagefind output with a cross-platform command to support Windows builds.
