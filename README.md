Astro site starter.

Commands below require Node.js and pnpm and run from the project root.

## Features

### Post Directory Tree

The tree follows the directory structure under `src/data/blog/`. Each directory
has independent controls for posts and subdirectories beyond the initial limits.
Directory intro posts appear first and do not count toward the post limit.

By default, `README.md` and its language variants in each article directory are
directory intro posts. Directory names use the first available value:

1. The opening YAML `title` of the intro matching the page's language.
2. The `title` of the default-language intro (`defaultLocale` in
   `locales.config.mjs`).
3. The folder name.

`directoryLabelFallback: "none"` skips the second step.

Posts appear in the page's language by default.
`postLocaleFallback: "default-locale"` fills missing versions with
default-language posts, retaining their source-language routes.

Default config in `src/config.ts`:

```ts
export const SITE = {
  postsTree: {
    maxSubdirectoriesPerDirectory: 6, // initial subdirectory limit; default: 6; values: number
    maxPostsPerDirectory: 4, // initial post limit, excluding intro; default: 4; values: number
    directoryIntroFileName: "README", // directory intro filename; default: "README"; values: filename without extension or locale suffix
    directoryLabelFallback: "default-locale", // directory label fallback; default: "default-locale"; values: "default-locale" | "none"
    postLocaleFallback: "none", // missing post translation fallback; default: "none"; values: "none" | "default-locale"
  },
};
```

### Language Routing And Switching

Each language has pages under `/<locale>/`. The header language switcher links
article translations; missing translations lead to the target language's post
list.

Blog and page content share these filename rules:

- Files without a language suffix belong to the default language.
  `.<locale>.md` suffixes identify any configured language, including the default.
- The content-relative path without the language suffix pairs translations.
- Unconfigured dotted suffixes remain part of the filename.

Duplicate language versions and base paths that differ only by case stop the
build.

#### Language Configuration

Default configuration in `locales.config.mjs`:

```js
const localeRegistry = /** @type {const} */ ({
  defaultLocale: "zh", // default language; default: "zh"; values: a key in locales
  locales: /* supported languages; default: zh, en; values: non-empty map */ {
    zh: {
      label: "中文", // display name; default: "中文"; values: non-empty string
      dir: "ltr", // text direction; default: "ltr"; values: "ltr" (left-to-right) | "rtl" (right-to-left)
    },
    en: {
      label: "English", // display name; default: "English"; values: non-empty string
      dir: "ltr", // text direction; default: "ltr"; values: "ltr" | "rtl"
    },
  },
});

export default localeRegistry;
```

Language codes use canonical BCP 47 form. Each language requires a complete
dictionary in `src/i18n/ui-dictionaries.mjs`.

Route synchronization and validation after configuration edits:

```sh
pnpm locales:generate
pnpm locales:check
```

Synchronization updates language routes in `vercel.json`, preserving other
settings. Production builds also check the language configuration and routes.

#### Root Language Selection

On Vercel, `/` selects a language in this order:

1. A configured language in the `preferred_locale` cookie.
2. A match at the start of `Accept-Language`, with more specific configured
   language codes first.
3. The default language.

Later header entries and quality weights are ignored. Language selection stores
the cookie for one year; clearing or expiring it restores header-based selection.
Vercel keeps `/` in the browser address. Other environments show the
default-language homepage.

#### Change the Default Locale

```text
pnpm locales:set-default <locale>
```

The command updates the default language, adds original-language suffixes to
unsuffixed blog and page files, and synchronizes deployment routes. File contents
remain unchanged.

Avoid concurrent content or configuration edits. Preflight failures leave files
unchanged; write failures retain completed changes and report a retry command.
After a manual or partial switch, `--from <locale>` identifies the original
language of remaining unsuffixed files.

#### Localized Page Content

Page Markdown lives under `src/data/pages/`:

- Homepage intro: `home-intro.md`.
- About page: `about.md`.

Content lookup prefers the page's language, then the default language. Conflict
checks cover the entire page collection, including unused content.

Frontmatter `title` and `description` supply page titles and descriptions;
About also uses them for SEO and sharing. The homepage intro supports Markdown.

#### Article Translation

`pnpm content:translate` uses a local Ollama model to create draft translations
of one Markdown article under `src/data/blog/`.

