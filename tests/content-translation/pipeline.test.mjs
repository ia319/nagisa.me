import assert from "node:assert/strict";
import test from "node:test";
import { parseArticle } from "../../scripts/content-translation/frontmatter.mjs";
import {
  completeTranslation,
  prepareTranslation,
} from "../../scripts/content-translation/pipeline.mjs";
import {
  buildTranslationPrompt,
  TRANSLATION_CONTEXT,
} from "../../scripts/content-translation/prompts.mjs";

const registry = {
  defaultLocale: "fr",
  locales: {
    fr: { label: "Français", dir: "ltr" },
    en: { label: "English", dir: "ltr" },
    "pt-BR": { label: "Português", dir: "ltr" },
    ar: { label: "العربية", dir: "rtl" },
  },
};
const text = `---
# Article context
title: Installation # Preserve title comment
description: Exemple
author: Private Author
pubDatetime: 2024-01-02T03:04:05Z
draft: false
canonicalURL: https://private.example/original
timezone: Asia/Singapore
tags:
  - Astro # Preserve tag comment
  - Outils
custom:
  secret: private-value
  order: [2, 1]
translation:
  sourceLocale: ar
  provider: ollama
  model: old-private-model
---

## Installation

Bonjour \`secret()\` et [guide](https://example.com).
`;
const input = {
  source: { path: "guides/post.fr.md", text },
  registry,
  targetLocales: ["en", "pt-BR"],
  files: [{ path: "guides/post.fr.md", kind: "file" }],
  model: "example:12b",
};
const translate = request => ({
  id: request.id,
  text: request.text
    .replaceAll("Installation", "Setup")
    .replaceAll("Exemple", "Example")
    .replaceAll("Bonjour", "Hello")
    .replaceAll("Outils", "Tools"),
});

