import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { runOllamaRequests } from "../../scripts/content-translation/ollama.mjs";
import { captureOllamaOutput, mockOllama } from "./mock-ollama.mjs";

const requests = [
  {
    id: "ar:article",
    prompt: "Text with spaces, 中文, $() and `quotes`\n\nFull body",
  },
];
function setup(t, response = () => ({ text: "model information" })) {
  const oldHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "127.0.0.1:11434";
  t.after(() => {
    if (oldHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = oldHost;
  });
  const fetches = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    fetches.push({ url, options });
    return { ok: true };
  });
  const calls = mockOllama(t, response);
  const messages = [];
  const controller = new AbortController();
  const capture = captureOllamaOutput();
  return {
    ...capture,
    calls,
    fetches,
    messages,
    controller,
    run: (items = requests, model = "local model;$(test):12b") =>
      runOllamaRequests(
        items,
        model,
        message => messages.push(message),
        controller.signal,
        capture.output
      ),
  };
}

test("uses argument arrays and stdin, disabling display wrapping and thinking", async t => {
  const { run, calls, fetches, messages, chunks, output } = setup(
    t,
    ({ args }) => ({
      text: args[0] === "show" ? "Model info" : "\u001b[31m译文\u001b[0m\n",
      stderr: "\u001b[32m⠋\r⠙\rwarning\u001b[0m",
    })
  );
  assert.deepEqual(await run(), [{ id: requests[0].id, text: "译文" }]);
  assert.deepEqual(
    calls.map(call => call.args),
    [
      ["show", "local model;$(test):12b"],
      ["run", "local model;$(test):12b", "--nowordwrap", "--hidethinking"],
    ]
  );
  assert.equal(calls[1].prompt, requests[0].prompt);
  assert.equal(calls[0].prompt, "");
  assert.equal(fetches.length, 2);
  assert.ok(
    fetches.every(
      call =>
        call.options.method === "HEAD" && call.options.redirect === "error"
    )
  );
  assert.deepEqual(messages, ["Translate 1/1: ar:article"]);
  assert.equal(
    Buffer.concat(chunks.stdout).toString("utf8"),
    "Model info\u001b[31m译文\u001b[0m\n"
  );
  assert.equal(
    Buffer.concat(chunks.stderr).toString("utf8"),
    "\u001b[32m⠋\r⠙\rwarning\u001b[0m".repeat(2)
  );
  for (const stream of Object.values(output)) {
    assert.equal(stream.destroyed, false);
    assert.equal(stream.writableEnded, false);
    assert.equal(stream.listenerCount("error"), 0);
  }
});

test("uses JSON mode only for metadata and starts an independent process for the body", async t => {
  const metadata = {
    id: "en:metadata",
    format: "json",
    prompt: "Metadata instructions\nText to translate:\ntitle: Bonjour",
  };
  const body = {
    id: "en:body",
    prompt: "Body instructions\nText to translate:\nBonjour **monde**.",
  };
  const raw = ['{"title":"Hello"}\n', "Hello **world**.\n"];
  const { run, calls, chunks } = setup(t, ({ args }) => ({
    text:
      args[0] === "show"
        ? "Model info\n"
        : raw[args.includes("--format") ? 0 : 1],
  }));
  assert.deepEqual(await run([metadata, body]), [
    { id: metadata.id, text: raw[0].trim() },
    { id: body.id, text: raw[1].trim() },
  ]);
  const runs = calls.filter(call => call.args[0] === "run");
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].args.slice(-2), ["--format", "json"]);
  assert.ok(!runs[1].args.includes("--format"));
  assert.equal(runs[0].prompt, metadata.prompt);
  assert.equal(runs[1].prompt, body.prompt);
  assert.equal(
    Buffer.concat(chunks.stdout).toString("utf8"),
    "Model info\n" + raw[0] + "Model info\n" + raw[1]
  );
});

test("does not spawn Ollama when the service is unavailable or returns an error", async t => {
  const { run, calls } = setup(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("connection refused");
  });
  await assert.rejects(run(), /service is unavailable.*Start it manually/);
  assert.deepEqual(calls, []);
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 503 }));
  await assert.rejects(run(), /HTTP 503/);
});

test("distinguishes missing executables, missing models, nonzero exits, and empty output", async t => {
  for (const [response, pattern] of [
    [
      () => ({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }),
      /CLI was not found/,
    ],
    [() => ({ code: 1, stderr: "model not found" }), /model is not installed/],
    [
      ({ args }) =>
        args[0] === "show"
          ? { text: "Model info" }
          : { code: 2, stderr: "GPU failed" },
      /run failed \(2\)/,
    ],
    [
      ({ args }) => ({ text: args[0] === "show" ? "Model info" : "  \n" }),
      /empty output/,
    ],
  ]) {
    const { run, calls } = setup(t, response);
    await assert.rejects(run(), pattern);
    assert.ok(
      !calls.some(call => ["pull", "serve", "create"].includes(call.args[0]))
    );
  }
});

test("checks model availability for every request and stops at the first failure", async t => {
  let showCount = 0;
  const { run, calls } = setup(t, ({ args }) =>
    args[0] === "show" && ++showCount === 2
      ? { code: 1, stderr: "model not found" }
      : { text: "Model info" }
  );
  await assert.rejects(
    run([...requests, { ...requests[0], id: "en:article" }]),
    /model is not installed/
  );
  assert.equal(calls.filter(call => call.args[0] === "run").length, 1);
});

