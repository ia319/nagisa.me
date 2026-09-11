import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { parseArticle } from "../../scripts/content-translation/frontmatter.mjs";
import {
  completeTranslation,
  prepareTranslation,
  validateTranslation,
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
const translate = request => {
  const text = request.text
    .replaceAll("Installation", "Setup")
    .replaceAll("Exemple", "Example")
    .replaceAll("Bonjour", "Hello")
    .replaceAll("Outils", "Tools");
  return {
    id: request.id,
    text: request.field === "metadata" ? JSON.stringify(parse(text)) : text,
  };
};

test("keeps source metadata and completed body when JSON is unreadable without requesting repairs", () => {
  const plan = prepareTranslation({ ...input, targetLocales: ["en"] });
  for (const invalid of [
    "not JSON",
    '```json\n{"title":"Setup"}\n```',
    "title: Setup",
    "null",
    "[]",
    '{"title":"A","title":"B"}',
  ]) {
    const responses = plan.requests.map(request =>
      request.field === "metadata"
        ? { id: request.id, text: invalid }
        : translate(request)
    );
    const result = completeTranslation(plan, responses);
    const article = parseArticle(result.files[0].text);
    assert.deepEqual(article.fields, plan.article.fields);
    assert.ok(article.body.includes("## Setup"));
    assert.ok(article.body.includes("Hello `secret()`"));
    assert.equal(article.document.get("draft"), true);
    const warning = validateTranslation(plan, responses, result.files).find(
      item => item.code === "metadata-parse"
    );
    assert.match(
      warning.message,
      /Requested fields remain untranslated: title, description, tags/
    );
    assert.equal(plan.requests.length, 2);
  }
});

test("applies valid metadata fields only and never copies unexpected model keys", () => {
  const plan = prepareTranslation({ ...input, targetLocales: ["en"] });
  for (const description of [undefined, null, 42, [], {}, "", "   "]) {
    const responses = plan.requests.map(request =>
      request.field === "metadata"
        ? {
            id: request.id,
            text: JSON.stringify({
              title: "Setup",
              description,
              tags: ["Astro", "Tools"],
              author: "Model author",
              draft: false,
            }),
          }
        : translate(request)
    );
    const result = completeTranslation(plan, responses);
    const article = parseArticle(result.files[0].text);
    assert.equal(article.fields.title, "Setup");
    assert.equal(article.fields.description, "Exemple");
    assert.deepEqual(article.fields.tags, ["Astro", "Tools"]);
    assert.equal(article.document.get("author"), "Private Author");
    assert.equal(article.document.get("draft"), true);
    const warnings = validateTranslation(plan, responses, result.files);
    assert.ok(
      warnings.some(
        item =>
          item.code === "metadata-field" &&
          item.message.includes("description remains untranslated")
      )
    );
    assert.equal(
      warnings.filter(item => item.code === "metadata-extra-field").length,
      2
    );
  }
});

test("withholds mapped tags and preserves indices when remaining tag output is invalid", () => {
  const plan = prepareTranslation({
    ...input,
    targetLocales: ["en"],
    references: [
      { baseId: "reference", locale: "fr", tags: ["Astro"] },
      {
        baseId: "reference",
        locale: "en",
        tags: ["Astro framework"],
        translation: { sourceLocale: "fr" },
      },
    ],
  });
  assert.deepEqual(parse(plan.requests[0].text), {
    title: "Installation",
    description: "Exemple",
    tags: ["Outils"],
  });
  assert.deepEqual(plan.outputs[0].tagIndices, [1]);
  for (const tags of [[], ["Wrong", "Count"], null, [null], [""]]) {
    const responses = plan.requests.map(request =>
      request.field === "metadata"
        ? {
            id: request.id,
            text: JSON.stringify({
              title: "Setup",
              description: "Example",
              tags,
            }),
          }
        : translate(request)
    );
    const result = completeTranslation(plan, responses);
    assert.deepEqual(parseArticle(result.files[0].text).fields.tags, [
      "Astro framework",
      "Outils",
    ]);
    assert.ok(
      validateTranslation(plan, responses, result.files).some(item =>
        ["metadata-tags", "metadata-field"].includes(item.code)
      )
    );
  }
});

test("round-trips translated JSON strings through YAML including punctuation and multiline descriptions", () => {
  const plan = prepareTranslation({ ...input, targetLocales: ["en"] });
  const fields = {
    title: 'Title: "quoted" \\ path 日本語',
    description: 'First line\nSecond: "quoted"\nThird \\ line',
    tags: ["Astro", "Tools: CLI"],
  };
  const responses = plan.requests.map(request =>
    request.field === "metadata"
      ? { id: request.id, text: JSON.stringify(fields) }
      : translate(request)
  );
  const result = completeTranslation(plan, responses);
  assert.deepEqual(parseArticle(result.files[0].text).fields, fields);
  assert.deepEqual(validateTranslation(plan, responses, result.files), []);
});

test("reports physical source and saved line numbers including multiline frontmatter", () => {
  const original =
    "---\n# Context\ntitle: A\ndescription: |\n  B\n  C\n---\nBefore **one** and `code`.\n";
  const plan = prepareTranslation({
    ...input,
    targetLocales: ["en"],
    source: { ...input.source, text: original },
  });
  const responses = plan.requests.map(request => ({
    id: request.id,
    text:
      request.field === "metadata"
        ? JSON.stringify({
            title: "Title",
            description: "First\nSecond\nThird",
          })
        : "Before ** one ** and __KEEP_999_999__.",
  }));
  const result = completeTranslation(plan, responses);
  const savedLines = result.files[0].text.split("\n");
  const savedLine = savedLines.findIndex(line => line.startsWith("Before")) + 1;
  const warnings = validateTranslation(plan, responses, result.files);
  const group = warnings.find(item => item.code === "placeholder-missing");
  assert.match(
    group.message,
    /source src\/data\/blog\/guides\/post.fr.md:8:20/
  );
  assert.ok(
    group.message.includes(
      `saved src/data/blog/guides/post.en.md:${savedLine}:22`
    )
  );
  assert.ok(!group.message.includes("saved occurrences:"));
  assert.equal(plan.article.bodyLine, 8);
});

test("assembles all targets from model text without exposing copied metadata", () => {
  const before = structuredClone(input);
  const plan = prepareTranslation(input);
  const prompts = plan.requests.map(request => request.prompt).join("\n");
  assert.deepEqual(
    plan.requests.map(request => request.id),
    ["en:metadata", "en:body", "pt-BR:metadata", "pt-BR:body"]
  );
  assert.equal(
    plan.requests.filter(request => request.field === "body").length,
    2
  );
  for (const request of plan.requests) {
    if (request.field === "body") {
      assert.equal(request.text, plan.markdown.text);
      assert.ok(request.text.includes("\n\n"));
      for (const item of plan.markdown.protected)
        assert.ok(request.prompt.includes(item.token));
    } else {
      assert.equal(request.format, "json");
      assert.ok(!request.prompt.includes("__KEEP_"));
      assert.ok(!request.prompt.includes("paired syntax"));
      assert.match(request.prompt, /JSON object with exactly the same keys/);
    }
  }
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
    validateTranslation(plan, plan.requests.map(translate), result.files),
    []
  );
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
  assert.equal(plan.requests.length, 2);
  assert.deepEqual(Object.keys(parse(plan.requests[0].text)), [
    "title",
    "description",
  ]);
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
      request =>
        request.field === "metadata" &&
        parse(request.text).tags.includes("Outils")
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
});

