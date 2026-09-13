import assert from "node:assert/strict";
import test from "node:test";
import {
  checkOllamaService,
  resolveOllamaHost,
} from "../../scripts/content-translation/ollama-connection.mjs";

const host = "http://127.0.0.1:22434/";

test("normalizes local addresses while preserving explicitly selected ports", () => {
  for (const [input, expected] of [
    ["localhost", "http://localhost:11434/"],
    [" 127.0.0.1:22434 ", host],
    ["0.0.0.0:22434", host],
    ["[::]", "http://[::1]:11434/"],
    ["[::1]:22434", "http://[::1]:22434/"],
    ["localhost:80", "http://localhost/"],
    ["127.0.0.1:80/", "http://127.0.0.1/"],
    ["[::1]:80", "http://[::1]/"],
    ["http://localhost", "http://localhost/"],
    ["https://localhost", "https://localhost/"],
    ["https://localhost:443", "https://localhost/"],
    ["127.0.0.1:1", "http://127.0.0.1:1/"],
    ["127.0.0.1:65535", "http://127.0.0.1:65535/"],
  ])
    assert.equal(resolveOllamaHost(input), expected, input);
});

test("rejects nonlocal and malformed addresses before any network call", () => {
  for (const input of [
    "",
    " ",
    "http://",
    "http://example.com",
    "192.168.1.2:11434",
    "file:///localhost",
    "ftp://localhost",
    "localhost:0",
    "http://localhost:0",
    "localhost:65536",
    "localhost:-1",
    "localhost:port",
    "localhost:\n80",
    "http://local\thost:22434",
    "http://user:password@localhost",
    "localhost/api",
    "localhost?query=1",
    "localhost#fragment",
  ])
    assert.throws(() => resolveOllamaHost(input), /local Ollama server/, input);
});

test("checks version JSON without redirects and bounds the whole request duration", async t => {
  const deadline = new AbortController();
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    assert.equal(milliseconds, 3000);
    return deadline.signal;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, host + "api/version");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.notEqual(options.signal, controller.signal);
    assert.equal(options.signal.aborted, false);
    return Response.json({ version: "0.0.0-test", additional: true });
  });
  await checkOllamaService(host, controller.signal);
});

test("rejects unrelated HTTP responses, malformed JSON, and missing version strings", async t => {
  for (const body of [
    "OK",
    "<html>Another local app</html>",
    "",
    "null",
    "[]",
    "{}",
    '{"version":1}',
    '{"version":"  "}',
  ]) {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    await assert.rejects(
      checkOllamaService(host, new AbortController().signal),
      /Invalid Ollama version response/
    );
  }
});

test("rejects oversized version responses and cancels the remaining body", async t => {
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.alloc(8193, 32));
          },
          cancel() {
            cancelled = true;
          },
        })
      )
  );
  await assert.rejects(
    checkOllamaService(host, new AbortController().signal),
    /version response exceeded 8 KiB/
  );
  assert.equal(cancelled, true);
});

test("reports connection and HTTP failures without accepting a successful root page", async t => {
  const failure = new Error("connection refused");
  t.mock.method(globalThis, "fetch", async () => {
    throw failure;
  });
  await assert.rejects(
    checkOllamaService(host, new AbortController().signal),
    error => {
      assert.match(error.message, /service is unavailable.*22434/);
      assert.equal(error.cause, failure);
      return true;
    }
  );
  for (const status of [301, 404, 503]) {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response("Not Ollama", { status })
    );
    await assert.rejects(
      checkOllamaService(host, new AbortController().signal),
      new RegExp(`HTTP ${status}`)
    );
  }
});

test("preserves cancellation before contacting the service", async t => {
  const reason = new Error("Translation cancelled");
  const controller = new AbortController();
  controller.abort(reason);
  t.mock.method(globalThis, "fetch", () => assert.fail("Cancelled probe ran"));
  await assert.rejects(checkOllamaService(host, controller.signal), error => {
    assert.equal(error, reason);
    return true;
  });
});

test("cancels a stalled version body on caller cancellation or the probe deadline", async t => {
  for (const timedOut of [false, true]) {
    const controller = new AbortController();
    const deadline = new AbortController();
    const reason = timedOut
      ? new DOMException("Version check timed out", "TimeoutError")
      : new Error("Translation cancelled");
    t.mock.method(AbortSignal, "timeout", () => deadline.signal);
    t.mock.method(
      globalThis,
      "fetch",
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(stream) {
              options.signal.addEventListener(
                "abort",
                () => stream.error(options.signal.reason),
                { once: true }
              );
              queueMicrotask(() =>
                (timedOut ? deadline : controller).abort(reason)
              );
            },
          })
        )
    );
    await assert.rejects(checkOllamaService(host, controller.signal), error => {
      if (timedOut) {
        assert.match(error.message, /Ollama version check timed out/);
        assert.equal(error.cause, reason);
      } else assert.equal(error, reason);
      return true;
    });
  }
});
