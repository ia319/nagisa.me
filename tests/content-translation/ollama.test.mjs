import assert from "node:assert/strict";
import test from "node:test";
import { runOllamaRequests } from "../../scripts/content-translation/ollama.mjs";
import { mockOllama } from "./mock-ollama.mjs";

const requests = [
  {
    id: "ar:body:0",
    prompt: "Text with spaces, 中文, $() and `quotes` __KEEP_0_0__",
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
  return {
    calls,
    fetches,
    messages,
    controller,
    run: (items = requests, model = "local model;$(test):12b") =>
      runOllamaRequests(
        items,
        model,
        message => messages.push(message),
        controller.signal
      ),
  };
}

test("uses argument arrays and stdin, disabling display wrapping and thinking", async t => {
  const { run, calls, fetches, messages } = setup(t, ({ args }) => ({
    text:
      args[0] === "show"
        ? "Model info"
        : "\u001b[31m译文 __KEEP_0_0__\u001b[0m\n",
    stderr: "\u001b[32mwarning\u001b[0m",
  }));
  assert.deepEqual(await run(), [
    { id: requests[0].id, text: "译文 __KEEP_0_0__" },
  ]);
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
  assert.ok(messages.some(message => message.includes("stderr")));
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
      /run failed.*GPU failed/,
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

test("checks model availability for every fragment and stops at the first failure", async t => {
  let showCount = 0;
  const { run, calls } = setup(t, ({ args }) =>
    args[0] === "show" && ++showCount === 2
      ? { code: 1, stderr: "model not found" }
      : { text: "Model info" }
  );
  await assert.rejects(
    run([...requests, { ...requests[0], id: "ar:body:1" }]),
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