test("assembles invalid model bodies and reports missing content without rejecting drafts", () => {
  const plan = prepareTranslation(input);
  const responses = plan.requests.map(request =>
    request.field === "body"
      ? { id: request.id, text: "Unusable body __KEEP_999_999__" }
      : translate(request)
  );
  const result = completeTranslation(plan, responses);
  assert.equal(result.files.length, 2);
  assert.ok(
    result.files.every(file =>
      file.text.includes("Unusable body __KEEP_999_999__")
    )
  );
  const diagnostics = validateTranslation(plan, responses, result.files);
  assert.ok(
    diagnostics.some(
      item =>
        item.code === "placeholder-missing" &&
        /Source: src\/data\/blog\/guides\/post.fr.md:\d+:\d+/.test(item.message)
    )
  );
  assert.ok(
    diagnostics.some(item => item.message.includes("[placeholder-unknown]"))
  );
});

test("reports model-generated tag route collisions after assembling drafts", () => {
  const plan = prepareTranslation({
    ...input,
    targetLocales: ["en"],
    references: [{ baseId: "another", locale: "en", tags: ["tools"] }],
  });
  const responses = plan.requests.map(translate);
  const result = completeTranslation(plan, responses);
  assert.ok(
    validateTranslation(plan, responses, result.files).some(
      item =>
        item.code === "tag-route" && /Tag route collision/.test(item.message)
    )
  );
});