test("honors cancellation and skips all external work for no requests", async t => {
  const { run, calls, fetches, controller } = setup(t);
  assert.deepEqual(await run([]), []);
  assert.deepEqual(fetches, []);
  controller.abort();
  await assert.rejects(run(), /abort/i);
  assert.deepEqual(calls, []);
});

test("uses one normalized local host for probes and CLI and rejects remote models", async t => {
  const { run, calls, fetches } = setup(t);
  process.env.OLLAMA_HOST = "0.0.0.0:22434";
  await run();
  assert.equal(calls[0].options.env.OLLAMA_HOST, "http://127.0.0.1:22434/");
  assert.equal(fetches[0].url, calls[0].options.env.OLLAMA_HOST);
  process.env.OLLAMA_HOST = "https://example.com";
  await assert.rejects(run(), /local Ollama server/);
  process.env.OLLAMA_HOST = "[::1]:11434";
  await run();
  mockOllama(t, () => ({ text: "Model\n    Remote model   example:cloud\n" }));
  await assert.rejects(run(), /Cloud models/);
});

test("rejects empty model information, terminated children, and oversized output", async t => {
  for (const [response, pattern] of [
    [() => ({ text: "" }), /no model information/],
    [() => ({ signal: "SIGTERM" }), /failed \(SIGTERM\)/],
    [() => ({ text: "a".repeat(16 * 1024 * 1024 + 1) }), /output exceeded/],
  ]) {
    const { run } = setup(t, response);
    await assert.rejects(run(), pattern);
  }
});

test("does not call run when the service disappears after show", async t => {
  const { run, calls } = setup(t);
  let probes = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++probes > 1) throw new Error("connection refused");
    return { ok: true };
  });
  await assert.rejects(run(), /service is unavailable/);
  assert.deepEqual(
    calls.map(call => call.args[0]),
    ["show"]
  );
});

test("forwards split UTF-8, control bytes, and progress before the child exits", async t => {
  const bytes = Buffer.from("\u001b[31m中文😀\u001b[0m\r\n", "utf8");
  const stderr = Buffer.from("\u001b[?25l⠋\r⠙\u001b[?25h\rwarning\n", "utf8");
  let capture;
  capture = setup(t, async ({ args, child }) => {
    if (args[0] === "show") return { text: "Model info\n" };
    for (let index = 0; index < bytes.length; index++) {
      child.stdout.write(bytes.subarray(index, index + 1));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(
        Buffer.concat(capture.chunks.stdout),
        Buffer.concat([
          Buffer.from("Model info\n"),
          bytes.subarray(0, index + 1),
        ])
      );
    }
    child.stderr.write(stderr.subarray(0, 8));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(
      Buffer.concat(capture.chunks.stderr),
      stderr.subarray(0, 8)
    );
    return { stderr: stderr.subarray(8) };
  });
  assert.deepEqual(await capture.run(), [
    { id: requests[0].id, text: "中文😀" },
  ]);
  assert.deepEqual(Buffer.concat(capture.chunks.stderr), stderr);
  assert.deepEqual(capture.messages, ["Translate 1/1: ar:article"]);
});

test("waits for slow output writes without ending the caller's streams", async t => {
  const { run, output } = setup(t, ({ args }) => ({
    text: args[0] === "show" ? "Model info" : "Translated body",
  }));
  const written = [];
  output.stdout = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      setImmediate(() => {
        written.push(Buffer.from(chunk));
        callback();
      });
    },
  });
  await run();
  assert.equal(
    Buffer.concat(written).toString("utf8"),
    "Model infoTranslated body"
  );
  assert.equal(output.stdout.writableLength, 0);
  assert.equal(output.stdout.writableEnded, false);
  assert.equal(output.stdout.destroyed, false);
  assert.equal(output.stdout.listenerCount("error"), 0);
});

test("stops on output stream failure and releases temporary stream listeners", async t => {
  const { run, calls, output } = setup(t);
  output.stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("Terminal write failed"));
    },
  });
  await assert.rejects(run(), /Terminal write failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(output.stdout.listenerCount("error"), 0);
  assert.equal(output.stderr.listenerCount("error"), 0);
  assert.equal(output.stderr.destroyed, false);
});

test("honors cancellation during a running model and forwards its partial output once", async t => {
  let capture;
  capture = setup(t, async ({ args, child }) => {
    if (args[0] === "show") return { text: "Model info" };
    child.stdout.write("Partial body");
    await new Promise(resolve => setImmediate(resolve));
    capture.controller.abort(new Error("Translation cancelled"));
    return { text: "Must not be consumed" };
  });
  await assert.rejects(
    capture.run([...requests, { ...requests[0], id: "en:article" }]),
    /Translation cancelled/
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(capture.calls.length, 2);
  assert.equal(
    Buffer.concat(capture.chunks.stdout).toString("utf8"),
    "Model infoPartial body"
  );
  assert.equal(capture.output.stdout.listenerCount("error"), 0);
  assert.equal(capture.output.stderr.listenerCount("error"), 0);
});

test("shows failure stderr once without replaying it through command diagnostics", async t => {
  const warning = "\u001b[31mGPU failed\u001b[0m\n";
  const { run, chunks, messages } = setup(t, ({ args }) =>
    args[0] === "show" ? { text: "Model info" } : { code: 2, stderr: warning }
  );
  await assert.rejects(run(), error => {
    assert.match(error.message, /run failed \(2\)/);
    assert.ok(!error.message.includes("GPU failed"));
    return true;
  });
  assert.equal(Buffer.concat(chunks.stderr).toString("utf8"), warning);
  assert.deepEqual(messages, ["Translate 1/1: ar:article"]);
});