test("assembles all targets from model text without exposing copied metadata", () => {
  const before = structuredClone(input);
  const plan = prepareTranslation(input);
  const prompts = plan.requests.map(request => request.prompt).join("\n");
  for (const privateText of [
    "Private Author",
    "private-value",
    "2024-01-02",
    "Asia/Singapore",
    "old-private-model",
    "private.example",
    "secret()",
    "https://example.com",
  ])
    assert.ok(!prompts.includes(privateText), privateText);
  const result = completeTranslation(plan, plan.requests.map(translate));
  assert.deepEqual(
    result.files.map(file => file.path),
    ["guides/post.en.md", "guides/post.pt-BR.md"]
  );
  for (const file of result.files) {
    const output = parseArticle(file.text);
    assert.equal(output.fields.title, "Setup");
    assert.deepEqual(output.fields.tags, ["Astro", "Tools"]);
    assert.equal(output.document.get("draft"), true);
    assert.equal(output.document.has("canonicalURL"), false);
    assert.deepEqual(output.document.get("translation").toJSON(), {
      sourceLocale: "fr",
      provider: "ollama",
      model: "example:12b",
    });
    assert.deepEqual(output.document.get("custom").toJSON(), {
      secret: "private-value",
      order: [2, 1],
    });
    assert.match(file.text, /# Preserve title comment/);
    assert.match(file.text, /# Preserve tag comment/);
    assert.ok(file.text.indexOf("author:") < file.text.indexOf("pubDatetime:"));
    assert.match(file.text, /pubDatetime: 2024-01-02T03:04:05Z/);
    assert.match(file.text, /Hello `secret\(\)`/);
    assert.ok(
      file.text.endsWith("\n") &&
        !file.text.startsWith("\uFEFF") &&
        !file.text.includes("\r")
    );
  }
  assert.deepEqual(input, before);
  assert.deepEqual(
    completeTranslation(plan, plan.requests.map(translate)),
    result
  );
});

test("reuses unique tag translations and keeps original positional order", () => {
  const references = [
    { baseId: "reference", locale: "fr", tags: ["Astro", "Outils"] },
    {
      baseId: "reference",
      locale: "en",
      tags: ["Astro", "Tools"],
      translation: { sourceLocale: "fr" },
    },
  ];
  const plan = prepareTranslation({
    ...input,
    targetLocales: ["en"],
    references,
  });
  assert.ok(plan.requests.every(request => request.field !== "tags"));
  assert.deepEqual(
    parseArticle(
      completeTranslation(plan, plan.requests.map(translate)).files[0].text
    ).fields.tags,
    ["Astro", "Tools"]
  );
});

test("reports ambiguous references and requests a fresh tag translation", () => {
  const references = [
    { baseId: "a", locale: "fr", tags: ["Outils"] },
    {
      baseId: "a",
      locale: "en",
      tags: ["Tools"],
      translation: { sourceLocale: "fr" },
    },
    { baseId: "b", locale: "fr", tags: ["Outils"] },
    {
      baseId: "b",
      locale: "en",
      tags: ["Utilities"],
      translation: { sourceLocale: "fr" },
    },
  ];
  const plan = prepareTranslation({
    ...input,
    targetLocales: ["en"],
    references,
  });
  assert.ok(
    plan.requests.some(
      request => request.field === "tags" && request.text === "Outils"
    )
  );
  assert.ok(plan.diagnostics.some(item => item.code === "ambiguous-mapping"));
});

test("requires exactly one valid response per request and returns no partial set", () => {
  const plan = prepareTranslation(input);
  const responses = plan.requests.map(translate);
  assert.throws(
    () => completeTranslation(plan, responses.slice(0, -1)),
    /Missing model responses/
  );
  assert.throws(
    () => completeTranslation(plan, [...responses, responses[0]]),
    /duplicate model response/
  );
  assert.throws(
    () =>
      completeTranslation(plan, [
        ...responses,
        { id: "unknown", text: "value" },
      ]),
    /Unknown/
  );
  assert.throws(
    () =>
      completeTranslation(
        plan,
        responses.map((value, index) =>
          index === responses.length - 1 ? { ...value, text: "" } : value
        )
      ),
    /Empty or invalid/
  );
  assert.throws(
    () =>
      completeTranslation(
        plan,
        responses.map(value =>
          value.id.includes(":body:") ? { ...value, text: "invalid" } : value
        )
      ),
    /placeholders/
  );
});

test("rejects model-generated tag route collisions against reference posts", () => {
  const plan = prepareTranslation({
    ...input,
    targetLocales: ["en"],
    references: [{ baseId: "another", locale: "en", tags: ["tools"] }],
  });
  assert.throws(
    () => completeTranslation(plan, plan.requests.map(translate)),
    /Tag route collision/
  );
});

test("supports append and replace context while retaining mandatory rules", () => {
  const fields = {
    sourceLocale: "ar",
    targetLocale: "pt-BR",
    text: "Hello",
    userPrompt: "Use formal terminology",
  };
  const append = buildTranslationPrompt(fields);
  const replace = buildTranslationPrompt({ ...fields, promptMode: "replace" });
  assert.ok(append.includes(TRANSLATION_CONTEXT));
  assert.ok(!replace.includes(TRANSLATION_CONTEXT));
  for (const prompt of [append, replace]) {
    assert.match(prompt, /from ar to pt-BR/);
    assert.match(prompt, /output rules remain mandatory/);
    assert.ok(
      prompt.indexOf("Use formal terminology") <
        prompt.indexOf("Text to translate:")
    );
  }
  assert.throws(
    () => buildTranslationPrompt({ ...fields, promptMode: "unknown" }),
    /Prompt mode/
  );
  assert.throws(
    () =>
      buildTranslationPrompt({
        ...fields,
        promptMode: "replace",
        userPrompt: "",
      }),
    /must not be empty/
  );
});

test("normalizes source encoding and rejects unsafe model metadata", () => {
  const plan = prepareTranslation({
    ...input,
    source: { ...input.source, text: `\uFEFF${text.replaceAll("\n", "\r\n")}` },
  });
  assert.ok(
    !completeTranslation(
      plan,
      plan.requests.map(translate)
    ).files[0].text.includes("\r")
  );
  for (const model of [
    "",
    "-flag",
    " model",
    "model\nname",
    "model\u202ename",
    "m".repeat(257),
  ])
    assert.throws(() => prepareTranslation({ ...input, model }), /Model must/);
});

test("rejects malformed, duplicate, aliased, and wrongly typed frontmatter", () => {
  for (const source of [
    "No frontmatter",
    "---\n- item\n---\n",
    "---\ntitle: A\ntitle: B\ndescription: D\n---\n",
    "---\ntitle: &title A\ndescription: *title\n---\n",
    "---\ntitle: 1\ndescription: D\n---\n",
    "---\ntitle: A\ndescription: D\ntags: A\n---\n",
  ])
    assert.throws(() => parseArticle(source));
});

test("preserves omitted tags and protects code-only bodies without model requests", () => {
  const plan = prepareTranslation({
    ...input,
    targetLocales: ["ar"],
    source: {
      ...input.source,
      text: '---\ntitle: ""\ndescription: ""\n---\n```js\nsecret()\n```',
    },
  });
  assert.deepEqual(plan.requests, []);
  const file = completeTranslation(plan, []).files[0];
  assert.equal(parseArticle(file.text).document.has("tags"), false);
  assert.ok(file.text.endsWith("```\n"));
});
