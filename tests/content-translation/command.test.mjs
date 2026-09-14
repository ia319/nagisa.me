import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";
import { parseTranslationArgs } from "../../scripts/content-translation/options.mjs";
import { runTranslationCommand } from "../../scripts/content-translation/command.mjs";
import {
  prepareWrites,
  writeTranslations,
} from "../../scripts/content-translation/write.mjs";
import { parseArticle } from "../../scripts/content-translation/frontmatter.mjs";
import { memoryFiles } from "./memory-files.mjs";
import { captureOllamaOutput, mockOllama } from "./mock-ollama.mjs";
import { mockOllamaPorts } from "./mock-ollama-ports.mjs";
import { mockOllamaSupervisor } from "./mock-ollama-supervisor.mjs";

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
  const oldModel = process.env.OLLAMA_TRANSLATE_MODEL;
  delete process.env.OLLAMA_TRANSLATE_MODEL;
  process.env.OLLAMA_HOST = "127.0.0.1:11434";
  t.after(() => {
    if (oldHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = oldHost;
    if (oldModel === undefined) delete process.env.OLLAMA_TRANSLATE_MODEL;
    else process.env.OLLAMA_TRANSLATE_MODEL = oldModel;
  });
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ version: "0.0.0-test" })
  );
  t.mock.method(
    childProcess,
    "execFile",
    (command, input, options, callback) => {
      assert.equal(command, "powershell.exe");
      assert.equal(options.encoding, "utf8");
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      assert.ok(input.includes("-NonInteractive"));
      assert.ok(!input.join(" ").includes(memory.root));
      assert.ok(memory.entries.has(options.env.TRANSLATION_OWNER_TARGET));
      assert.ok(memory.entries.has(options.env.TRANSLATION_OWNER_TEMP));
      callback(null, "same\n");
    }
  );
  const calls = mockOllama(t, ({ args, prompt }) => {
    if (args[0] === "show") return { text: "Model info" };
    const text = prompt
      .split("Text to translate:\n")
      .at(-1)
      .replaceAll("Bonjour", "Hello")
      .replaceAll("Outils", "Tools");
    return {
      text: args.includes("--format") ? JSON.stringify(parse(text)) : text,
    };
  });
  const controller = new AbortController();
  const messages = [];
  const report = message => messages.push(message);
  const captured = captureOllamaOutput();
  return {
    ...memory,
    calls,
    controller,
    messages,
    report,
    ...captured,
    run: (input = args) =>
      runTranslationCommand(
        memory.root,
        input,
        report,
        controller.signal,
        captured.output
      ),
  };
}

