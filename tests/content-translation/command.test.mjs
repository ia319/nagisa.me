import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseTranslationArgs } from "../../scripts/content-translation/options.mjs";
import { runTranslationCommand } from "../../scripts/content-translation/command.mjs";
import {
  prepareWrites,
  writeTranslations,
} from "../../scripts/content-translation/write.mjs";
import { parseArticle } from "../../scripts/content-translation/frontmatter.mjs";
import { memoryFiles } from "./memory-files.mjs";
import { mockOllama } from "./mock-ollama.mjs";

const source =
  "---\ntitle: Bonjour\ndescription: Exemple\ntags: [Outils]\n---\nBonjour `code` et [guide](https://example.com).\n";
const registry = {
  defaultLocale: "fr",
  locales: {
    fr: { label: "Français", dir: "ltr" },
    en: { label: "English", dir: "ltr" },
    ar: { label: "العربية", dir: "rtl" },
    ja: { label: "日本語", dir: "ltr" },
  },
};
const args = [
  "src/data/blog/post.fr.md",
  "--to",
  "en",
  "--to",
  "ar",
  "--model",
  "example:12b",
];

function fixture(t, contents = {}) {
  const memory = memoryFiles(t, {
    "locales.config.mjs": `export default ${JSON.stringify(registry)};`,
    "src/data/blog/post.fr.md": source,
    ...contents,
  });
  const oldHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "127.0.0.1:11434";
  t.after(() => {
    if (oldHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = oldHost;
  });
  t.mock.method(globalThis, "fetch", async () => ({ ok: true }));
  const calls = mockOllama(t, ({ args, prompt }) => ({
    text:
      args[0] === "show"
        ? "Model info"
        : prompt
            .split("Text to translate:\n")
            .at(-1)
            .replaceAll("Bonjour", "Hello")
            .replaceAll("Outils", "Tools"),
  }));
  const controller = new AbortController();
  const messages = [];
  const report = message => messages.push(message);
  return {
    ...memory,
    calls,
    controller,
    messages,
    report,
    run: (input = args) =>
      runTranslationCommand(memory.root, input, report, controller.signal),
  };
}

test("parses repeated targets, pnpm separators, model precedence, and prompt options", () => {
  const result = parseTranslationArgs(
    [
      "--",
      ...args,
      "--from",
      "fr",
      "--prompt",
      "Use formal terms",
      "--prompt-mode",
      "replace",
      "--force",
    ],
    "fallback"
  );
  assert.equal(result.model, "example:12b");
  assert.deepEqual(result.targetLocales, ["en", "ar"]);
  assert.equal(result.promptMode, "replace");
  assert.equal(result.force, true);
  assert.equal(
    parseTranslationArgs(["--staged", "--to", "en"], "fallback").model,
    "fallback"
  );
  for (const invalid of [
    ["--to", "en"],
    ["a.md", "b.md", "--to", "en"],
    ["a.md", "--staged", "--to", "en"],
    ["a.md"],
    ["a.md", "--to", ""],
    ["a.md", "--to", "en", "--unknown"],
    ["a.md", "--to", "en", "--prompt", "a", "--prompt-file", "b"],
    ["a.md", "--to", "en", "--prompt-mode", "other"],
    ["a.md", "--to", "en", "--model", "a", "--model", "b"],
  ])
    assert.throws(() => parseTranslationArgs(invalid, "fallback"));
  assert.throws(
    () => parseTranslationArgs(["a.md", "--to", "en"], undefined),
    /--model/
  );
});

test("help returns before all filesystem, process, and network access", async t => {
  const messages = [];
  t.mock.method(fs, "realpath", () => assert.fail("Help accessed files"));
  t.mock.method(childProcess, "spawn", () =>
    assert.fail("Help spawned a process")
  );
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("Help accessed the network")
  );
  for (const input of [[], ["--"], ["--help"], ["-h"]])
    await runTranslationCommand(
      "unused",
      input,
      message => messages.push(message),
      new AbortController().signal
    );
  assert.ok(messages.every(message => message.startsWith("Usage:")));
});

