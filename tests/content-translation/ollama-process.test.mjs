import assert from "node:assert/strict";
import childProcess from "node:child_process";
import os from "node:os";
import timers from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import { startOllamaProcess } from "../../scripts/content-translation/ollama-process.mjs";
import { mockOllamaSupervisor } from "./mock-ollama-supervisor.mjs";

const host = "http://127.0.0.1:22434/";

test("contains one service through a private supervisor with invocation-only settings", async t => {
  const environment = { ...process.env };
  const calls = mockOllamaSupervisor(t);
  const controller = new AbortController();
  const service = startOllamaProcess(host, controller.signal);
  await service.listening;
  assert.equal(calls.length, 1);
  const { options } = calls[0];
  assert.equal(options.env.OLLAMA_HOST, host);
  assert.equal(options.env.OLLAMA_NO_CLOUD, "1");
  assert.equal(options.env.OLLAMA_NOPRUNE, "1");
  assert.equal(options.env.TRANSLATION_OLLAMA_PORT, "22434");
  assert.match(options.env.TRANSLATION_OLLAMA_JOB, /ollama-job\.cs$/);
  for (const name of [
    "OLLAMA_MODELS",
    "CUDA_VISIBLE_DEVICES",
    "OLLAMA_LOAD_TIMEOUT",
  ])
    assert.equal(options.env[name], environment[name]);
  await Promise.all([service.stop(), service.stop()]);
  assert.equal(calls[0].starts, 1);
  assert.equal(calls[0].stops, 1);
  assert.equal(calls[0].kills, 0);
  assert.ok(
    isDeepStrictEqual({ ...process.env }, environment),
    "Process environment changed"
  );
});

test("rejects unsupported platforms and pre-cancelled work without spawning", t => {
  t.mock.method(childProcess, "spawn", () => assert.fail("Unexpected process"));
  t.mock.method(os, "platform", () => "linux");
  const controller = new AbortController();
  assert.throws(
    () => startOllamaProcess(host, controller.signal),
    /requires Windows.*OLLAMA_HOST/
  );
  controller.abort(new Error("Cancelled"));
  assert.throws(() => startOllamaProcess(host, controller.signal), /Cancelled/);
});

test("cancels before compilation finishes without issuing a start command", async t => {
  const calls = mockOllamaSupervisor(t, { boot() {} });
  const controller = new AbortController();
  const service = startOllamaProcess(host, controller.signal);
  controller.abort(new Error("Cancelled before start"));
  await assert.rejects(service.listening, /Cancelled before start/);
  await service.stop();
  assert.equal(calls[0].starts, 0);
  assert.equal(calls[0].stops, 1);
});

test("cancellation closes the control pipe and waits for cleanup confirmation", async t => {
  const calls = mockOllamaSupervisor(t, { stop() {} });
  const controller = new AbortController();
  const service = startOllamaProcess(host, controller.signal);
  await service.listening;
  controller.abort(new Error("Cancelled"));
  let finished = false;
  const cleanup = service.stop().then(() => {
    finished = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  calls[0].event("stopped");
  calls[0].close();
  await cleanup;
  assert.equal(finished, true);
});

test("bounds diagnostic logs and keeps service output outside model output", async t => {
  const calls = mockOllamaSupervisor(t, {
    start(call) {
      call.child.stderr.write("x".repeat(100000));
      call.child.stderr.write("\u001b[31mbind failed\u001b[0m");
      call.event("stopped");
      call.close(1);
    },
  });
  const service = startOllamaProcess(host, new AbortController().signal);
  await assert.rejects(service.listening, /bind failed/);
  assert.ok(service.diagnostics().length <= 65536);
  assert.ok(!service.diagnostics().includes("\u001b"));
  await service.stop();
  assert.equal(calls[0].kills, 0);
});

test("ignores late listener notification during cancellation", async t => {
  const calls = mockOllamaSupervisor(t, { start() {}, stop() {} });
  const controller = new AbortController();
  const service = startOllamaProcess(host, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("Cancelled while starting"));
  calls[0].event("listening");
  calls[0].event("stopped");
  calls[0].close();
  await assert.rejects(service.listening, /Cancelled while starting/);
  await service.stop();
});

test("distinguishes a missing PowerShell executable from service startup failure", async t => {
  mockOllamaSupervisor(t, {
    boot(call) {
      call.child.emit(
        "error",
        Object.assign(new Error("missing"), { code: "ENOENT" })
      );
      call.close(-2);
    },
  });
  const service = startOllamaProcess(host, new AbortController().signal);
  await assert.rejects(service.listening, /PowerShell was not found/);
  await service.stop();
});

test("fails closed on invalid control messages and reports unconfirmed cleanup", async t => {
  mockOllamaSupervisor(t, {
    start(call) {
      call.child.stdout.write("invalid\n");
    },
    stop(call) {
      call.close(1);
    },
  });
  const service = startOllamaProcess(host, new AbortController().signal);
  await assert.rejects(service.listening);
  await assert.rejects(service.stop(), /cleanup was not confirmed/);
});

test("terminates only its supervisor when cleanup exceeds the deadline", async t => {
  const calls = mockOllamaSupervisor(t, { stop() {} });
  t.mock.method(timers, "setTimeout", async milliseconds => {
    assert.equal(milliseconds, 10000);
    return null;
  });
  const service = startOllamaProcess(host, new AbortController().signal);
  await service.listening;
  await assert.rejects(service.stop(), /cleanup timed out/);
  assert.equal(calls[0].kills, 1);
  assert.equal(calls[0].unreferenced, true);
  assert.equal(calls[0].child.stdout.destroyed, true);
});

test("settles readiness even when a timed-out supervisor cannot exit", async t => {
  const calls = mockOllamaSupervisor(t, { boot() {}, stop() {} });
  t.mock.method(timers, "setTimeout", async () => null);
  const controller = new AbortController();
  const service = startOllamaProcess(host, controller.signal);
  calls[0].child.kill = () => false;
  controller.abort(new Error("Cancelled"));
  await assert.rejects(service.listening, /cleanup timed out/);
  await assert.rejects(service.stop(), /cleanup timed out/);
  assert.equal(calls[0].unreferenced, true);
});

test("keeps concurrent supervisors and their cleanup independent", async t => {
  const calls = mockOllamaSupervisor(t);
  const signal = new AbortController().signal;
  const first = startOllamaProcess(host, signal);
  const second = startOllamaProcess("http://127.0.0.1:33434/", signal);
  await Promise.all([first.listening, second.listening]);
  await first.stop();
  assert.equal(calls[0].stops, 1);
  assert.equal(calls[1].stops, 0);
  await second.stop();
});
