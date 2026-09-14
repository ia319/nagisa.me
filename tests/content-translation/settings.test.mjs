import assert from "node:assert/strict";
import test from "node:test";
import { resolveTranslationSettings } from "../../scripts/content-translation/settings.mjs";

test("selects a command model before the captured environment model", () => {
  const environment = { model: "environment:12b" };
  assert.equal(
    resolveTranslationSettings({ model: "command:12b" }, environment).model,
    "command:12b"
  );
  assert.equal(
    resolveTranslationSettings({}, environment).model,
    "environment:12b"
  );
  for (const model of [undefined, "", "   "])
    assert.throws(() => resolveTranslationSettings({}, { model }), /--model/);
});

test("resolves service ownership without probing an address or mutating inputs", () => {
  const environment = Object.freeze({
    model: "example:12b",
    host: "  https://example.com  ",
  });
  assert.deepEqual(resolveTranslationSettings({}, environment).service, {
    host: "https://example.com",
  });
  for (const port of ["auto", 80, 22434]) {
    const options = Object.freeze({ ollamaPort: port });
    assert.deepEqual(resolveTranslationSettings(options, environment).service, {
      port,
    });
  }
  for (const host of [undefined, "", "   "])
    assert.deepEqual(
      resolveTranslationSettings({}, { model: "example:12b", host }).service,
      { port: "auto" }
    );
});