test("generates every target before writing drafts and leaves source text unchanged", async t => {
  const { run, root, entries, calls, mutations } = fixture(t);
  const originalOpen = fs.open;
  let generatedBeforeWrite;
  t.mock.method(fs, "open", async (...input) => {
    generatedBeforeWrite ??= calls.filter(
      call => call.args[0] === "run"
    ).length;
    return originalOpen(...input);
  });
  await run();
  assert.equal(
    generatedBeforeWrite,
    calls.filter(call => call.args[0] === "run").length
  );
  for (const locale of ["en", "ar"]) {
    const article = parseArticle(
      entries.get(path.join(root, `src/data/blog/post.${locale}.md`)).text
    );
    assert.equal(article.fields.title, "Hello");
    assert.equal(article.document.get("draft"), true);
    assert.equal(article.document.getIn(["translation", "sourceLocale"]), "fr");
    assert.equal(
      article.document.getIn(["translation", "model"]),
      "example:12b"
    );
    assert.match(article.body, /Hello `code`/);
  }
  assert.equal(
    entries.get(path.join(root, "src/data/blog/post.fr.md")).text,
    source
  );
  assert.equal(mutations.filter(item => item[0] === "link").length, 2);
  assert.ok(
    ![...entries.keys()].some(file =>
      path.basename(file).startsWith(".translation-")
    )
  );
});

test("rejects existing targets before model calls and replaces them only with force", async t => {
  const { run, entries, root, calls, mutations } = fixture(t, {
    "src/data/blog/post.en.md": source,
  });
  await assert.rejects(run(), /already exists/);
  assert.deepEqual(calls, []);
  assert.deepEqual(mutations, []);
  await run([...args, "--force"]);
  assert.match(
    entries.get(path.join(root, "src/data/blog/post.en.md")).text,
    /title: Hello/
  );
  assert.equal(mutations.filter(item => item[0] === "rename").length, 1);
});

test("uses UTF-8 prompt-file content in replace mode and validates from and model names", async t => {
  const { run, calls, reads, root } = fixture(t, {
    "context.txt": "Use 正式 terminology",
  });
  await run([
    ...args,
    "--prompt-file",
    "context.txt",
    "--prompt-mode",
    "replace",
  ]);
  const prompt = calls.find(call => call.args[0] === "run").prompt;
  assert.ok(prompt.includes("Use 正式 terminology"));
  assert.ok(!prompt.includes("Translate technical blog content"));
  assert.ok(reads.includes(path.join(root, "context.txt")));
  await assert.rejects(run([...args, "--from", "en"]), /Source locale/);
  const clean = fixture(t);
  await assert.rejects(
    clean.run([...args.slice(0, -1), "bad\nmodel"]),
    /Model must/
  );
  assert.deepEqual(clean.calls, []);
});

test("a failed last target or invalid Markdown result produces no writes", async t => {
  for (const failure of ["process", "validation"]) {
    const { run, mutations } = fixture(t);
    mockOllama(t, ({ args, prompt }) => {
      if (args[0] === "show") return { text: "Model info" };
      if (prompt.includes("to ar."))
        return failure === "process"
          ? { code: 1, stderr: "failed" }
          : { text: "Missing protected content" };
      return { text: prompt.split("Text to translate:\n").at(-1) };
    });
    await assert.rejects(run(), /failed|placeholders/);
    assert.deepEqual(mutations, []);
  }
});

test("retains successful writes and reports failed and pending targets", async t => {
  const { run, entries, root, messages } = fixture(t, {
    "src/data/blog/post.en.md": source,
    "src/data/blog/post.ar.md": source,
  });
  const originalRename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to.endsWith("post.ar.md")) throw new Error("Permission denied");
    return originalRename(from, to);
  });
  await assert.rejects(
    run([...args, "--to", "ja", "--force"]),
    /Permission denied/
  );
  assert.match(
    entries.get(path.join(root, "src/data/blog/post.en.md")).text,
    /title: Hello/
  );
  assert.equal(
    entries.get(path.join(root, "src/data/blog/post.ar.md")).text,
    source
  );
  assert.ok(!entries.has(path.join(root, "src/data/blog/post.ja.md")));
  assert.ok(messages.some(message => message === "Completed: post.en.md"));
  assert.ok(messages.some(message => message === "Pending: post.ja.md"));
  assert.ok(
    messages.some(message => message.startsWith("Temporary file retained"))
  );
});

test("does not overwrite targets edited or created during translation", async t => {
  const { root, entries, report, controller, messages } = fixture(t);
  const prepared = await prepareWrites(root, [
    { path: "post.en.md", overwrite: false },
  ]);
  const target = path.join(root, "src/data/blog/post.en.md");
  entries.set(target, { kind: "file", text: "User edit" });
  await assert.rejects(
    writeTranslations(
      prepared,
      [{ path: "post.en.md", text: source }],
      report,
      controller.signal
    ),
    /changed during translation/
  );
  assert.equal(entries.get(target).text, "User edit");
  assert.ok(messages.some(message => message === "Completed: none"));
});

