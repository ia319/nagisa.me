import fs from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { validateLocaleRegistry } from "../locale-config/registry.mjs";
import { validateLocalizedContentIdentities } from "../../src/utils/localizedContentIdentity.mjs";
import { isTagSegment } from "../../src/utils/localizedTags.mjs";
import { CONTENT_DIRECTORIES, getContentDirectory } from "./targets.mjs";

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
 * Capture actual content entries, including non-content targets, without following links.
 * @param {string} root Canonical project root.
 * @param {"blog" | "tags"} collection Allowed content root.
 * @returns {Promise<import("./targets.mjs").FileState[]>} Collection-relative collision snapshot.
 * @throws {Error} When the content directory redirects outside its expected path.
 */
export async function scanContentFiles(root, collection) {
  const base = path.resolve(root, getContentDirectory(collection));
  try {
    await fs.lstat(base);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (
    (await fs.realpath(base)) !== base ||
    !(await fs.lstat(base)).isDirectory()
  )
    throw new Error(
      "Content directory must be a regular directory without symbolic links"
    );
  /** @type {import("./targets.mjs").FileState[]} */
  const files = [];
  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = prefix + entry.name;
      if (!entry.isSymbolicLink() && !entry.isDirectory() && !entry.isFile())
        throw new Error(
          `Unsupported content filesystem entry: ${relativePath}`
        );
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

function getContentLocation(projectPath) {
  for (const [kind, directory] of Object.entries(CONTENT_DIRECTORIES)) {
    if (projectPath.startsWith(directory + "/")) {
      const file = projectPath.slice(directory.length + 1);
      if (isContentPath(file)) return { kind, path: file };
    }
  }
}

/**
 * Capture one blog or tag source, its locale registry, and required tag metadata.
 * Index mode reads immutable blob IDs; working-tree files only determine write conflicts.
 * @param {string} root Project root containing locales.config.mjs.
 * @param {{file?: string, staged?: boolean}} selection Explicit file or staged source.
 * @returns Source kind, text, identity catalog, target snapshots, and filesystem collision states.
 * @throws {Error} When source selection, paths, localized identities, or the index are invalid.
 */
export async function readTranslationSnapshot(root, selection) {
  if (Boolean(selection.file) === Boolean(selection.staged))
    throw new Error("Provide one source file or --staged");
  root = await fs.realpath(root);
  const diskFiles = {
    blog: await scanContentFiles(root, "blog"),
    tags: await scanContentFiles(root, "tags"),
  };
  const entries = new Map();
  const pathsByKind = { blog: [], tags: [] };
  const listArgs = [
    "ls-files",
    "--stage",
    "--full-name",
    "-z",
    "--",
    "locales.config.mjs",
    ...Object.values(CONTENT_DIRECTORIES),
  ];
  let index;
  let sourceProjectPath;
  if (selection.staged) {
    const gitRoot = git(root, ["rev-parse", "--show-toplevel"]).trim();
    if ((await fs.realpath(gitRoot)) !== root)
      throw new Error("Run content:translate from the repository root");
    index = git(root, listArgs);
    for (const record of index.split("\0").filter(Boolean)) {
      const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(
        record
      );
      if (!match) throw new Error("Invalid Git index record");
      const [, mode, oid, stage, file] = match;
      if (stage !== "0")
        throw new Error(`Resolve staged conflicts first: ${file}`);
      const location = getContentLocation(file);
      if (file !== "locales.config.mjs" && !location) continue;
      if (!/^100(644|755)$/.test(mode))
        throw new Error(`Staged input is not a regular file: ${file}`);
      entries.set(file, oid);
      if (location) pathsByKind[location.kind].push(location.path);
    }
    const changed = git(root, [
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "--diff-filter=ACMR",
      "-z",
      "--",
      ...Object.values(CONTENT_DIRECTORIES),
    ])
      .split("\0")
      .filter(file => entries.has(file) && getContentLocation(file));
    if (changed.length !== 1)
      throw new Error(
        `Expected exactly one staged blog or tag source; found ${changed.length}. Candidates: ${changed.join(", ") || "none"}`
      );
    sourceProjectPath = changed[0];
  } else {
    sourceProjectPath = path
      .relative(root, path.resolve(root, selection.file))
      .split(path.sep)
      .join("/");
    for (const kind of Object.keys(CONTENT_DIRECTORIES)) {
      pathsByKind[kind] = diskFiles[kind]
        .filter(file => file.kind === "file" && isContentPath(file.path))
        .map(file => file.path);
    }
  }
  const sourceLocation = getContentLocation(sourceProjectPath);
  if (!sourceLocation)
    throw new Error(
      "Source must be a Markdown file inside src/data/blog or src/data/tags"
    );
  const { kind, path: sourcePath } = sourceLocation;

  async function readCapturedText(projectPath) {
    if (!selection.staged) return readProjectFile(root, projectPath);
    const oid = entries.get(projectPath);
    if (!oid) throw new Error(`${projectPath} is missing from the Git index`);
    return git(root, ["cat-file", "blob", oid]);
  }

  const sourceText = await readCapturedText(sourceProjectPath);
  if (!pathsByKind[kind].includes(sourcePath))
    throw new Error("Source is not a readable content entry");
  const registryText = await readCapturedText("locales.config.mjs");
  // The captured registry must be self-contained: data URLs cannot resolve relative imports.
  const { default: config } = await import(
    `data:text/javascript;base64,${Buffer.from(registryText, "utf8").toString("base64")}`
  );
  const registry = validateLocaleRegistry(config);
  const identityConfig = {
    defaultLocale: registry.defaultLocale,
    supportedLocales: Object.keys(registry.locales),
  };
  const identities = {};
  for (const collection of Object.keys(CONTENT_DIRECTORIES))
    identities[collection] = validateLocalizedContentIdentities(
      pathsByKind[collection].map(file => file.slice(0, -3)),
      identityConfig
    );
  const tagIds = identities.tags.map(item => item.baseId);
  for (const id of tagIds)
    if (!isTagSegment(id)) throw new Error(`Invalid tag ID: ${id}`);

  const targetTexts = new Map();
  if (kind === "tags") {
    const sourceIdentity =
      identities.tags[pathsByKind.tags.indexOf(sourcePath)];
    for (const [i, identity] of identities.tags.entries()) {
      if (
        identity.baseId !== sourceIdentity.baseId ||
        identity.locale === sourceIdentity.locale
      )
        continue;
      const target = pathsByKind.tags[i];
      targetTexts.set(
        target,
        await readCapturedText(getContentDirectory(kind) + "/" + target)
      );
    }
  }
  if (selection.staged && git(root, listArgs) !== index)
    throw new Error(
      "Git index changed while reading; retry with a stable index"
    );
  return {
    root,
    kind,
    source: { path: sourcePath, text: sourceText },
    registry,
    files: diskFiles[kind],
    tagIds,
    targetTexts,
  };
}
