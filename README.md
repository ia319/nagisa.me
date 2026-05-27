## Branches

- `main`: blog content branch.
- `dev`: feature development branch without blog content.

Astro site starter.

## Feature Changes

Review the following feature changes from the upstream project:

### Post Directory Tree

Post directory tree renders blog posts by their source directory structure and keeps localized directory labels aligned with available intro content.

- Read nested directory structures under `src/data/blog`.
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

Default config in `src/config.ts`:

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

Language routing and switching renders locale-prefixed pages, detects post locales from source filenames, and provides language navigation across available translations.

- Use `/zh/` and `/en/` as language page prefixes.
- Provide a language switcher in the header with the existing icon component system.
- Generate language links from available post translations on post detail pages, and fall back to the target locale post list when a translation is missing.
- Route the root path `/` on Vercel by `preferred_locale` cookie, browser `Accept-Language`, then default locale order.
- Keep the root path `/` unchanged on Vercel through internal routing to the matching locale homepage.
- Store the `preferred_locale` cookie after language selection.
- Render the default locale homepage at `/` in local and non-Vercel environments.

Language config in `src/i18n/config.ts`:

```ts
export const DEFAULT_LOCALE = "zh";

export const SUPPORTED_LOCALES = ["zh", "en"] as const;
```

#### Localized Page Content

Localized page content renders page-level Markdown from `src/data/pages` with locale-aware lookup and default-locale fallback.

- Store page-level Markdown content in `src/data/pages`.
- Use `src/data/pages/home-intro.md` for homepage intro content.
- Use `src/data/pages/about.md` for About page content.
- Mark localized page content with filename suffixes such as `src/data/pages/home-intro.en.md` and `src/data/pages/about.en.md`.
- Treat files without locale suffixes as `DEFAULT_LOCALE` content.
- Read page titles from the Markdown frontmatter `title` field.
- Read page descriptions from the Markdown frontmatter `description` field.
- Use About page frontmatter for page title, SEO description, and share metadata.
- Support Markdown headings, body content, lists, and links in homepage intro content.
- Use localized About content instead of the legacy root About Markdown entry.

### Content Git Metadata

Content Git metadata displays Git-based provenance after Markdown content, including the first committed time, the edited time, and the related commit hash. Build output reads a committed manifest instead of executing Git commands during Vercel builds.

- Render metadata after blog post content and localized page content.
- Show the first committed time for each Markdown file.
- Show the edited time only when the latest content commit differs from the first content commit.
- Link rendered hashes to repository commits when `SITE.repository` is set.
- Show `Unknown` when the manifest has no reliable entry for the content file.
- Normalize repository URLs without a protocol to `https://`.
- Accept SHA-1 and SHA-256 commit hashes.
- Read only relative content paths from `src/generated/contentGitMetaManifest.json`.
- Skip manifest loading when `SITE.contentGitMeta.enabled` is `false`.

#### Usage

1. Commit content changes.
2. Run the manifest generator in a full local Git clone.

```sh
pnpm content:git-meta
```

3. Commit `src/generated/contentGitMetaManifest.json` separately.

Default config in `src/config.ts`:

```ts
export const SITE = {
  repository: "", // repository root URL, e.g. "https://github.com/owner/repo"
  contentGitMeta: {
    enabled: false, // show content Git metadata from src/generated/contentGitMetaManifest.json
  },
};
```

### Build Compatibility

Build compatibility keeps generated search assets portable across local and Windows builds.

- Copy Pagefind output with a cross-platform command to support Windows builds.