Requirements:

- Ollama on `PATH` and an installed local model.
- Configured source and target languages.

Translation covers `title`, `description`, `tags`, and the body. Drafts have
`draft: true`, omit `canonicalURL`, and record translation attribution. Other
frontmatter stays local and is preserved without being sent to the model.

##### Translation Configuration

Default configuration in `translation.config.mjs` at the project root:

```js
export default {
  model: "", // local Ollama model; default: "" (unset); values: model name string
  port: "auto", // Ollama service port; default: "auto"; values: "auto" | integer 1-65535 (not a numeric string)
};
```

Missing files or fields use these defaults. Priority, highest first:

- Model: `--model` → `OLLAMA_TRANSLATE_MODEL` → configuration `model`.
- Service: `--ollama-port` → `OLLAMA_HOST` → configuration `port` → `auto`.

Empty or whitespace-only environment values and configuration model values are
unset. A model is required; an unavailable selected model has no fallback.
Command options leave the configuration unchanged. Translation configuration
always comes from the working tree, including with `--staged`.

##### Usage

```text
pnpm content:translate -- <file> --to <locale> [options]
```

`--to` is repeatable for distinct target languages, each different from the
source language.

`--staged` replaces the file path and requires exactly one added, modified, or
renamed article in the Git index. The source, tracked reference articles, and
language configuration come from the index; output conflict checks still use
the working tree.

**Ollama service**

- A selected port starts a private local service when model requests are needed.
  The command stops that service after completion, failure, or cancellation.
  Automatic startup requires Windows 10 or later and `powershell.exe` with
  `Add-Type` and child-process creation allowed.
- A selected `OLLAMA_HOST` connects to an existing local service without starting
  or stopping it. Other platforms require this mode. Remote services and cloud
  models are unsupported.

Complete options, custom prompts, and runtime limits:

```sh
pnpm content:translate -- --help
```

##### Drafts And Content Checks

1. All model responses are collected.
2. Drafts are saved in the source article's directory.
3. Saved files are checked for content issues.

New files use `<name>.<locale>.md`, or `<name>.md` for the default language.
Existing targets retain their filenames. Output uses UTF-8 without BOM and LF
line endings.

- Existing targets require `--force` for replacement. Different or unverifiable
  file ownership prevents replacement.
- The source stays unchanged. Translation does not stage files or create commits.
- Code and link destinations are protected locally. Content checks report
  metadata and Markdown issues while retaining saved drafts.
- Write failures or Ctrl+C retain completed files and report unfinished targets
  and retained temporary files.

Review drafts before publication and temporary files before removing them.

**Translation attribution**

Generated frontmatter records `sourceLocale`, `provider` (`ollama`), and `model`
under `translation`.

The source language and model appear below the body. A source link appears when
the source article exists, is not a draft, and differs from the translation.
Attribution is author-editable; model names are public.

**Tag relationships**

Matching tag positions in a translation and its declared source establish
relationships. Counts and order must stay aligned. Unique existing translations
are reused; other tags are sent to the model.

Public tag pages link unique, reachable tag translations through the language
switcher. Other results lead to the target language's tag list.

**Verification**

```sh
pnpm test:content-translate
```

Tests use in-memory data without writing articles or starting Ollama.

### Content Git Metadata

Optional Git metadata appears below blog and page content, with first-commit
and edited times and commit hashes. Matching first and latest commits omit the
edited time; missing data uses a localized unknown label. SHA-1 and SHA-256
hashes are supported.

Metadata comes from the committed `src/generated/contentGitMetaManifest.json`.

#### Usage

1. Commit content changes, including renames.
2. Generate the manifest in a full local Git clone:

   ```sh
   pnpm content:git-meta
   ```

3. Commit `src/generated/contentGitMetaManifest.json` separately.

Default config in `src/config.ts`:

```ts
export const SITE = {
  repository: "", // repository root URL for commit links; default: "" (unlinked hashes); values: "" or HTTP(S) URL; omitted protocol: https://
  contentGitMeta: {
    enabled: false, // content Git metadata display; default: false; values: true | false
  },
};
```

### Build Compatibility

`pnpm build` generates Pagefind search assets in `dist/pagefind/` and copies them
to `public/pagefind/` for development, on Windows and POSIX. Local search reflects
the last production build.
