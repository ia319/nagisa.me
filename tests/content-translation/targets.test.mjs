import assert from "node:assert/strict";
import test from "node:test";
import { planTranslationTargets } from "../../scripts/content-translation/targets.mjs";

const config = {
  defaultLocale: "fr",
  supportedLocales: ["fr", "en", "pt-BR", "ar"],
};
const base = {
  sourcePath: "guides/post.en.md",
  files: [{ path: "guides/post.en.md", kind: "file" }],
  targetLocales: ["fr", "pt-BR", "ar"],
  config,
};

test("plans multiple languages in the source directory with any configured default", () => {
  assert.deepEqual(
    planTranslationTargets(base).targets.map(target => target.path),
    ["guides/post.md", "guides/post.pt-BR.md", "guides/post.ar.md"]
  );
  assert.equal(
    planTranslationTargets({ ...base, sourcePath: "guides/version.2.md" })
      .source.baseId,
    "guides/version.2"
  );
});

test("reuses an existing explicit default suffix only with overwrite permission", () => {
  const input = {
    ...base,
    files: [...base.files, { path: "guides/post.fr.md", kind: "file" }],
  };
  assert.throws(() => planTranslationTargets(input), /already exists/);
  assert.deepEqual(
    planTranslationTargets({ ...input, force: true }).targets[0],
    { path: "guides/post.fr.md", locale: "fr", overwrite: true }
  );
});

test("applies ordinary overwrite rules when translating to the source language", () => {
  assert.throws(
    () => planTranslationTargets({ ...base, targetLocales: ["en"] }),
    /already exists/
  );
  assert.equal(
    planTranslationTargets({ ...base, targetLocales: ["en"], force: true })
      .targets[0].path,
    base.sourcePath
  );
});

test("rejects duplicate targets, unknown locales, and mismatched source declarations", () => {
  for (const targetLocales of [[], ["ar", "ar"], ["de"]])
    assert.throws(
      () => planTranslationTargets({ ...base, targetLocales }),
      /target locale|Target locale/
    );
  assert.throws(
    () => planTranslationTargets({ ...base, fromLocale: "fr" }),
    /Source locale is en/
  );
});

test("rejects duplicate content identities and unsafe or case-conflicting paths", () => {
  assert.throws(
    () =>
      planTranslationTargets({
        ...base,
        files: [
          ...base.files,
          { path: "guides/post.md", kind: "file" },
          { path: "guides/post.fr.md", kind: "file" },
        ],
      }),
    /same base path and locale/
  );
  for (const kind of ["directory", "symlink"])
    assert.throws(
      () =>
        planTranslationTargets({
          ...base,
          files: [...base.files, { path: "guides/post.md", kind }],
          force: true,
        }),
      /not a regular file/
    );
  assert.throws(
    () =>
      planTranslationTargets({
        ...base,
        files: [...base.files, { path: "guides/POST.md", kind: "directory" }],
      }),
    /differs only by case/
  );
  for (const sourcePath of [
    "../post.md",
    "/post.md",
    "C:\\post.md",
    "guides/../post.md",
    "guides/_post.md",
    ".hidden/post.md",
    "post.txt",
  ])
    assert.throws(
      () => planTranslationTargets({ ...base, sourcePath }),
      /blog-relative|blog Markdown/
    );
});
