import assert from "node:assert/strict";
import test from "node:test";
import {
  getTagAliases,
  getTagReferenceDiagnostics,
  isTagSegment,
} from "../../src/utils/localizedTags.mjs";
import { slugifyStr } from "../../src/utils/slugify.mjs";

test("keeps valid literal IDs and diagnoses missing definitions by article path", () => {
  for (const id of ["astro", "FrontEnd", "阅读体验"])
    assert.equal(isTagSegment(id), true);
  for (const id of [
    "",
    ".",
    "..",
    "two words",
    "a/b",
    "a\\b",
    "a%20b",
    "a?b",
    "#a",
    "a\n",
  ]) {
    assert.equal(isTagSegment(id), false);
    assert.throws(
      () =>
        getTagReferenceDiagnostics(
          [{ path: "post.md", tags: [id] }],
          new Set()
        ),
      /Invalid tag ID.*post.md/
    );
  }
  const warnings = getTagReferenceDiagnostics(
    [{ path: "post.en.md", tags: ["astro", "missing", "missing"] }],
    new Set(["astro"])
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /missing.*post.en.md/);
});

test("reserves all IDs and skips every competing alias regardless of order", () => {
  const definitions = [
    {
      id: "a",
      locale: "fr",
      aliases: ["a", "old", "b", "bad/alias", "unique"],
    },
    { id: "b", locale: "fr", aliases: ["old"] },
    { id: "a", locale: "en", aliases: ["old"] },
    { id: "draft", locale: "fr", draft: true, aliases: ["draft-old"] },
    { id: "empty", locale: "fr", aliases: ["empty-old"] },
  ];
  const routes = [
    { tag: "a", locale: "fr" },
    { tag: "b", locale: "fr" },
    { tag: "a", locale: "en" },
  ];
  const reserved = new Set(["a", "b", "draft", "empty"]);
  const result = getTagAliases(definitions, routes, reserved);
  assert.deepEqual(result.aliases, [
    { locale: "en", alias: "old", tag: "a" },
    { locale: "fr", alias: "unique", tag: "a" },
  ]);
  assert.deepEqual(
    getTagAliases([...definitions].reverse(), routes, reserved).aliases,
    result.aliases
  );
  assert.equal(
    result.diagnostics.filter(item => item.code === "ambiguous-tag-alias")
      .length,
    1
  );
  assert.equal(
    result.diagnostics.filter(item => item.code === "invalid-tag-alias").length,
    2
  );
});

test("reserves canonical IDs case-insensitively even without public routes", () => {
  const result = getTagAliases(
    [
      {
        id: "tools",
        locale: "fr",
        aliases: ["Tools", "DRAFT", "Empty", "ToolsArchive"],
      },
    ],
    [{ tag: "tools", locale: "fr" }],
    new Set(["tools", "draft", "empty"])
  );
  assert.deepEqual(result.aliases, [
    { locale: "fr", alias: "ToolsArchive", tag: "tools" },
  ]);
  assert.equal(result.diagnostics.length, 3);
  assert.ok(
    result.diagnostics.every(item => item.code === "invalid-tag-alias")
  );
});

test("skips case-colliding aliases for the same or different owners regardless of order", () => {
  const definitions = [
    {
      id: "a",
      locale: "fr",
      aliases: ["Old", "Solo", "solo", "Upper", "Upper"],
    },
    { id: "b", locale: "fr", aliases: ["old"] },
    { id: "a", locale: "en", aliases: ["OLD"] },
  ];
  const routes = [
    { tag: "a", locale: "fr" },
    { tag: "b", locale: "fr" },
    { tag: "a", locale: "en" },
  ];
  const reserved = new Set(["a", "b"]);
  const result = getTagAliases(definitions, routes, reserved);
  assert.deepEqual(result.aliases, [
    { locale: "en", alias: "OLD", tag: "a" },
    { locale: "fr", alias: "Upper", tag: "a" },
  ]);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(
    result.diagnostics.every(item => item.code === "ambiguous-tag-alias")
  );
  assert.deepEqual(
    getTagAliases(
      [...definitions]
        .reverse()
        .map(item => ({ ...item, aliases: [...item.aliases].reverse() })),
      routes,
      reserved
    ),
    result
  );
});

test("retains article slug behavior separately from literal tag IDs", () => {
  assert.equal(slugifyStr("Hello World"), "hello-world");
  assert.equal(slugifyStr("Astro"), "astro");
});