test("parses explicit targets, model, pnpm separators, and prompt options", () => {
  const result = parseTranslationArgs([
    "--",
    ...args,
    "--from",
    "fr",
    "--prompt",
    "Use formal terms",
    "--prompt-mode",
    "replace",
    "--force",
  ]);
  assert.equal(result.model, "example:12b");
  assert.deepEqual(result.targetLocales, ["en", "ar"]);
  assert.equal(result.promptMode, "replace");
  assert.equal(result.force, true);
  assert.equal(
    parseTranslationArgs(["--staged", "--to", "en"]).model,
    undefined
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
    assert.throws(() => parseTranslationArgs(invalid));
  assert.throws(
    () => parseTranslationArgs(["a.md", "--to", "en", "--model", ""]),
    /--model/
  );
});

test("parses explicit and automatic service ports and rejects invalid or repeated values", () => {
  assert.equal(parseTranslationArgs(args).ollamaPort, undefined);
  for (const port of ["auto", "1", "65535", "22434"])
    assert.equal(
      parseTranslationArgs([...args, "--ollama-port", port]).ollamaPort,
      port === "auto" ? "auto" : Number(port)
    );
  for (const port of [
    "",
    "0",
    "65536",
    "-1",
    "1.5",
    "0x1234",
    "+80",
    " 80",
    "NaN",
    "AUTO",
  ])
    assert.throws(
      () => parseTranslationArgs([...args, "--ollama-port", port]),
      /ollama-port/
    );
  assert.throws(
    () =>
      parseTranslationArgs([
        ...args,
        "--ollama-port",
        "auto",
        "--ollama-port",
        "22434",
      ]),
    /Do not repeat --ollama-port/
  );
});

test("uses configured model and port for every request and records the chosen model", async t => {
  for (const port of ["auto", 22434]) {
    const config = `export default ${JSON.stringify({ model: "configured:12b", port })};`;
    const { run, calls, entries, root, reads, mutations } = fixture(t, {
      "translation.config.mjs": config,
    });
    delete process.env.OLLAMA_HOST;
    const ports = mockOllamaPorts(t);
    const servers = mockOllamaSupervisor(t);
    await run(args.slice(0, -2));
    assert.equal(ports[0].port, port === "auto" ? 0 : port);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].stops, 1);
    assert.ok(calls.every(call => call.args[1] === "configured:12b"));
    assert.ok(
      calls.every(
        call =>
          call.options.env.OLLAMA_HOST ===
          `http://127.0.0.1:${ports[0].selected}/`
      )
    );
    for (const locale of ["en", "ar"]) {
      const output = parseArticle(
        entries.get(path.join(root, `src/data/blog/post.${locale}.md`)).text
      );
      assert.equal(
        output.document.getIn(["translation", "model"]),
        "configured:12b"
      );
    }
    const configPath = path.join(root, "translation.config.mjs");
    assert.equal(reads.filter(file => file === configPath).length, 1);
    assert.equal(entries.get(configPath).text, config);
    assert.ok(mutations.every(operation => !operation.includes(configPath)));
    assert.equal(process.env.OLLAMA_HOST, undefined);
    assert.equal(process.env.OLLAMA_TRANSLATE_MODEL, undefined);
  }
});

test("keeps command and environment overrides independent of saved defaults", async t => {
  for (const selection of ["command-model", "environment", "command-port"]) {
    const { run, calls, reads, root } = fixture(t, {
      "translation.config.mjs":
        'export default { model: "configured:12b", port: 23456 };',
    });
    const ports = mockOllamaPorts(t);
    const servers = mockOllamaSupervisor(t);
    if (selection === "command-model") {
      delete process.env.OLLAMA_HOST;
      await run();
      assert.equal(ports[0].port, 23456);
      assert.ok(calls.every(call => call.args[1] === "example:12b"));
    } else if (selection === "environment") {
      process.env.OLLAMA_TRANSLATE_MODEL = "environment:12b";
      await run(args.slice(0, -2));
      assert.equal(
        reads.includes(path.join(root, "translation.config.mjs")),
        false
      );
      assert.deepEqual(ports, []);
      assert.deepEqual(servers, []);
      assert.ok(calls.every(call => call.args[1] === "environment:12b"));
      assert.ok(
        calls.every(
          call => call.options.env.OLLAMA_HOST === "http://127.0.0.1:11434/"
        )
      );
    } else {
      process.env.OLLAMA_HOST = "https://example.com";
      await run([...args.slice(0, -2), "--ollama-port", "auto"]);
      assert.equal(ports[0].port, 0);
      assert.ok(calls.every(call => call.args[1] === "configured:12b"));
      assert.equal(process.env.OLLAMA_HOST, "https://example.com");
    }
  }
});

test("fails invalid or empty configuration before any service, model, or article write", async t => {
  for (const config of [
    "export default {};",
    'export default { model: 12, port: "auto" };',
    'export default { model: "local", port: 0 };',
    'export default { model: " local ", port: "auto" };',
  ]) {
    const { run, mutations, calls } = fixture(t, {
      "translation.config.mjs": config,
    });
    delete process.env.OLLAMA_HOST;
    const ports = mockOllamaPorts(t);
    const servers = mockOllamaSupervisor(t);
    await assert.rejects(run(args.slice(0, -2)), /model|Model|port/);
    assert.deepEqual(calls, []);
    assert.deepEqual(ports, []);
    assert.deepEqual(servers, []);
    assert.deepEqual(mutations, []);
  }
});

