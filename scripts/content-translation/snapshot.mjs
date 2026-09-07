import fs from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { validateLocaleRegistry } from "../locale-config/registry.mjs";
import { validateLocalizedContentIdentities } from "../../src/utils/localizedContentIdentity.mjs";
import { parseArticle } from "./frontmatter.mjs";

const blogDirectory = "src/data/blog/";

function isContentPath(value) {
  return (
    value.endsWith(".md") &&
    !/[\\:\u0000-\u001f]/.test(value) &&
    value.split("/").every(part => part && !part.startsWith(".")) &&
    !value.split("/").at(-1).startsWith("_")
  );
}

/**
 * Read a project file only when neither it nor its ancestors redirect the path.
 * @param {string} root Canonical project root.
 * @param {string} relativePath Project-relative file path.
 * @returns {Promise<string>} UTF-8 source text.
 * @throws {Error} When the path escapes the root or is not a regular file.
 */
export async function readProjectFile(root, relativePath) {
  const file = path.resolve(root, relativePath);
  const relative = path.relative(root, file);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    (await fs.realpath(file)) !== file ||
    !(await fs.lstat(file)).isFile()
  ) {
    throw new Error(
      `Expected a regular project file without symbolic links: ${relativePath}`
    );
  }
  return fs.readFile(file, "utf8");
}

/**
 * Capture actual blog entries, including non-content targets, without following links.
 * @param {string} root Canonical project root.
 * @returns {Promise<import("./targets.mjs").FileState[]>} Blog-relative collision snapshot.
 * @throws {Error} When the blog directory redirects outside its expected path.
 */
export async function scanBlogFiles(root) {
  const base = path.resolve(root, blogDirectory);
  if (
    (await fs.realpath(base)) !== base ||
    !(await fs.lstat(base)).isDirectory()
  )
    throw new Error(
      "Blog directory must be a regular directory without symbolic links"
    );
  /** @type {import("./targets.mjs").FileState[]} */
  const files = [];
  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = prefix + entry.name;
      if (!entry.isSymbolicLink() && !entry.isDirectory() && !entry.isFile())
        throw new Error(`Unsupported blog filesystem entry: ${relativePath}`);
      const kind = entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : "file";
      files.push({ path: relativePath, kind });
      if (kind === "directory" && !entry.name.startsWith("."))
        await visit(path.join(directory, entry.name), `${relativePath}/`);
    }
  }
  await visit(base, "");
  return files;
}

function git(root, args) {
  try {
    return childProcess.execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Cannot read Git index: ${error.stderr || error.message}`, {
      cause: error,
    });
  }
}

/**
 * Read one source and the complete tag/configuration reference snapshot.
 * Index mode reads captured blob IDs; working-tree data only determines write conflicts.
 * @param {string} root Project root containing locales.config.mjs.
 * @param {{file?: string, staged?: boolean}} selection Explicit file or staged source selection.
 * @returns {Promise<{root: string, source: {path: string, text: string}, registry: ReturnType<typeof validateLocaleRegistry>, files: import("./targets.mjs").FileState[], references: import("../../src/utils/localizedTags.mjs").LocalizedTagContent[]}>} Input for the pure translation kernel.
 * @throws {Error} When selection, paths, frontmatter, or staged entries are invalid.
 */
export async function readTranslationSnapshot(root, selection) {
  if (Boolean(selection.file) === Boolean(selection.staged))
    throw new Error("Provide one source file or --staged");
  root = await fs.realpath(root);
  const files = await scanBlogFiles(root);
  const articles = new Map();
  let registryText;
  let sourcePath;
  if (selection.staged) {
    const gitRoot = git(root, ["rev-parse", "--show-toplevel"]).trim();
    if ((await fs.realpath(gitRoot)) !== root)
      throw new Error("Run content:translate from the repository root");
    const listArgs = [
      "ls-files",
      "--stage",
      "--full-name",
      "-z",
      "--",
      "locales.config.mjs",
      "src/data/blog",
    ];
    const index = git(root, listArgs);
    const entries = new Map();
    for (const record of index.split("\0").filter(Boolean)) {
      const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(
        record
      );
      if (!match) throw new Error("Invalid Git index record");
      const [, mode, oid, stage, file] = match;
      if (stage !== "0")
        throw new Error(`Resolve staged conflicts first: ${file}`);
      if (
        file !== "locales.config.mjs" &&
        !isContentPath(file.slice(blogDirectory.length))
      )
        continue;
      if (!file.startsWith(blogDirectory) && file !== "locales.config.mjs")
        continue;
      if (!/^100(644|755)$/.test(mode))
        throw new Error(`Staged input is not a regular file: ${file}`);
      entries.set(file, oid);
    }
    const changed = git(root, [
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "--diff-filter=ACMR",
      "-z",
      "--",
      "src/data/blog",
    ])
      .split("\0")
      .filter(file => file.startsWith(blogDirectory) && entries.has(file));
    if (changed.length !== 1)
      throw new Error(
        `Expected exactly one staged blog source; found ${changed.length}. Candidates: ${changed.join(", ") || "none"}`
      );
    sourcePath = changed[0].slice(blogDirectory.length);
    const registryId = entries.get("locales.config.mjs");
    if (!registryId)
      throw new Error("locales.config.mjs is missing from the Git index");
    registryText = git(root, ["cat-file", "blob", registryId]);
    for (const [file, oid] of entries) {
      if (file.startsWith(blogDirectory))
        articles.set(
          file.slice(blogDirectory.length),
          git(root, ["cat-file", "blob", oid])
        );
    }
    if (git(root, listArgs) !== index)
      throw new Error(
        "Git index changed while reading; retry with a stable index"
      );
  } else {
    sourcePath = path
      .relative(
        path.join(root, blogDirectory),
        path.resolve(root, selection.file)
      )
      .split(path.sep)
      .join("/");
    if (!isContentPath(sourcePath))
      throw new Error("Source must be a Markdown file inside src/data/blog");
    // Check the explicit path even if the directory scan skipped a linked ancestor.
    const sourceText = await readProjectFile(root, blogDirectory + sourcePath);
    registryText = await readProjectFile(root, "locales.config.mjs");
    for (const file of files) {
      if (file.kind === "file" && isContentPath(file.path))
        articles.set(
          file.path,
          file.path === sourcePath
            ? sourceText
            : await readProjectFile(root, blogDirectory + file.path)
        );
    }
    if (!articles.has(sourcePath))
      throw new Error("Source is not a readable blog entry");
  }
  const { default: config } = await import(
    `data:text/javascript;base64,${Buffer.from(registryText, "utf8").toString("base64")}`
  );
  const registry = validateLocaleRegistry(config);
  const paths = [...articles.keys()];
  const identities = validateLocalizedContentIdentities(
    paths.map(file => file.slice(0, -3)),
    {
      defaultLocale: registry.defaultLocale,
      supportedLocales: Object.keys(registry.locales),
    }
  );
  const references = paths.map((file, index) => {
    const article = parseArticle(articles.get(file));
    const sourceLocale = article.document.getIn([
      "translation",
      "sourceLocale",
    ]);
    return {
      baseId: identities[index].baseId,
      locale: identities[index].locale,
      tags: article.fields.tags,
      ...(typeof sourceLocale === "string"
        ? { translation: { sourceLocale } }
        : {}),
    };
  });
  return {
    root,
    source: { path: sourcePath, text: articles.get(sourcePath) },
    registry,
    files,
    references,
  };
}
