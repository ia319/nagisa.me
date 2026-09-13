import assert from "node:assert/strict";
import timers from "node:timers/promises";
import test from "node:test";
import { openOllamaService } from "../../scripts/content-translation/ollama-service.mjs";
import { mockOllamaPorts } from "./mock-ollama-ports.mjs";
import { mockOllamaSupervisor } from "./mock-ollama-supervisor.mjs";

function setup(t, behavior = {}, outcomes = []) {
  const originalHost = process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_HOST;
  t.after(() => {
    if (originalHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalHost;
  });
  const ports = mockOllamaPorts(t, outcomes);
  const calls = mockOllamaSupervisor(t, behavior);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ version: "0.0.0-test" })
  );
  const controller = new AbortController();
  const messages = [];
  return {
    ports,
    calls,
    controller,
    messages,
    open: port =>
      openOllamaService(
        port,
        message => messages.push(message),
        controller.signal
      ),
  };
}

test("borrows OLLAMA_HOST without reserving ports or owning its process", async t => {
  const { open, calls, ports, controller } = setup(t);
  process.env.OLLAMA_HOST = "0.0.0.0:22434";
  const service = await open();
  assert.equal(service.host, "http://127.0.0.1:22434/");
  assert.equal(service.signal, controller.signal);
  await service.stop();
  assert.deepEqual(calls, []);
  assert.deepEqual(ports, []);
  process.env.OLLAMA_HOST = "https://example.com";
  await assert.rejects(open(), /local Ollama server/);
});

test("uses private automatic or explicit ports and overrides inherited host configuration", async t => {
  const { open, calls, ports } = setup(t);
  for (const port of [undefined, "auto", 22434, 80]) {
    if (port !== undefined) process.env.OLLAMA_HOST = "https://example.com";
    const service = await open(port);
    const probe = ports.at(-1);
    assert.equal(probe.host, "127.0.0.1");
    assert.equal(probe.exclusive, true);
    assert.equal(probe.port, typeof port === "number" ? port : 0);
    assert.equal(probe.closed, true);
    assert.equal(service.host, `http://127.0.0.1:${probe.selected}/`);
    assert.equal(calls.at(-1).options.env.OLLAMA_HOST, service.host);
    await service.stop();
  }
  assert.equal(process.env.OLLAMA_HOST, "https://example.com");
});

test("fails before spawning when a fixed port is occupied or forbidden", async t => {
  for (const code of ["EADDRINUSE", "EACCES"]) {
    const { open, calls, ports } = setup(t, {}, [
      Object.assign(new Error(code), { code }),
    ]);
    await assert.rejects(open(22434), new RegExp(`port 22434.*${code}`));
    assert.equal(ports.length, 1);
    assert.deepEqual(calls, []);
  }
});

test("retries a confirmed bind race only after the failed instance is cleaned up", async t => {
  let starts = 0;
  const { open, calls, ports, messages } = setup(t, {
    start(call) {
      if (++starts === 1) {
        call.child.stderr.write(
          `Error: listen tcp 127.0.0.1:${call.options.env.TRANSLATION_OLLAMA_PORT}: bind: Only one usage of each socket address is normally permitted.\n`
        );
        call.event("stopped");
        call.close(1);
      } else call.event("listening");
    },
  });
  const service = await open();
  assert.equal(calls.length, 2);
  assert.equal(ports.length, 2);
  assert.equal(calls[0].child.stdout.writableEnded, true);
  assert.ok(messages.some(message => message.includes("retry 1/3")));
  await service.stop();
});

test("limits automatic bind retries to three and never falls back for a fixed port", async t => {
  for (const port of ["auto", 22434]) {
    const { open, calls } = setup(t, {
      start(call) {
        call.child.stderr.write(
          `listen tcp 127.0.0.1:${call.options.env.TRANSLATION_OLLAMA_PORT}: bind: address already in use\n`
        );
        call.event("stopped");
        call.close(1);
      },
    });
    await assert.rejects(open(port), /address already in use/);
    assert.equal(calls.length, port === "auto" ? 4 : 1);
  }
});

test("does not hide permission, missing executable, or cleanup failures by changing ports", async t => {
  for (const [message, confirmed] of [
    ["Ollama CLI was not found", true],
    ["listen tcp 127.0.0.1:42000: bind: access permissions denied", true],
    ["listen tcp 127.0.0.1:42000: bind: address already in use", false],
  ]) {
    const { open, calls } = setup(t, {
      start(call) {
        call.child.stderr.write(message);
        if (confirmed) call.event("stopped");
        call.close(1);
      },
    });
    await assert.rejects(
      open(),
      confirmed ? /Ollama startup failed/ : /cleanup failed/
    );
    assert.equal(calls.length, 1);
  }
});

test("waits for version readiness after listener ownership and rejects unrelated responses", async t => {
  const { open, calls } = setup(t);
  const delay = timers.setTimeout;
  t.mock.method(timers, "setTimeout", (milliseconds, value, options) =>
    milliseconds === 100
      ? Promise.resolve()
      : delay(milliseconds, value, options)
  );
  let probes = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++probes === 1)
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      });
    return Response.json({ version: "0.0.0-test" });
  });
  const service = await open();
  assert.equal(probes, 2);
  await service.stop();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("Another service")
  );
  await assert.rejects(open(), /Invalid Ollama version response/);
  assert.equal(calls.at(-1).stops, 1);
});

test("bounds startup separately from model loading and cleans up on timeout", async t => {
  const { open, calls } = setup(t, { boot() {} });
  const delay = timers.setTimeout;
  let expire;
  t.mock.method(timers, "setTimeout", (milliseconds, value, options) =>
    milliseconds === 60000
      ? new Promise(resolve => {
          expire = resolve;
        })
      : delay(milliseconds, value, options)
  );
  const opening = open();
  await new Promise(resolve => setImmediate(resolve));
  expire();
  await assert.rejects(opening, /startup timed out after 60 seconds/);
  assert.equal(calls[0].stops, 1);
  assert.equal(calls.length, 1);
});

test("propagates service death through its signal and isolates concurrent invocations", async t => {
  const { open, calls } = setup(t);
  const first = await open();
  const second = await open();
  assert.notEqual(first.host, second.host);
  calls[0].child.stderr.write("service crashed");
  calls[0].event("stopped");
  calls[0].close(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.signal.aborted, true);
  assert.match(first.signal.reason.message, /service crashed/);
  assert.equal(second.signal.aborted, false);
  await first.stop();
  await second.stop();
});

test("honors cancellation while waiting for the owned listener", async t => {
  const { open, controller, calls } = setup(t, { start() {} });
  const opening = open();
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("Translation cancelled"));
  await assert.rejects(opening, /Translation cancelled/);
  assert.equal(calls[0].stops, 1);
});
