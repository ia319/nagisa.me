import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  readTranslationSnapshot,
  scanBlogFiles,
} from "../../scripts/content-translation/snapshot.mjs";
import { memoryFiles } from "./memory-files.mjs";

const source =
  "---\ntitle: Bonjour\ndescription: Exemple\ntags: [Outils]\n---\nTexte\n";
const registry = defaultLocale =>
  `export default ${JSON.stringify({
    defaultLocale,
    locales: {
      fr: { label: "Français", dir: "ltr" },
      en: { label: "English", dir: "ltr" },
      ar: { label: "العربية", dir: "rtl" },
    },
  })};`;

function indexMock(t, root, contents, changed) {
  const records = Object.entries(contents).map(([file, text], index) => ({
    file,
    text,
    oid: String(index + 1).padStart(40, "0"),
  }));
  const catalog = records
    .map(({ file, oid }) => `100644 ${oid} 0\t${file}\0`)
    .join("");
  const calls = [];
  t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    assert.equal(command, "git");
    assert.equal(options.cwd, root);
    assert.equal(options.encoding, "utf8");
    assert.ok(!options.shell);
    calls.push(args);
    if (args[0] === "rev-parse") return root + "\n";
    if (args[0] === "ls-files") return catalog;
    if (args[0] === "diff") return changed.map(file => `${file}\0`).join("");
    if (args[0] === "cat-file")
      return records.find(record => record.oid === args[2]).text;
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  });
  return calls;
}

test("reads explicit content and draft references from one working-tree snapshot", async t => {
  const { root } = memoryFiles(t, {
    "locales.config.mjs": registry("fr"),
    "src/data/blog/nested/post.md": source,
    "src/data/blog/reference.ar.md": source.replace(
      "tags: [Outils]",
      "draft: true\ntags: [أدوات]"
    ),
    "src/data/blog/_ignored.md": "Invalid ignored content",
    "src/data/blog/.hidden.md": "Invalid ignored content",
    "src/data/blog/asset.png": "image bytes",
  });
  t.mock.method(childProcess, "execFileSync", () =>
    assert.fail("Explicit file mode must not read Git")
  );
  const result = await readTranslationSnapshot(root, {
    file: "src/data/blog/nested/post.md",
  });
  assert.equal(result.source.path, "nested/post.md");
  assert.equal(result.source.text, source);
  assert.equal(result.registry.defaultLocale, "fr");
  assert.equal(result.references.length, 2);
  assert.ok(result.references.some(item => item.locale === "ar"));
  assert.ok(result.files.some(item => item.path === "asset.png"));
});

test("reads staged source, unchanged references, and configuration by captured blob IDs", async t => {
  const { root, reads } = memoryFiles(t, {
    "locales.config.mjs": registry("en"),
    "src/data/blog/post.md": source.replace("Bonjour", "Unstaged"),
    "src/data/blog/ref.en.md": source.replace("Outils", "Unstaged tag"),
  });
  const stagedReference = source.replace(
    "tags: [Outils]",
    "tags: [Tools]\ntranslation:\n  sourceLocale: fr"
  );
  const calls = indexMock(
    t,
    root,
    {
      "locales.config.mjs": registry("fr"),
      "src/data/blog/post.md": source,
      "src/data/blog/ref.md": source,
      "src/data/blog/ref.en.md": stagedReference,
    },
    ["src/data/blog/post.md"]
  );
  const result = await readTranslationSnapshot(root, { staged: true });
  assert.equal(result.source.text, source);
  assert.equal(result.registry.defaultLocale, "fr");
  assert.equal(result.references.length, 3);
  assert.deepEqual(result.references.find(item => item.locale === "en").tags, [
    "Tools",
  ]);
  assert.deepEqual(reads, []);
  assert.ok(
    calls.some(args => args[0] === "diff" && args.includes("--no-renames"))
  );
  assert.equal(calls.filter(args => args[0] === "ls-files").length, 2);
});