test("does not claim an occupied configured port or fall back from a missing selected model", async t => {
  for (const failure of ["port", "model"]) {
    const { run, mutations } = fixture(t, {
      "translation.config.mjs":
        'export default { model: "configured:12b", port: 22434 };',
    });
    delete process.env.OLLAMA_HOST;
    const ports = mockOllamaPorts(
      t,
      failure === "port"
        ? [Object.assign(new Error("occupied"), { code: "EADDRINUSE" })]
        : []
    );
    const calls = mockOllama(t, () => ({ code: 1, stderr: "model not found" }));
    const servers = mockOllamaSupervisor(t);
    await assert.rejects(
      run(args.slice(0, -2)),
      failure === "port" ? /port 22434.*EADDRINUSE/ : /model is not installed/
    );
    assert.equal(ports.length, 1);
    if (failure === "port") {
      assert.deepEqual(servers, []);
      assert.deepEqual(calls, []);
    } else {
      assert.equal(servers[0].stops, 1);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, ["show", "configured:12b"]);
    }
    assert.deepEqual(mutations, []);
  }
});

test("cancels configured service execution without changing articles or configuration", async t => {
  const { run, controller, mutations } = fixture(t, {
    "translation.config.mjs":
      'export default { model: "configured:12b", port: "auto" };',
  });
  delete process.env.OLLAMA_HOST;
  mockOllamaPorts(t);
  mockOllama(t, ({ args }) => {
    if (args[0] === "show") return { text: "Model info" };
    controller.abort(new Error("Translation cancelled"));
    return { hang: true };
  });
  const servers = mockOllamaSupervisor(t);
  await assert.rejects(run(args.slice(0, -2)), /Translation cancelled/);
  assert.equal(servers[0].stops, 1);
  assert.deepEqual(mutations, []);
});

test("starts a private service only for real requests and stops it after saved-draft checks", async t => {
  const { run, calls, messages, entries, root } = fixture(t);
  delete process.env.OLLAMA_HOST;
  const ports = mockOllamaPorts(t);
  const servers = mockOllamaSupervisor(t, {
    stop(call) {
      assert.match(messages.at(-1), /Generated 2 draft/);
      assert.ok(entries.has(path.join(root, "src/data/blog/post.en.md")));
      assert.ok(entries.has(path.join(root, "src/data/blog/post.ar.md")));
      call.event("stopped");
      call.close();
    },
  });
  await run();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].stops, 1);
  assert.equal(ports.length, 1);
  assert.ok(
    calls.every(
      call => call.options.env.OLLAMA_HOST === "http://127.0.0.1:42000/"
    )
  );
  assert.equal(process.env.OLLAMA_HOST, undefined);
});

test("leaves an unavailable external service unmanaged", async t => {
  const { run, calls } = fixture(t);
  const ports = mockOllamaPorts(t);
  const servers = mockOllamaSupervisor(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("connection refused");
  });
  await assert.rejects(run(), /service is unavailable.*Start it manually/);
  assert.deepEqual(calls, []);
  assert.deepEqual(ports, []);
  assert.deepEqual(servers, []);
});

test("keeps preflight errors and zero-request articles outside the service lifecycle", async t => {
  const { run, calls } = fixture(t, {
    "translation.config.mjs":
      'export default { model: "configured:12b", port: 22434 };',
    "src/data/blog/post.fr.md":
      "---\ntitle: ''\ndescription: ''\n---\n```text\nKeep this.\n```\n",
  });
  delete process.env.OLLAMA_HOST;
  const ports = mockOllamaPorts(t);
  const servers = mockOllamaSupervisor(t);
  await assert.rejects(run(["missing.md", "--to", "en", "--model", "local"]));
  await assert.rejects(run([...args, "--to", "fr"]), /source language/);
  await run(args.slice(0, -2));
  assert.deepEqual(calls, []);
  assert.deepEqual(ports, []);
  assert.deepEqual(servers, []);
});

test("stops its service on generation failure and preserves the primary error if cleanup fails", async t => {
  for (const cleanupFailure of [false, true]) {
    const { run, entries, root, messages } = fixture(t);
    mockOllama(t, () => ({ code: 1, stderr: "model not found" }));
    mockOllamaPorts(t);
    const servers = mockOllamaSupervisor(t, {
      stop(call) {
        if (!cleanupFailure) call.event("stopped");
        call.close(cleanupFailure ? 1 : 0);
      },
    });
    await assert.rejects(
      run([...args, "--ollama-port", "22434"]),
      /model is not installed/
    );
    assert.equal(servers[0].stops, 1);
    assert.equal(
      entries.has(path.join(root, "src/data/blog/post.en.md")),
      false
    );
    assert.equal(
      messages.some(message => message.startsWith("[cleanup]")),
      cleanupFailure
    );
  }
});

