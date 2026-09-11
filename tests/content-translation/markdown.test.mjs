import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareMarkdown,
  restoreMarkdown,
} from "../../scripts/content-translation/markdown.mjs";
import { validateMarkdown } from "../../scripts/content-translation/markdown-validation.mjs";

test("keeps resource boundaries canonical for nested URLs, escaped labels, titles, and Unicode", () => {
  for (const body of [
    "[Read](https://example.com/a(b(c)) \"A title\") and ![Picture](<./a b.png> 'Caption').\n",
    '[Read](./a\\(b\\).md "A \\"quote\\" title") and ![A \\] label](./图像.png).\n',
    '[Read][a\\]b]\n\n[a\\]b]: <./a b.md> "Title"\n',
  ]) {
    const plan = prepareMarkdown(body);
    assert.equal(restoreMarkdown(plan, plan.text), body);
    assert.deepEqual(validateMarkdown(plan, plan.text, body), []);
    assert.ok(!plan.text.includes("example.com"));
    assert.ok(!plan.text.includes("图像.png"));
  }
});

test("flags source bare-URL punctuation without trimming legitimate Unicode URLs", () => {
  const body = "See https://example.com/文档，继续阅读。\n";
  const plan = prepareMarkdown(body);
  const warning = plan.diagnostics.find(
    item => item.code === "source-url-boundary"
  );
  assert.equal(warning.source.column, 5);
  assert.match(warning.message, /文档，继续阅读/);
  assert.equal(restoreMarkdown(plan, plan.text), body);
  for (const source of [
    "See <https://example.com/文档>，继续阅读。\n",
    "See https://example.com/文档\n",
  ])
    assert.ok(
      !prepareMarkdown(source).diagnostics.some(
        item => item.code === "source-url-boundary"
      )
    );
});

test("does not mistake ordered code-only content for prose", () => {
  const plan = prepareMarkdown("1. `secret()`\n2. `other()`\n");
  assert.equal(plan.needsTranslation, false);
  assert.equal(restoreMarkdown(plan, plan.text), plan.body);
});

test("translates one complete body while preserving inline syntax and image labels", () => {
  const body =
    '## Installation\n\nBonjour **monde** et [guide](https://example.com "Title").\n\n![Image](./image.png)\n';
  const plan = prepareMarkdown(body);
  const response = plan.text
    .replace("Installation", "Setup")
    .replace("Bonjour", "Hello")
    .replace("monde", "world")
    .replace("guide", "manual")
    .replace("Image", "Picture");
  const result = restoreMarkdown(plan, response);
  assert.equal(
    result,
    '## Setup\n\nHello **world** et [manual](https://example.com "Title").\n\n![Picture](./image.png)\n'
  );
  assert.ok(plan.text.includes("\n\n"));
  assert.ok(!plan.text.includes("https://"));
  assert.ok(!plan.text.includes("image.png"));
  assert.deepEqual(validateMarkdown(plan, response, result), []);
});

test("preserves tables, task markers, quotes, lists, and line continuations", () => {
  const body =
    "| Nom | Valeur |\n| :--- | ---: |\n| Bonjour | `secret()` |\n\n- [x] Bonjour\n  suite\n- ~~Bonjour~~\n\n> Bonjour\n> suite\n\nTitre\n=====\n";
  const plan = prepareMarkdown(body);
  const response = plan.text
    .replaceAll("Bonjour", "Hello")
    .replaceAll("suite", "continued")
    .replace("Nom", "Name")
    .replace("Valeur", "Value")
    .replace("Titre", "Title");
  const result = restoreMarkdown(plan, response);
  assert.equal(
    result,
    body
      .replaceAll("Bonjour", "Hello")
      .replaceAll("suite", "continued")
      .replace("Nom", "Name")
      .replace("Valeur", "Value")
      .replace("Titre", "Title")
  );
  assert.ok(!plan.text.includes("secret()"));
  assert.deepEqual(validateMarkdown(plan, response, result), []);
});

