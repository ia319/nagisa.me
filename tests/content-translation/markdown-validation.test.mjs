import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareMarkdown,
  restoreMarkdown,
} from "../../scripts/content-translation/markdown.mjs";
import { validateMarkdown } from "../../scripts/content-translation/markdown-validation.mjs";

test("distinguishes embedded definitions from deleted content without misaligning later notes", () => {
  const body =
    "[Read][guide] and [Short].\n\n![Picture][logo]\n\nText[^note].\n\n" +
    "<div>\nUnchanged HTML.\n</div>\n\n<!-- Keep this comment. -->\n\n" +
    "[guide]: https://example.com/reference\n[Short]: https://example.com/shortcut\n[logo]: /favicon.svg\n\n" +
    "[^note]: Footnote text.\n\n<!-- End. -->\n";
  const plan = prepareMarkdown(body);
  const saved = body.replace(
    "</div>\n\n<!-- Keep this comment. -->\n\n",
    "</div>\n<!-- Keep this comment. -->\n"
  );
  const groups = validateMarkdown(plan, plan.text, saved);
  const details = groups.flatMap(group => group.details);
  assert.equal(groups.length, 3);
  assert.equal(
    details.filter(item => item.code === "markdown-context").length,
    4
  );
  assert.equal(
    details.filter(item => item.code === "markdown-reference").length,
    3
  );
  assert.ok(!details.some(item => item.message.includes("footnoteDefinition")));
  assert.ok(
    !details.some(item =>
      item.message.includes("Expected definition, received no node")
    )
  );
  assert.ok(!details.some(item => item.message.includes("<!-- End. -->")));
  const contexts = details.filter(item => item.code === "markdown-context");
  for (const item of contexts) {
    const savedLine = saved.split("\n")[item.target.line - 1];
    assert.ok(savedLine.startsWith("<!--") || savedLine.startsWith("["));
  }
  const missing = body
    .replace("<!-- Keep this comment. -->\n\n", "")
    .replace("[guide]: https://example.com/reference\n", "")
    .replace("[Short]: https://example.com/shortcut\n", "")
    .replace("[logo]: /favicon.svg\n", "");
  const missingDetails = validateMarkdown(plan, plan.text, missing).flatMap(
    group => group.details
  );
  assert.equal(
    missingDetails.filter(
      item => item.message === "Expected definition, received no node"
    ).length,
    3
  );
  assert.ok(
    !missingDetails.some(item => item.message.includes("footnoteDefinition"))
  );
  assert.ok(!missingDetails.some(item => item.code === "markdown-context"));
  const missingNote = body.replace("[^note]: Footnote text.\n\n", "");
  assert.ok(
    validateMarkdown(plan, plan.text, missingNote).some(group =>
      group.details.some(
        item => item.message === "Expected footnoteDefinition, received no node"
      )
    )
  );
});

test("groups broken emphasis and missing code without losing repeated finding positions", () => {
  const body =
    "Before **first** and **second**, *third*, ~~fourth~~, `code`.\n\nUnchanged.\n";
  const plan = prepareMarkdown(body);
  const response =
    "Before ** first ** and ** second **, * third *, ~~ fourth ~~, removed.\n\nUnchanged.\n";
  const groups = validateMarkdown(plan, response, response);
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.source.line, 1);
  assert.equal(group.target.line, 1);
  assert.equal(group.code, "placeholder-missing");
  for (const kind of ["strong", "emphasis", "delete", "inlineCode"])
    assert.ok(
      group.details.some(
        item => item.message === "Expected " + kind + ", received no node"
      )
    );
  const missingStrong = group.details.filter(
    item => item.message === "Expected strong, received no node"
  );
  assert.equal(missingStrong.length, 2);
  assert.deepEqual(
    missingStrong.map(item => item.source.column),
    [8, 22]
  );
  assert.equal(group.original, JSON.stringify(body.split("\n\n")[0]));
  assert.equal(group.saved, JSON.stringify(response.split("\n\n")[0]));
});

test("keeps ordinary block alignment while using only unique protected nodes as anchors", () => {
  const heading = prepareMarkdown("## Heading\n\nFirst.\n\nSecond.\n");
  const response =
    "Translated first paragraph.\n\nTranslated second paragraph.\n";
  const groups = validateMarkdown(heading, response, response);
  assert.equal(groups.length, 1);
  assert.equal(
    groups[0].details[0].message,
    "Expected heading, received no node"
  );
  const repeated = prepareMarkdown(
    "<!-- Same -->\n\n<!-- Same -->\n\n[^note]: Note.\n"
  );
  const missing = "<!-- Same -->\n\n[^note]: Translated note.\n";
  const findings = validateMarkdown(repeated, repeated.text, missing).flatMap(
    group => group.details
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].message, "Expected html, received no node");
  assert.ok(
    !findings.some(item => item.message.includes("footnoteDefinition"))
  );
});

test("records each unknown token and control character at its actual saved offset", () => {
  const plan = prepareMarkdown("First.\n\nSecond.\n");
  const response = "First.\n\nSecond. __KEEP_9_9__ __KEEP_9_9__\u0000\n";
  const groups = validateMarkdown(plan, response, response);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].target.line, 3);
  const unknown = groups[0].details.filter(
    item => item.code === "placeholder-unknown"
  );
  assert.deepEqual(
    unknown.map(item => [item.target.line, item.target.column]),
    [
      [3, 9],
      [3, 22],
    ]
  );
  assert.equal(
    groups[0].details.find(item => item.code === "control-character").target
      .column,
    34
  );
  assert.equal(groups[0].original, JSON.stringify("Second."));
  assert.equal(
    groups[0].saved,
    JSON.stringify(response.split("\n\n")[1].trimEnd())
  );
});