test("retains all saved drafts when final service cleanup cannot be confirmed", async t => {
  const { run, entries, root, messages } = fixture(t);
  mockOllamaPorts(t);
  mockOllamaSupervisor(t, {
    stop(call) {
      call.close(1);
    },
  });
  await assert.rejects(
    run([...args, "--ollama-port", "auto"]),
    /Ollama cleanup failed.*Any saved drafts were kept/s
  );
  for (const locale of ["en", "ar"])
    assert.ok(entries.has(path.join(root, `src/data/blog/post.${locale}.md`)));
  assert.match(messages.at(-1), /Generated 2 draft/);
});

test("cancels both model execution and its owned service without writing drafts", async t => {
  const { run, controller, entries, root } = fixture(t);
  mockOllama(t, async ({ args }) => {
    if (args[0] === "show") return { text: "Model info" };
    controller.abort(new Error("Translation cancelled"));
    return { text: "Partial response" };
  });
  mockOllamaPorts(t);
  const servers = mockOllamaSupervisor(t);
  await assert.rejects(
    run([...args, "--ollama-port", "auto"]),
    /Translation cancelled/
  );
  assert.equal(servers[0].stops, 1);
  assert.equal(entries.has(path.join(root, "src/data/blog/post.en.md")), false);
});

test("does not let force claim an occupied service port", async t => {
  const { run, calls } = fixture(t);
  mockOllamaPorts(t, [
    Object.assign(new Error("occupied"), { code: "EADDRINUSE" }),
  ]);
  const servers = mockOllamaSupervisor(t);
  await assert.rejects(
    run([...args, "--force", "--ollama-port", "22434"]),
    /port 22434.*EADDRINUSE/
  );
  assert.deepEqual(servers, []);
  assert.deepEqual(calls, []);
});

test("stops generation when its service exits without treating it as user cancellation", async t => {
  const { run, controller, entries, root } = fixture(t);
  let servers;
  mockOllama(t, async ({ args }) => {
    if (args[0] === "show") return { text: "Model info" };
    servers[0].child.stderr.write("service crashed during generation");
    servers[0].event("stopped");
    servers[0].close(1);
    await new Promise(resolve => setImmediate(resolve));
    return { text: "Incomplete response" };
  });
  mockOllamaPorts(t);
  servers = mockOllamaSupervisor(t);
  await assert.rejects(
    run([...args, "--ollama-port", "auto"]),
    /service crashed during generation/
  );
  assert.equal(controller.signal.aborted, false);
  assert.equal(entries.has(path.join(root, "src/data/blog/post.en.md")), false);
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

test("resolves one service address for all probes and model processes in the command", async t => {
  const { run, calls } = fixture(t);
  process.env.OLLAMA_HOST = "0.0.0.0:22434";
  const probes = [];
  t.mock.method(globalThis, "fetch", async url => {
    probes.push(url);
    process.env.OLLAMA_HOST = "https://example.com";
    return Response.json({ version: "0.0.0-test" });
  });
  await run();
  assert.equal(probes.length, 8);
  assert.equal(calls.length, 8);
  assert.ok(probes.every(url => url === "http://127.0.0.1:22434/api/version"));
  assert.ok(
    calls.every(
      call => call.options.env.OLLAMA_HOST === "http://127.0.0.1:22434/"
    )
  );
  assert.equal(process.env.OLLAMA_HOST, "https://example.com");
});

test("rejects invalid service addresses before contacting a server or writing drafts", async t => {
  const { run, calls, entries, root } = fixture(t);
  process.env.OLLAMA_HOST = "https://example.com";
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("Invalid host was used")
  );
  await assert.rejects(run(), /local Ollama server/);
  assert.deepEqual(calls, []);
  assert.equal(entries.has(path.join(root, "src/data/blog/post.en.md")), false);
  assert.equal(entries.has(path.join(root, "src/data/blog/post.ar.md")), false);
});

test("saves every draft before reporting malformed metadata and never retries generation", async t => {
  const { run, root, entries, messages, chunks } = fixture(t);
  const calls = mockOllama(t, ({ args, prompt }) => ({
    text:
      args[0] === "show"
        ? "Model info\n"
        : args.includes("--format")
          ? "not JSON\n"
          : prompt
              .split("Text to translate:\n")
              .at(-1)
              .replace("Bonjour", "Hello"),
  }));
  await run();
  assert.equal(calls.filter(call => call.args[0] === "run").length, 4);
  const lastWrite = messages.findIndex(
    message => message === "Written: src/data/blog/post.ar.md"
  );
  assert.ok(lastWrite >= 0);
  const warnings = messages.flatMap((message, index) =>
    message.startsWith("[validation:metadata-parse]") ? [index] : []
  );
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(index => index > lastWrite));
  assert.equal(
    Buffer.concat(chunks.stdout).toString("utf8").split("not JSON\n").length -
      1,
    2
  );
  for (const locale of ["en", "ar"]) {
    const article = parseArticle(
      entries.get(path.join(root, `src/data/blog/post.${locale}.md`)).text
    );
    assert.equal(article.fields.title, "Bonjour");
    assert.equal(article.fields.description, "Exemple");
    assert.deepEqual(article.fields.tags, ["Outils"]);
    assert.match(article.body, /Hello `code`/);
    assert.equal(article.document.get("draft"), true);
  }
  assert.equal(
    entries.get(path.join(root, "src/data/blog/post.fr.md")).text,
    source
  );
  assert.match(messages.at(-1), /Generated 2 draft/);
});