test("publishes new files without clobbering a target created at the final link", async t => {
  const { root, entries, report, controller } = fixture(t);
  const prepared = await prepareWrites(root, [
    { path: "post.en.md", overwrite: false },
  ]);
  t.mock.method(fs, "link", async (_from, to) => {
    entries.set(to, { kind: "file", text: "Concurrent file" });
    throw Object.assign(new Error("Target exists"), { code: "EEXIST" });
  });
  await assert.rejects(
    writeTranslations(
      prepared,
      [{ path: "post.en.md", text: source }],
      report,
      controller.signal
    ),
    /Target exists/
  );
  assert.equal(
    entries.get(path.join(root, "src/data/blog/post.en.md")).text,
    "Concurrent file"
  );
});

test("preserves published output and reports an unremoved temporary link", async t => {
  const { root, entries, report, controller, messages } = fixture(t);
  const prepared = await prepareWrites(root, [
    { path: "post.en.md", overwrite: false },
  ]);
  t.mock.method(fs, "unlink", async () => {
    throw new Error("Cleanup denied");
  });
  await writeTranslations(
    prepared,
    [{ path: "post.en.md", text: source }],
    report,
    controller.signal
  );
  assert.equal(
    entries.get(path.join(root, "src/data/blog/post.en.md")).text,
    source
  );
  assert.ok(
    messages.some(message => message.includes("temporary file retained"))
  );
});

test("rejects unsafe target directories and stops publication on cancellation", async t => {
  const { root, entries, report, controller, mutations } = fixture(t);
  for (const target of ["../outside.md", "missing/post.en.md", "post.txt"])
    await assert.rejects(
      prepareWrites(root, [{ path: target, overwrite: false }])
    );
  const prepared = await prepareWrites(root, [
    { path: "post.en.md", overwrite: false },
  ]);
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...input) => {
    const handle = await originalOpen(...input);
    controller.abort();
    return handle;
  });
  await assert.rejects(
    writeTranslations(
      prepared,
      [{ path: "post.en.md", text: source }],
      report,
      controller.signal
    ),
    /abort/i
  );
  assert.ok(mutations.some(item => item[0] === "close"));
  assert.ok(!entries.has(path.join(root, "src/data/blog/post.en.md")));
});

test("CLI exposes help and rejects invalid arguments without creating files", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const entry = path.join(root, "scripts/content-translation/translate.mjs");
  for (const input of [[], ["--help"], ["--"]]) {
    const { stdout } = await promisify(childProcess.execFile)(
      process.execPath,
      [entry, ...input],
      { cwd: root, encoding: "utf8" }
    );
    assert.match(stdout, /Usage: pnpm content:translate/);
  }
  await assert.rejects(
    promisify(childProcess.execFile)(process.execPath, [entry, "--to", "en"], {
      cwd: root,
      encoding: "utf8",
    }),
    /Provide exactly one source/
  );
});

test("staged command keeps index language and tag semantics through publication", async t => {
  const { run, root, entries, calls } = fixture(t, {
    "locales.config.mjs": "Unstaged configuration must not be executed",
    "src/data/blog/source.md": "Unstaged source must remain unchanged",
    "src/data/blog/ref.en.md": "Unstaged reference must not be parsed",
  });
  const blobs = [
    ["locales.config.mjs", `export default ${JSON.stringify(registry)};`],
    ["src/data/blog/source.md", source],
    ["src/data/blog/ref.md", source],
    [
      "src/data/blog/ref.en.md",
      source.replace(
        "tags: [Outils]",
        "tags: [Tools]\ntranslation:\n  sourceLocale: fr"
      ),
    ],
  ].map(([file, text], index) => ({
    file,
    text,
    oid: String(index + 1).padStart(40, "0"),
  }));
  t.mock.method(childProcess, "execFileSync", (command, input, options) => {
    assert.equal(command, "git");
    assert.equal(options.encoding, "utf8");
    if (input[0] === "rev-parse") return root;
    if (input[0] === "ls-files")
      return blobs.map(blob => `100644 ${blob.oid} 0\t${blob.file}\0`).join("");
    if (input[0] === "diff") return "src/data/blog/source.md\0";
    if (input[0] === "cat-file")
      return blobs.find(blob => blob.oid === input[2]).text;
    assert.fail(`Unexpected Git operation: ${input[0]}`);
  });
  await run(["--staged", "--to", "en", "--model", "example:12b"]);
  const output = parseArticle(
    entries.get(path.join(root, "src/data/blog/source.en.md")).text
  );
  assert.equal(output.document.getIn(["translation", "sourceLocale"]), "fr");
  assert.deepEqual(output.fields.tags, ["Tools"]);
  assert.ok(
    calls
      .filter(call => call.args[0] === "run")
      .every(call => !call.prompt.endsWith("\nOutils"))
  );
  assert.equal(
    entries.get(path.join(root, "src/data/blog/source.md")).text,
    "Unstaged source must remain unchanged"
  );
});
