import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTagRelations,
  resolveTagTranslation,
} from "../../src/utils/localizedTags.mjs";
import { slugifyAll, slugifyStr } from "../../src/utils/slugify.mjs";

const original = {
  baseId: "guide",
  locale: "fr",
  tags: ["Intelligence artificielle", "Astro"],
};
const english = {
  baseId: "guide",
  locale: "en",
  tags: ["Artificial intelligence", "Astro"],
  translation: { sourceLocale: "fr" },
};
const japanese = {
  baseId: "guide",
  locale: "ja",
  tags: ["人工知能", "Astro"],
  translation: { sourceLocale: "en" },
};

test("shares the existing slug algorithm with site and Node consumers", () => {
  assert.deepEqual(slugifyAll(["E2E Testing", "TypeScript 5.0", "人工智能"]), [
    "e2e-testing",
    "typescript-5.0",
    "人工智能",
  ]);
  assert.equal(slugifyStr("Développement Web"), "developpement-web");
});

test("pairs ordered tags and follows translations through a third language", () => {
  const input = [original, english, japanese];
  const before = structuredClone(input);
  const relations = buildTagRelations(input);
  assert.deepEqual(relations.diagnostics, []);
  assert.deepEqual(
    resolveTagTranslation(relations, "fr", original.tags[0], "ja"),
    {
      status: "resolved",
      value: { locale: "ja", tag: "人工知能", slug: "人工知能" },
    }
  );
  assert.equal(
    resolveTagTranslation(relations, "ja", "人工知能", "fr").value.tag,
    original.tags[0]
  );
  assert.equal(
    resolveTagTranslation(relations, "fr", "Astro", "en").value.tag,
    "Astro"
  );
  assert.deepEqual(buildTagRelations([...input].reverse()), relations);
  assert.deepEqual(input, before);
});

test("aggregates repeated tags across posts without route conflicts", () => {
  const relations = buildTagRelations([
    original,
    { ...original, baseId: "another" },
  ]);
  assert.equal(relations.tags.length, 2);
  assert.deepEqual(relations.diagnostics, []);
});

test("returns missing relationships without assuming identical labels are translations", () => {
  const relations = buildTagRelations([
    original,
    { ...english, translation: undefined },
  ]);
  assert.deepEqual(resolveTagTranslation(relations, "fr", "Astro", "en"), {
    status: "missing",
    reason: "missing-translation",
  });
  assert.deepEqual(resolveTagTranslation(relations, "fr", "Missing", "en"), {
    status: "missing",
    reason: "unknown-source-tag",
  });
});

test("diagnoses missing sources, self references, and mismatched tag counts", () => {
  const missing = buildTagRelations([english]);
  assert.equal(missing.diagnostics[0].code, "missing-source");
  const self = buildTagRelations([
    { ...english, translation: { sourceLocale: "en" } },
  ]);
  assert.equal(self.diagnostics[0].code, "source-is-target");
  const mismatched = buildTagRelations([
    original,
    { ...english, tags: ["AI"] },
  ]);
  assert.equal(mismatched.diagnostics[0].code, "tag-count-mismatch");
  assert.equal(
    resolveTagTranslation(mismatched, "fr", original.tags[0], "en").status,
    "missing"
  );
});

test("does not infer positional relationships through duplicate tag arrays", () => {
  const relations = buildTagRelations([
    { ...original, tags: ["Astro", "Astro"] },
    english,
  ]);
  assert.equal(relations.diagnostics[0].code, "duplicate-tags");
  assert.equal(
    resolveTagTranslation(relations, "en", "Astro", "fr").status,
    "missing"
  );
});

test("blocks an ambiguous component in both directions including transitive lookups", () => {
  const relations = buildTagRelations([
    original,
    english,
    japanese,
    { ...original, baseId: "another" },
    { ...english, baseId: "another", tags: ["AI", "Astro"] },
  ]);
  assert.ok(
    relations.diagnostics.some(item => item.code === "ambiguous-mapping")
  );
  assert.equal(
    resolveTagTranslation(relations, "fr", original.tags[0], "ja").status,
    "ambiguous"
  );
  assert.equal(
    resolveTagTranslation(relations, "ja", "人工知能", "fr").status,
    "ambiguous"
  );
  assert.equal(
    resolveTagTranslation(relations, "fr", "Astro", "en").status,
    "resolved"
  );
});

test("rejects same-language slug collisions instead of hiding duplicate routes", () => {
  assert.throws(
    () =>
      buildTagRelations([
        { ...original, tags: ["E2E Testing", "e2e-testing"] },
      ]),
    /Tag route collision/
  );
  assert.throws(
    () => buildTagRelations([{ ...original, tags: ["C#", "C"] }]),
    /Tag route collision/
  );
  assert.doesNotThrow(() =>
    buildTagRelations([
      { ...original, tags: ["C#"] },
      { ...english, tags: ["C"] },
    ])
  );
  for (const tag of ["", ".", "..", "   "]) {
    assert.throws(
      () => buildTagRelations([{ ...original, tags: [tag] }]),
      /Invalid tag route|Empty or invalid tag/
    );
  }
});

test("keeps public and draft reference snapshots separate through caller input", () => {
  const publicRelations = buildTagRelations([original]);
  const referenceRelations = buildTagRelations([original, english]);
  assert.equal(
    resolveTagTranslation(publicRelations, "fr", "Astro", "en").status,
    "missing"
  );
  assert.equal(
    resolveTagTranslation(referenceRelations, "fr", "Astro", "en").status,
    "resolved"
  );
});

test("rejects duplicate content identities and handles empty snapshots", () => {
  assert.throws(
    () => buildTagRelations([original, original]),
    /Duplicate localized tag content/
  );
  const empty = buildTagRelations([]);
  assert.deepEqual(empty.tags, []);
  assert.deepEqual(empty.diagnostics, []);
});