test("separates raw output, draft writes, and content checks even without a model trailing newline", async t => {
  const { root, entries, output, chunks, controller, messages } = fixture(t, {
    "src/data/blog/post.fr.md": source + "\n<!-- Keep this comment. -->\n",
  });
  let lastRawBody;
  mockOllama(t, ({ args, prompt }) => {
    if (args[0] === "show") return { text: "Model info\n" };
    const text = prompt.split("Text to translate:\n").at(-1).trimEnd();
    if (args.includes("--format")) return { text: JSON.stringify(parse(text)) };
    lastRawBody = "\u001b[36m" + text + "\u001b[0m";
    return { text: lastRawBody };
  });
  await runTranslationCommand(
    root,
    ["src/data/blog/post.fr.md", "--to", "en", "--model", "example:12b"],
    message => {
      messages.push(message);
      output.stdout.write(message + "\n");
    },
    controller.signal,
    output
  );
  const terminal = Buffer.concat(chunks.stdout).toString("utf8");
  assert.ok(
    terminal.includes(
      lastRawBody +
        "\n--- Save drafts ---\nWritten: src/data/blog/post.en.md\n\n--- Content checks ---\n[source:"
    )
  );
  assert.equal(terminal.split(lastRawBody).length - 1, 1);
  for (const section of ["\n--- Save drafts ---", "\n--- Content checks ---"])
    assert.equal(messages.filter(message => message === section).length, 1);
  const written = messages.indexOf("Written: src/data/blog/post.en.md");
  const checks = messages.indexOf("\n--- Content checks ---");
  assert.ok(checks > written);
  assert.ok(
    messages.findIndex(message => message.startsWith("[source:")) > checks
  );
  assert.ok(
    messages.findIndex(message => message.startsWith("Content validation:")) >
      checks
  );
  const saved = entries.get(path.join(root, "src/data/blog/post.en.md")).text;
  assert.ok(!saved.includes("--- Save drafts ---"));
  assert.ok(!saved.includes("--- Content checks ---"));
  assert.ok(saved.includes("<!-- Keep this comment. -->"));
});

