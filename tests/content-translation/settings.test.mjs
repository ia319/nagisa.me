import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readTranslationSettings } from "../../scripts/content-translation/settings.mjs";
import { memoryFiles } from "./memory-files.mjs";

test("selects command and environment values without accessing unused configuration", async t => {
  t.mock.method(fs, "realpath", () =>
    assert.fail("Unused configuration was accessed")
  );
  const environment = { model: "environment:12b", host: "127.0.0.1:22434" };
  assert.equal(
    (
      await readTranslationSettings(
        "unused",
        { model: "command:12b" },
        environment
      )
    ).model,
    "command:12b"
  );
  assert.equal(
    (await readTranslationSettings("unused", {}, environment)).model,
    "environment:12b"
  );
  assert.deepEqual(
    await readTranslationSettings(
      "unused",
      { model: "command:12b", ollamaPort: "auto" },
      {}
    ),
    { model: "command:12b", service: { port: "auto" } }
  );
});

test("resolves service ownership without probing an address or mutating inputs", async t => {
  const { root } = memoryFiles(t, {});
  const environment = Object.freeze({
    model: "example:12b",
    host: "  https://example.com  ",
  });
  assert.deepEqual(
    (await readTranslationSettings(root, {}, environment)).service,
    {
      host: "https://example.com",
    }
  );
  for (const port of ["auto", 80, 22434]) {
    const options = Object.freeze({ ollamaPort: port });
    assert.deepEqual(
      (await readTranslationSettings(root, options, environment)).service,
      {
        port,
      }
    );
  }
  for (const host of [undefined, "", "   "])
    assert.deepEqual(
      (await readTranslationSettings(root, {}, { model: "example:12b", host }))
        .service,
      { port: "auto" }
    );
});

test("applies model and service precedence independently across all configured sources", async t => {
  const { root, reads, mutations } = memoryFiles(t, {
    "translation.config.mjs":
      'export default { model: "configured:12b", port: 23456 };',
  });
  for (const model of [undefined, "command:12b"])
    for (const environmentModel of [undefined, "", "   ", "environment:12b"])
      for (const ollamaPort of [undefined, "auto", 80, 22434])
        for (const host of [undefined, "", " 127.0.0.1:34567 "]) {
          const previousReads = reads.length;
          const result = await readTranslationSettings(
            root,
            { model, ollamaPort },
            { model: environmentModel, host }
          );
          assert.equal(
            result.model,
            model ??
              (environmentModel?.trim() ? environmentModel : "configured:12b")
          );
          assert.deepEqual(
            result.service,
            ollamaPort !== undefined
              ? { port: ollamaPort }
              : host?.trim()
                ? { host: host.trim() }
                : { port: 23456 }
          );
          const needsConfig =
            (!model && !environmentModel?.trim()) ||
            (ollamaPort === undefined && !host?.trim());
          assert.equal(reads.length - previousReads, needsConfig ? 1 : 0);
        }
  assert.deepEqual(mutations, []);
});

test("uses empty model and automatic port defaults without inventing a model", async t => {
  for (const text of [
    undefined,
    "export default {};",
    'export default { model: "", port: "auto" };',
    'export default { model: "   " };',
  ]) {
    const { root, mutations } = memoryFiles(
      t,
      text === undefined ? {} : { "translation.config.mjs": text }
    );
    const result = await readTranslationSettings(
      root,
      {},
      { model: "environment:12b" }
    );
    assert.deepEqual(result, {
      model: "environment:12b",
      service: { port: "auto" },
    });
    await assert.rejects(
      readTranslationSettings(root, {}, {}),
      /--model.*OLLAMA_TRANSLATE_MODEL.*translation\.config\.mjs/
    );
    assert.deepEqual(mutations, []);
  }
});

test("accepts fixed port endpoints and preserves nonempty names for existing validation", async t => {
  const { root, entries } = memoryFiles(t, { "translation.config.mjs": "" });
  for (const port of [1, 65535]) {
    entries.get(path.join(root, "translation.config.mjs")).text =
      `export default { model: " configured:12b ", port: ${port} };`;
    const result = await readTranslationSettings(root, {}, {});
    assert.equal(result.model, " configured:12b ");
    assert.equal(result.service.port, port);
  }
});

test("captures input and config values once and reloads changed text on the next invocation", async t => {
  const { root, entries, reads } = memoryFiles(t, {
    "translation.config.mjs":
      'export default { model: "first:12b", port: 22434 };',
  });
  const options = {};
  const environment = {};
  const opening = readTranslationSettings(root, options, environment);
  options.model = "late-command:12b";
  environment.host = "http://127.0.0.1:9999";
  const first = await opening;
  entries.get(path.join(root, "translation.config.mjs")).text =
    'export default { model: "second:12b", port: "auto" };';
  const second = await readTranslationSettings(root, {}, {});
  assert.deepEqual(first, { model: "first:12b", service: { port: 22434 } });
  assert.deepEqual(second, { model: "second:12b", service: { port: "auto" } });
  assert.equal(reads.length, 2);
});

test("rejects malformed configuration, unknown fields, and unsupported field types", async t => {
  const { root, entries, mutations } = memoryFiles(t, {
    "translation.config.mjs": "",
  });
  for (const text of [
    "broken syntax",
    "export const model = 'missing default';",
    "export default null;",
    "export default [];",
    "export default 'model';",
    "export default new Date();",
    "export default { models: 'typo' };",
    ...[1, false, null, [], {}].map(
      model => `export default ${JSON.stringify({ model })};`
    ),
    ...[0, -1, 65536, 1.5, "22434", "", "AUTO", null].map(
      port =>
        `export default ${JSON.stringify({ model: "configured:12b", port })};`
    ),
    "export default { port: NaN };",
    "export default { port: Infinity };",
    'import config from "./another.mjs"; export default config;',
  ]) {
    entries.get(path.join(root, "translation.config.mjs")).text = text;
    await assert.rejects(
      readTranslationSettings(root, {}, {}),
      /Cannot load translation\.config\.mjs:/
    );
  }
  assert.deepEqual(mutations, []);
});

test("does not hide unsafe paths or unreadable config behind missing-file defaults", async t => {
  for (const value of [
    { kind: "directory" },
    { kind: "symlink", target: path.resolve("outside-config.mjs") },
  ]) {
    const { root, reads } = memoryFiles(t, { "translation.config.mjs": value });
    await assert.rejects(
      readTranslationSettings(root, {}, {}),
      /Cannot load translation\.config\.mjs/
    );
    assert.deepEqual(reads, []);
  }
  const { root } = memoryFiles(t, {
    "translation.config.mjs": "export default {};",
  });
  for (const code of ["EACCES", "ENOENT"]) {
    t.mock.method(fs, "readFile", async () => {
      throw Object.assign(new Error("Read failed"), { code });
    });
    await assert.rejects(
      readTranslationSettings(root, {}, {}),
      /Cannot load translation\.config\.mjs: Read failed/
    );
  }
});