test("lists zero or multiple staged candidates and ignores deleted sources", async t => {
  const { root } = memoryFiles(t, { "src/data/blog/a.md": source });
  const contents = {
    "locales.config.mjs": registry("fr"),
    "src/data/blog/a.md": source,
    "src/data/blog/b.md": source,
  };
  for (const changed of [
    [],
    ["src/data/blog/deleted.md"],
    ["src/data/blog/a.md", "src/data/blog/b.md"],
  ]) {
    indexMock(t, root, contents, changed);
    await assert.rejects(
      readTranslationSnapshot(root, { staged: true }),
      error => {
        assert.match(error.message, /Expected exactly one staged blog source/);
        if (changed.length === 2)
          assert.match(error.message, /a.md, src\/data\/blog\/b.md/);
        return true;
      }
    );
  }
});

test("handles staged rename destinations and names containing spaces", async t => {
  const { root } = memoryFiles(t, { "src/data/blog/new name.fr.md": source });
  indexMock(
    t,
    root,
    {
      "locales.config.mjs": registry("fr"),
      "src/data/blog/new name.fr.md": source,
    },
    ["src/data/blog/new name.fr.md"]
  );
  assert.equal(
    (await readTranslationSnapshot(root, { staged: true })).source.path,
    "new name.fr.md"
  );
});

test("rejects an absent index registry, conflicts, linked blobs, and a changing index", async t => {
  const { root } = memoryFiles(t, { "src/data/blog/a.md": source });
  indexMock(t, root, { "src/data/blog/a.md": source }, ["src/data/blog/a.md"]);
  await assert.rejects(
    readTranslationSnapshot(root, { staged: true }),
    /missing from the Git index/
  );
  for (const replacement of [
    "100644 " + "1".repeat(40) + " 2\tsrc/data/blog/a.md\0",
    "120000 " + "1".repeat(40) + " 0\tsrc/data/blog/a.md\0",
    "changing",
  ]) {
    indexMock(
      t,
      root,
      { "locales.config.mjs": registry("fr"), "src/data/blog/a.md": source },
      ["src/data/blog/a.md"]
    );
    const original = childProcess.execFileSync;
    let reads = 0;
    t.mock.method(childProcess, "execFileSync", (command, args, options) => {
      if (args[0] === "ls-files" && (replacement !== "changing" || ++reads > 1))
        return replacement;
      return original(command, args, options);
    });
    await assert.rejects(
      readTranslationSnapshot(root, { staged: true }),
      /staged conflicts|not a regular file|index changed/
    );
  }
});

test("rejects unsafe sources and preserves non-regular targets in the collision snapshot", async t => {
  const { root, entries } = memoryFiles(t, {
    "locales.config.mjs": registry("fr"),
    "src/data/blog/a.md": source,
    "src/data/blog/a.en.md": { kind: "directory" },
    "src/data/blog/link.md": { kind: "symlink", target: "outside" },
  });
  for (const file of [
    "../a.md",
    "src/data/blog",
    "src/data/blog/_a.md",
    "src/data/blog/link.md",
    "src/data/blog/a.en.md",
  ]) {
    await assert.rejects(readTranslationSnapshot(root, { file }));
  }
  const files = await scanBlogFiles(root);
  assert.ok(
    files.some(file => file.path === "a.en.md" && file.kind === "directory")
  );
  assert.ok(
    files.some(file => file.path === "link.md" && file.kind === "symlink")
  );
  entries.set(path.join(root, "src/data/blog"), {
    kind: "directory",
    target: "outside",
  });
  await assert.rejects(scanBlogFiles(root), /without symbolic links/);
});

test("rejects duplicate localized identities and invalid frontmatter before model work", async t => {
  const { root, entries } = memoryFiles(t, {
    "locales.config.mjs": registry("fr"),
    "src/data/blog/a.md": source,
    "src/data/blog/a.fr.md": source,
  });
  await assert.rejects(
    readTranslationSnapshot(root, { file: "src/data/blog/a.md" }),
    /same base path and locale/
  );
  entries.set(path.join(root, "src/data/blog/a.fr.md"), {
    kind: "file",
    text: "Invalid",
  });
  entries.set(path.join(root, "locales.config.mjs"), {
    kind: "file",
    text: registry("en"),
  });
  await assert.rejects(
    readTranslationSnapshot(root, { file: "src/data/blog/a.md" }),
    /frontmatter/
  );
});