test("labels saving and checking correctly when protected-only content needs no model request", async t => {
  const { run, calls, messages } = fixture(t, {
    "src/data/blog/post.fr.md":
      "---\ntitle: ''\ndescription: ''\n---\n```text\nKeep this.\n```\n",
  });
  process.env.OLLAMA_HOST = "https://example.com";
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("Content without model requests checked the service")
  );
  await run();
  assert.deepEqual(calls, []);
  assert.equal(messages[0], "\n--- Save drafts ---");
  assert.ok(
    messages.indexOf("\n--- Content checks ---") >
      messages.indexOf("Written: src/data/blog/post.ar.md")
  );
  assert.match(messages.at(-1), /Generated 2 draft/);
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
  assert.equal(calls.filter(call => call.args[0] === "run").length, 4);
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

test("rejects existing targets unless forced and preserves replacement permissions", async t => {
  const { run, entries, root, calls, mutations } = fixture(t, {
    "src/data/blog/post.en.md": { kind: "file", text: source, mode: 0o664 },
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
  assert.equal(
    entries.get(path.join(root, "src/data/blog/post.en.md")).mode,
    0o664
  );
  assert.equal(
    entries.get(path.join(root, "src/data/blog/post.ar.md")).mode,
    0o644
  );
  assert.equal(mutations.filter(item => item[0] === "chmod").length, 1);
});

test("rejects a source-language target before model calls or writes, even with force", async t => {
  const { run, entries, root, calls, mutations } = fixture(t);
  for (const forceArgs of [[], ["--force"]])
    await assert.rejects(run([...args, "--to", "fr", ...forceArgs]), {
      message:
        "Target language matches the source language (fr); choose a different --to language",
    });
  assert.deepEqual(calls, []);
  assert.deepEqual(mutations, []);
  assert.equal(
    entries.get(path.join(root, "src/data/blog/post.fr.md")).text,
    source
  );
});

test("refuses replacement when ownership differs or cannot be verified", async t => {
  for (const failure of ["different", "unavailable"]) {
    const { run, root, entries, mutations, messages } = fixture(t, {
      "src/data/blog/post.en.md": source,
    });
    if (process.platform === "win32") {
      t.mock.method(
        childProcess,
        "execFile",
        (_command, _input, _options, callback) => {
          if (failure === "unavailable")
            callback(new Error("ACL access denied"));
          else callback(null, "different\n");
        }
      );
    } else {
      const originalStat = fs.lstat;
      t.mock.method(fs, "lstat", async file => {
        const stat = await originalStat(file);
        if (!path.basename(file).startsWith(".translation-")) return stat;
        if (failure === "unavailable")
          throw new Error("Ownership access denied");
        return { ...stat, gid: stat.gid + 1 };
      });
    }
    await assert.rejects(run([...args, "--force"]), /ownership/i);
    assert.equal(
      entries.get(path.join(root, "src/data/blog/post.en.md")).text,
      source
    );
    assert.ok(!mutations.some(item => item[0] === "rename"));
    assert.ok(
      messages.some(message => message.startsWith("Temporary file retained"))
    );
  }
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

test("a failed last target still produces no writes", async t => {
  const { run, mutations } = fixture(t);
  mockOllama(t, ({ args, prompt }) => {
    if (args[0] === "show") return { text: "Model info" };
    if (prompt.includes("to ar.")) return { code: 1, stderr: "failed" };
    return { text: prompt.split("Text to translate:\n").at(-1) };
  });
  await assert.rejects(run(), /failed/);
  assert.deepEqual(mutations, []);
});

test("writes every draft before reporting invalid body output and retains the results", async t => {
  const { run, root, entries, mutations, messages, chunks } = fixture(t);
  mockOllama(t, ({ args, prompt }) => {
    if (args[0] === "show") return { text: "Model info" };
    return {
      text: args.includes("--format")
        ? JSON.stringify(parse(prompt.split("Text to translate:\n").at(-1)))
        : "Missing protected content __KEEP_999_999__",
    };
  });
  await run();
  assert.equal(mutations.filter(item => item[0] === "link").length, 2);
  for (const locale of ["en", "ar"]) {
    const article = parseArticle(
      entries.get(path.join(root, `src/data/blog/post.${locale}.md`)).text
    );
    assert.equal(article.document.get("draft"), true);
    assert.ok(
      article.body.includes("Missing protected content __KEEP_999_999__")
    );
  }
  const warning = messages.findIndex(message =>
    message.startsWith("[validation:placeholder-missing]")
  );
  const written = messages.findIndex(
    message => message === "Written: src/data/blog/post.ar.md"
  );
  assert.ok(written >= 0);
  assert.ok(warning > written);
  assert.match(messages[warning], /Source: src\/data\/blog\/post.fr.md:6:\d+/);
  assert.ok(
    messages.some(message => message.includes("[placeholder-unknown]"))
  );
  assert.match(messages.at(-1), /Generated 2 draft/);
  assert.ok(
    Buffer.concat(chunks.stdout)
      .toString("utf8")
      .includes("Missing protected content")
  );
});

test("reads actual saved drafts for non-blocking structure checks", async t => {
  const { run, entries, messages } = fixture(t);
  const originalLink = fs.link;
  t.mock.method(fs, "link", async (from, to) => {
    await originalLink(from, to);
    const file = entries.get(to);
    file.text = file.text.replace("\nHello `code`", "\n# Hello `code`");
  });
  await run();
  assert.ok(
    messages.some(
      message =>
        message.startsWith("[validation:markdown-node]") &&
        /post.en.md:\d+:\d+:[\s\S]*Expected paragraph, received heading/.test(
          message
        )
    )
  );
  assert.match(messages.at(-1), /Generated 2 draft/);
});

test("retains written drafts when post-write reads fail", async t => {
  const { run, root, entries, messages } = fixture(t);
  const originalRead = fs.readFile;
  t.mock.method(fs, "readFile", async (file, ...options) => {
    if (String(file).endsWith("post.en.md"))
      throw new Error("Review read denied");
    return originalRead(file, ...options);
  });
  await run();
  assert.ok(entries.has(path.join(root, "src/data/blog/post.en.md")));
  assert.ok(
    messages.some(
      message =>
        message.startsWith("[validation:read-failed]") &&
        /post.en.md:.*Review read denied/.test(message)
    )
  );
  assert.ok(
    messages.some(message =>
      message.startsWith("[validation:tag-check-skipped]")
    )
  );
  assert.match(messages.at(-1), /Generated 2 draft/);
});

test("reports new tag-route collisions only after draft writes", async t => {
  const { run, root, entries, messages } = fixture(t, {
    "src/data/blog/another.en.md": source.replace(
      "tags: [Outils]",
      "tags: [tools]"
    ),
  });
  await run();
  assert.ok(entries.has(path.join(root, "src/data/blog/post.en.md")));
  const warning = messages.findIndex(message =>
    message.startsWith("[validation:tag-route]")
  );
  assert.ok(warning >= 0);
  assert.ok(
    warning >
      messages.findIndex(
        message => message === "Written: src/data/blog/post.ar.md"
      )
  );
  assert.match(messages[warning], /Tag route collision/);
  assert.match(messages.at(-1), /Generated 2 draft/);
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
  mockOllamaPorts(t);
  const servers = mockOllamaSupervisor(t);
  await assert.rejects(
    run([...args, "--to", "ja", "--force", "--ollama-port", "auto"]),
    /Permission denied/
  );
  assert.equal(servers[0].stops, 1);
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

test("staged command uses working-tree runtime settings with index language and tag semantics", async t => {
  const { run, root, entries, calls, reads } = fixture(t, {
    "translation.config.mjs":
      'export default { model: "working-tree:12b", port: 22434 };',
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
  const ports = mockOllamaPorts(t);
  const servers = mockOllamaSupervisor(t);
  delete process.env.OLLAMA_HOST;
  await run(["--staged", "--to", "en"]);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].port, 22434);
  assert.equal(
    reads.filter(file => file === path.join(root, "translation.config.mjs"))
      .length,
    1
  );
  assert.ok(calls.every(call => call.args[1] === "working-tree:12b"));
  assert.equal(servers[0].stops, 1);
  const output = parseArticle(
    entries.get(path.join(root, "src/data/blog/source.en.md")).text
  );
  assert.equal(output.document.getIn(["translation", "sourceLocale"]), "fr");
  assert.equal(
    output.document.getIn(["translation", "model"]),
    "working-tree:12b"
  );
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