test("checks tokens in the saved body while allowing original literal occurrences", () => {
  const plan = prepareMarkdown("Literal __KEEP_0_0__ and `__KEEP_2_0__`.\n");
  assert.deepEqual(validateMarkdown(plan, plan.text, plan.body), []);
  for (const token of [
    "__KEEP_9_9__",
    "__KEEP_0_0__",
    plan.protected[0].token,
  ]) {
    const saved = plan.body + "\nAdded " + token;
    const groups = validateMarkdown(plan, plan.text, saved);
    const expectedCode =
      token === plan.protected[0].token
        ? "placeholder-unrestored"
        : "placeholder-unknown";
    const findings = groups
      .flatMap(group => group.details)
      .filter(item => item.code === expectedCode);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].target.line, 3);
    assert.equal(findings[0].target.column, 7);
  }
});

test("reports reordered HTML tags after restoring the draft", () => {
  const plan = prepareMarkdown("Bonjour <span>monde</span>.\n");
  const [open, close] = plan.protected.map(item => item.token);
  const response = "Hello " + close + "world" + open + ".";
  const result = restoreMarkdown(plan, response);
  assert.equal(result, "Hello </span>world<span>.");
  assert.ok(
    validateMarkdown(plan, response, result).some(
      group =>
        group.source.line === 1 &&
        group.target.line === 1 &&
        group.details.some(
          item =>
            item.code === "markdown-value" &&
            item.message.includes("paragraph.html")
        )
    )
  );
});

test("reports missing, duplicate, and unknown placeholders without hiding formatting", () => {
  const plan = prepareMarkdown("Bonjour **monde** et `code`.\n");
  assert.equal(plan.protected.length, 1);
  assert.ok(plan.text.includes("**monde**"));
  const first = plan.protected[0].token;
  for (const [response, code, detail] of [
    [
      plan.text.replace(first, ""),
      "placeholder-missing",
      /inlineCode.*received 0.*original "`code`"/,
    ],
    [plan.text + first, "placeholder-duplicate", /received 2/],
    [
      plan.text + "__KEEP_999_999__",
      "placeholder-unknown",
      /was not sent and remains visible/,
    ],
  ]) {
    const result = restoreMarkdown(plan, response);
    assert.ok(
      validateMarkdown(plan, response, result).some(group =>
        group.details.some(
          item => item.code === code && detail.test(item.message)
        )
      ),
      code
    );
  }
});

test("keeps unknown tokens visible and does not guess where a missing code block belongs", () => {
  const body = "Bonjour.\n\n```js\nsecret()\n```\n";
  const plan = prepareMarkdown(body);
  const code = plan.protected.find(item => item.kind === "code-block");
  const response = plan.text.replace(code.token, "__KEEP_999_999__");
  const result = restoreMarkdown(plan, response);
  assert.ok(result.includes("__KEEP_999_999__"));
  assert.ok(!result.includes("secret()"));
  assert.ok(
    validateMarkdown(plan, response, result).some(
      group =>
        group.source.line === 3 &&
        group.source.column === 1 &&
        group.details.some(
          item =>
            item.code === "placeholder-missing" &&
            item.message.includes("code-block") &&
            item.message.includes("secret()")
        )
    )
  );
});

test("allows inline word-order changes and reports added blocks and changed structure precisely", () => {
  const plan = prepareMarkdown("Bonjour **monde**.\n");
  const response = "**World**, hello.";
  const result = restoreMarkdown(plan, response);
  assert.equal(result, "**World**, hello.");
  assert.deepEqual(validateMarkdown(plan, response, result), []);
  const plain = prepareMarkdown("Bonjour.\n");
  assert.ok(
    validateMarkdown(plain, "# Hello", "# Hello").some(group =>
      group.details.some(
        item =>
          item.code === "markdown-node" &&
          item.message === "Expected paragraph, received heading"
      )
    )
  );
  assert.ok(
    validateMarkdown(plain, "Hello\n\nMore", "Hello\n\nMore").some(
      group =>
        group.target.line === 3 &&
        group.details.some(
          item =>
            item.code === "markdown-node" &&
            item.message === "Expected no node, received paragraph"
        )
    )
  );
  const heading = prepareMarkdown("## Bonjour\n");
  assert.ok(
    validateMarkdown(heading, "# Hello", "# Hello").some(group =>
      group.details.some(
        item =>
          item.code === "markdown-value" &&
          /heading.depth.*expected 2, received 1/.test(item.message)
      )
    )
  );
});

test("reports dropped prose even when protected tokens survive", () => {
  const plan = prepareMarkdown("Bonjour `code`.\n");
  const response = plan.protected.map(item => item.token).join(" ");
  const result = restoreMarkdown(plan, response);
  assert.ok(
    validateMarkdown(plan, response, result).some(group =>
      group.details.some(
        item =>
          item.code === "markdown-value" &&
          /paragraph.prose.*expected true, received false/.test(item.message)
      )
    )
  );
});

test("reports omitted image descriptions even when image markers survive", () => {
  const plan = prepareMarkdown("![Bonjour](image.png)\n");
  const response = plan.text.replace("Bonjour", "");
  assert.ok(
    validateMarkdown(plan, response, restoreMarkdown(plan, response)).some(
      group =>
        group.details.some(
          item =>
            item.code === "markdown-value" &&
            /prose.*expected true, received false/.test(item.message)
        )
    )
  );
});
