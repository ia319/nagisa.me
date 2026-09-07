import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareMarkdown,
  restoreMarkdown,
} from "../../scripts/content-translation/markdown.mjs";

test("translates heading text, paragraphs, and image labels while preserving syntax", () => {
  const body =
    '## Installation\n\nBonjour **monde** et [guide](https://example.com "Title").\n\n![Image](./image.png)\n';
  const plan = prepareMarkdown(body);
  const results = plan.segments.map(segment =>
    segment.text
      .replace("Installation", "Setup")
      .replace("Bonjour", "Hello")
      .replace("monde", "world")
      .replace("guide", "manual")
      .replace("Image", "Picture")
  );
  assert.equal(
    restoreMarkdown(plan, results),
    '## Setup\n\nHello **world** et [manual](https://example.com "Title").\n\n![Picture](./image.png)\n'
  );
  assert.ok(
    !plan.segments.some(
      segment =>
        segment.text.includes("https://") || segment.text.includes("image.png")
    )
  );
});

test("preserves tables, task markers, quotes, lists, and line continuations", () => {
  const body =
    "| Nom | Valeur |\n| :--- | ---: |\n| Bonjour | `secret()` |\n\n- [x] Bonjour\n  suite\n- ~~Bonjour~~\n\n> Bonjour\n> suite\n\nTitre\n=====\n";
  const plan = prepareMarkdown(body);
  const translated = restoreMarkdown(
    plan,
    plan.segments.map(segment =>
      segment.text
        .replaceAll("Bonjour", "Hello")
        .replaceAll("suite", "continued")
        .replace("Nom", "Name")
        .replace("Valeur", "Value")
        .replace("Titre", "Title")
    )
  );
  assert.equal(
    translated,
    body
      .replaceAll("Bonjour", "Hello")
      .replaceAll("suite", "continued")
      .replace("Nom", "Name")
      .replace("Valeur", "Value")
      .replace("Titre", "Title")
  );
  assert.ok(plan.segments.every(segment => !segment.text.includes("\n")));
  assert.ok(!plan.segments.some(segment => segment.text.includes("secret()")));
});

test("never sends fenced code, inline code, automatic URLs, or common paths", () => {
  const body =
    'Bonjour `secret()` dans src/config.ts et C:\\work\\post.md. https://example.com/test\n\n```js title="example"\nsecret()\n```\n\n    secret()\n';
  const plan = prepareMarkdown(body);
  assert.equal(plan.segments.length, 1);
  const input = plan.segments[0].text;
  for (const protectedText of [
    "secret",
    "src/config.ts",
    "C:\\work\\post.md",
    "https://example.com",
  ])
    assert.ok(!input.includes(protectedText));
  assert.equal(
    restoreMarkdown(plan, [input.replace("Bonjour", "Hello")]),
    body.replace("Bonjour", "Hello")
  );
});

test("retains HTML attributes, footnotes, and explicit reference destinations", () => {
  const body =
    'Bonjour <span data-key="secret">monde</span> et [guide][docs][^a].\n\n[docs]: https://example.com\n[^a]: Bonjour\n';
  const plan = prepareMarkdown(body);
  assert.equal(
    restoreMarkdown(
      plan,
      plan.segments.map(segment =>
        segment.text
          .replaceAll("Bonjour", "Hello")
          .replace("monde", "world")
          .replace("guide", "manual")
      )
    ),
    body
      .replaceAll("Bonjour", "Hello")
      .replace("monde", "world")
      .replace("[guide]", "[manual]")
  );
});

test("reports preserved raw HTML and shortcut references without rewriting them", () => {
  const body =
    "Bonjour [Guide].\n\n[Guide]: https://example.com\n\n<div>Bonjour</div>\n";
  const plan = prepareMarkdown(body);
  assert.ok(
    plan.diagnostics.some(item => item.code === "protected-reference-label")
  );
  assert.ok(
    plan.diagnostics.some(item => item.code === "protected-html-block")
  );
  assert.equal(
    restoreMarkdown(
      plan,
      plan.segments.map(segment => segment.text.replace("Bonjour", "Hello"))
    ),
    body.replace("Bonjour", "Hello")
  );
});

test("translates explicit image reference labels and preserves implicit targets", () => {
  const body = "![Bonjour][image] et ![Image][]\n\n[image]: ./example.png\n";
  const plan = prepareMarkdown(body);
  assert.ok(
    plan.diagnostics.some(item => item.code === "protected-reference-label")
  );
  assert.equal(
    restoreMarkdown(
      plan,
      plan.segments.map(segment => segment.text.replace("Bonjour", "Hello"))
    ),
    body.replace("Bonjour", "Hello")
  );
});