test("keeps fenced and indented code, inline code, URLs, and paths entirely local", () => {
  const body =
    'Bonjour `secret()` dans src/config.ts et C:\\work\\post.md. https://example.com/test\n\n~~~js title="example"\nsecret()\n~~~\n\n    secret()\n\n- Item\n\n  ```js\n  nested()\n  ```\n\n> ```txt\n> quoted code\n> ```\n';
  const plan = prepareMarkdown(body);
  for (const value of [
    "secret",
    "nested()",
    "quoted code",
    "src/config.ts",
    "C:\\work\\post.md",
    "https://example.com",
    'title="example"',
  ])
    assert.ok(!plan.text.includes(value), value);
  assert.equal(
    plan.protected.filter(item => item.kind === "code-block").length,
    4
  );
  const response = plan.text.replace("Bonjour", "Hello");
  const result = restoreMarkdown(plan, response);
  assert.equal(result, body.replace("Bonjour", "Hello"));
  assert.deepEqual(validateMarkdown(plan, response, result), []);
});

test("retains inline HTML attributes, footnotes, and reference definitions", () => {
  const body =
    'Bonjour <span data-key="secret">monde</span> et [guide][docs][^a].\n\n[docs]: https://example.com\n[^a]: Bonjour\n';
  const plan = prepareMarkdown(body);
  const response = plan.text
    .replaceAll("Bonjour", "Hello")
    .replace("monde", "world")
    .replace("guide", "manual");
  const result = restoreMarkdown(plan, response);
  assert.equal(
    result,
    body
      .replaceAll("Bonjour", "Hello")
      .replace("monde", "world")
      .replace("[guide]", "[manual]")
  );
  assert.ok(!plan.text.includes("data-key"));
  assert.ok(!plan.text.includes("https://"));
  assert.deepEqual(validateMarkdown(plan, response, result), []);
});

test("reports protected HTML blocks and implicit reference labels with source lines", () => {
  const body =
    "Bonjour [Guide].\n\n[Guide]: https://example.com\n\n<div>Bonjour</div>\n";
  const plan = prepareMarkdown(body);
  assert.ok(
    plan.diagnostics.some(
      item =>
        item.code === "protected-reference-label" && item.source.line === 1
    )
  );
  assert.ok(
    plan.diagnostics.some(
      item => item.code === "protected-html-block" && item.source.line === 5
    )
  );
  const response = plan.text.replace("Bonjour", "Hello");
  const result = restoreMarkdown(plan, response);
  assert.equal(result, body.replace("Bonjour", "Hello"));
  assert.ok(!plan.text.includes("<div>"));
  assert.ok(!plan.text.includes("[Guide]"));
  assert.deepEqual(validateMarkdown(plan, response, result), []);
});

test("translates explicit image reference labels and preserves implicit targets", () => {
  const body = "![Bonjour][image] et ![Image][]\n\n[image]: ./example.png\n";
  const plan = prepareMarkdown(body);
  assert.ok(
    plan.diagnostics.some(item => item.code === "protected-reference-label")
  );
  const response = plan.text.replace("Bonjour", "Hello");
  const result = restoreMarkdown(plan, response);
  assert.equal(result, body.replace("Bonjour", "Hello"));
  assert.deepEqual(validateMarkdown(plan, response, result), []);
});

test("does not mistake existing placeholder-looking source text for its protocol", () => {
  const body = "Bonjour __KEEP_0_0__ et `code`.\n";
  const plan = prepareMarkdown(body);
  assert.ok(plan.protected.every(item => item.token.startsWith("__KEEP_1_")));
  assert.equal(restoreMarkdown(plan, plan.text), body);
  assert.deepEqual(validateMarkdown(plan, plan.text, body), []);
});

test("retains code-only bodies without needing a model request", () => {
  const body = "```txt\nBonjour\n```\n";
  const plan = prepareMarkdown(body);
  assert.equal(plan.needsTranslation, false);
  assert.equal(restoreMarkdown(plan, plan.text), body);
  assert.deepEqual(validateMarkdown(plan, plan.text, body), []);
});

test("uses Unicode source offsets and keeps protected paths unchanged", () => {
  const body =
    "## 安装😀\n\n读取 文档/安装.md 并查看[说明](./文档/安装.md)。\n";
  const plan = prepareMarkdown(body);
  const response = plan.text
    .replace("安装😀", "Setup😀")
    .replace("读取", "Read")
    .replace("并查看", "and see")
    .replace("说明", "guide");
  const result = restoreMarkdown(plan, response);
  assert.equal(
    result,
    "## Setup😀\n\nRead 文档/安装.md and see[guide](./文档/安装.md)。\n"
  );
  assert.ok(!plan.text.includes("文档/安装.md"));
  assert.deepEqual(validateMarkdown(plan, response, result), []);
});