test("supports append and replace context while retaining mandatory rules", () => {
  const fields = {
    sourceLocale: "ar",
    targetLocale: "pt-BR",
    text: "Hello",
    field: "metadata",
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

test("keeps format boundaries in two complete requests without constraining translated line counts", () => {
  const sourceText =
    "---\ntitle: Installation\ndescription: Exemple\n---\n" +
    "Bonjour\\\nSuite.\n\n[Guide][docs]\n\n<div>\nOriginal HTML.\n</div>\n\n[docs]: https://example.com\n";
  for (const promptMode of ["append", "replace"]) {
    const plan = prepareTranslation({
      ...input,
      targetLocales: ["en"],
      source: { ...input.source, text: sourceText },
      promptMode,
      userPrompt: "Use formal terminology",
    });
    assert.equal(plan.requests.length, 2);
    const bodyRequest = plan.requests.find(request => request.field === "body");
    const metadataRequest = plan.requests.find(
      request => request.field === "metadata"
    );
    assert.match(
      bodyRequest.prompt,
      /Ordinary paragraph text may wrap onto a different number of lines/
    );
    assert.match(
      bodyRequest.prompt,
      /preserve the blank lines separating them from surrounding blocks/
    );
    assert.match(
      bodyRequest.prompt,
      /Preserve existing Markdown hard-break markers/
    );
    assert.ok(!bodyRequest.prompt.includes("on their original lines"));
    assert.ok(!metadataRequest.prompt.includes("hard-break"));
    for (const item of plan.markdown.protected)
      assert.ok(bodyRequest.prompt.includes(item.token));
    const responses = plan.requests.map(request => {
      const response = translate(request);
      if (request.field === "body")
        response.text = response.text
          .replace(
            "Hello",
            "A translated sentence\nthat uses more physical lines"
          )
          .replace(
            /^(__KEEP_\d+_\d+__)\n\n(?=__KEEP_\d+_\d+__(?:\n|$))/gm,
            "$1\n"
          );
      return response;
    });
    const result = completeTranslation(plan, responses);
    const saved = parseArticle(result.files[0].text);
    assert.ok(saved.body.includes("more physical lines\\\nSuite."));
    assert.ok(saved.body.includes("</div>\n\n[docs]:"));
    assert.deepEqual(validateTranslation(plan, responses, result.files), []);
    const changed = [
      {
        ...result.files[0],
        text: result.files[0].text.replace(
          "</div>\n\n[docs]:",
          "</div>\n[docs]:"
        ),
      },
    ];
    const warnings = validateTranslation(plan, responses, changed);
    assert.ok(warnings.some(item => item.message.includes("retained inside")));
    assert.ok(warnings.every(item => /post.en.md:\d+:\d+/.test(item.message)));
    assert.equal(plan.requests.length, 2);
  }
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
  assert.deepEqual(validateTranslation(plan, [], [file]), []);
});

test("includes placeholder rules only for real protected values and leaves formatting visible", () => {
  for (const body of ["Bonjour.", "Bonjour `code`.", "Bonjour **monde**."]) {
    const plan = prepareTranslation({
      ...input,
      targetLocales: ["en"],
      source: {
        ...input.source,
        text: "---\ntitle: A\ndescription: B\n---\n" + body,
      },
    });
    const request = plan.requests.find(request => request.field === "body");
    assert.equal(
      request.prompt.includes("Copy each of these exact placeholders"),
      body.includes("`code`")
    );
    assert.equal(request.prompt.includes("paired syntax"), false);
    if (body.includes("**")) assert.ok(request.text.includes("**monde**"));
    assert.equal(request.prompt.includes("__KEEP_999_999__"), false);
  }
});

test("keeps malformed field output as draft data and reports field, position, and reason", () => {
  const plan = prepareTranslation({ ...input, targetLocales: ["en"] });
  const responses = plan.requests.map(request => ({
    id: request.id,
    text:
      request.field === "metadata"
        ? JSON.stringify({
            title: "Title\nMore __KEEP_999_999__",
            description: "```yaml\nExample\n```",
            tags: ["Tools\nextra\u0000", "Tools"],
          })
        : translate(request).text,
  }));
  const result = completeTranslation(plan, responses);
  assert.equal(
    parseArticle(result.files[0].text).fields.title,
    "Title\nMore __KEEP_999_999__"
  );
  const diagnostics = validateTranslation(plan, responses, result.files);
  for (const code of [
    "field-newline",
    "field-placeholder",
    "field-wrapper",
    "control-character",
  ])
    assert.ok(
      diagnostics.some(item => item.code === code),
      code
    );
  assert.ok(
    diagnostics.some(item =>
      /title, character 12.*__KEEP_999_999__/.test(item.message)
    )
  );
  assert.ok(
    diagnostics.some(item =>
      /tags\[0\], character 12.*U\+0000/.test(item.message)
    )
  );
});

test("checks the saved text and reports unreadable frontmatter without throwing", () => {
  const plan = prepareTranslation({ ...input, targetLocales: ["en"] });
  const responses = plan.requests.map(translate);
  const result = completeTranslation(plan, responses);
  const changed = result.files.map(file => ({
    ...file,
    text: file.text.replace("## Setup", "# Setup"),
  }));
  assert.ok(
    validateTranslation(plan, responses, changed).some(
      item =>
        item.code === "markdown-value" &&
        /depth.*expected 2, received 1/.test(item.message)
    )
  );
  const invalid = result.files.map(file => ({
    ...file,
    text: "Missing frontmatter",
  }));
  assert.deepEqual(
    validateTranslation(plan, responses, invalid).map(item => item.code),
    ["frontmatter", "tag-check-skipped"]
  );
});

test("does not warn about placeholder-looking text already present in plain fields", () => {
  const plan = prepareTranslation({
    ...input,
    targetLocales: ["en"],
    source: {
      ...input.source,
      text: "---\ntitle: Literal __KEEP_0_0__\ndescription: Example\n---\nBonjour.\n",
    },
  });
  const responses = plan.requests.map(translate);
  const result = completeTranslation(plan, responses);
  assert.deepEqual(validateTranslation(plan, responses, result.files), []);
  const changed = responses.map(response =>
    response.id.endsWith(":metadata")
      ? {
          ...response,
          text: JSON.stringify({
            ...JSON.parse(response.text),
            title: JSON.parse(response.text).title + " __KEEP_0_0__",
          }),
        }
      : response
  );
  assert.equal(
    validateTranslation(
      plan,
      changed,
      completeTranslation(plan, changed).files
    ).filter(item => item.code === "field-placeholder").length,
    1
  );
});

test("preserves significant leading indentation around protected blocks", () => {
  const plan = prepareTranslation({
    ...input,
    targetLocales: ["en"],
    source: {
      ...input.source,
      text: "---\ntitle: A\ndescription: B\n---\n    secret()\n\nBonjour.\n",
    },
  });
  const responses = plan.requests.map(translate);
  const result = completeTranslation(plan, responses);
  assert.equal(
    parseArticle(result.files[0].text).body,
    "    secret()\n\nHello.\n"
  );
  assert.deepEqual(validateTranslation(plan, responses, result.files), []);
});