test("rejects reordered raw HTML tags even when placeholders are complete", () => {
  const plan = prepareMarkdown("Bonjour <span>monde</span>.\n");
  const [open, close] = plan.segments[0].protected.map(item => item.token);
  assert.throws(
    () => restoreMarkdown(plan, [`Hello ${close}world${open}.`]),
    /changed the source structure/
  );
});

test("keeps anchor targets and reports the need to review translated headings", () => {
  const body = "## Installation\n\nVoir [guide](#installation).\n";
  const plan = prepareMarkdown(body);
  assert.equal(
    plan.diagnostics.filter(item => item.code === "review-heading-anchor")
      .length,
    1
  );
  assert.equal(
    restoreMarkdown(
      plan,
      plan.segments.map(segment =>
        segment.text.replace("Installation", "Setup")
      )
    ),
    body.replace("Installation", "Setup")
  );
});

test("avoids placeholder collisions with existing article text", () => {
  const body = "Bonjour __KEEP_0_0__ et `code`.\n";
  const plan = prepareMarkdown(body);
  assert.equal(
    restoreMarkdown(
      plan,
      plan.segments.map(segment => segment.text)
    ),
    body
  );
});

test("rejects missing, duplicate, unknown, or incorrectly paired placeholders", () => {
  const plan = prepareMarkdown("Bonjour **monde** et `code`.\n");
  const segment = plan.segments[0];
  const first = segment.protected[0].token;
  const closing = segment.protected.find(item => item.side === "close").token;
  for (const text of [
    segment.text.replace(first, ""),
    segment.text + first,
    segment.text.replace(first, "__KEEP_999_999__"),
  ]) {
    assert.throws(() => restoreMarkdown(plan, [text]), /Invalid placeholders/);
  }
  assert.throws(
    () =>
      restoreMarkdown(plan, [
        segment.text
          .replace(first, "SWAP")
          .replace(closing, first)
          .replace("SWAP", closing),
      ]),
    /syntax pairing/
  );
});

test("allows natural word order changes while rejecting new Markdown structure", () => {
  const plan = prepareMarkdown("Bonjour **monde**.\n");
  const [open, close] = plan.segments[0].protected.map(item => item.token);
  assert.equal(
    restoreMarkdown(plan, [`${open}World${close}, hello.`]),
    "**World**, hello.\n"
  );
  assert.throws(
    () => restoreMarkdown(plan, ["# Added heading"]),
    /placeholders/
  );
  const plain = prepareMarkdown("Bonjour.\n");
  assert.throws(
    () => restoreMarkdown(plain, ["# Added heading"]),
    /changed the source structure/
  );
  assert.throws(
    () => restoreMarkdown(plain, ["Hello\n\nNew paragraph"]),
    /Invalid Markdown result/
  );
});

test("preserves code-only content without requests and rejects incomplete results", () => {
  const body = "```txt\nBonjour\n```\n";
  const plan = prepareMarkdown(body);
  assert.deepEqual(plan.segments, []);
  assert.equal(restoreMarkdown(plan, []), body);
  assert.throws(
    () => restoreMarkdown(prepareMarkdown("Bonjour"), []),
    /count mismatch/
  );
});

test("uses source offsets correctly with Unicode text and protected Unicode paths", () => {
  const body =
    "## 安装😀\n\n读取 文档/安装.md 并查看[说明](./文档/安装.md)。\n";
  const plan = prepareMarkdown(body);
  const translated = restoreMarkdown(
    plan,
    plan.segments.map(segment =>
      segment.text
        .replace("安装😀", "Setup😀")
        .replace("读取", "Read")
        .replace("并查看", "and see")
        .replace("说明", "guide")
    )
  );
  assert.equal(
    translated,
    "## Setup😀\n\nRead 文档/安装.md and see[guide](./文档/安装.md)。\n"
  );
  assert.ok(
    !plan.segments.some(segment => segment.text.includes("文档/安装.md"))
  );
});

test("rejects a response that preserves tokens but drops all translated prose", () => {
  const plan = prepareMarkdown("Bonjour `code`.\n");
  assert.throws(
    () =>
      restoreMarkdown(plan, [
        plan.segments[0].protected.map(item => item.token).join(" "),
      ]),
    /Missing translated text/
  );
});
