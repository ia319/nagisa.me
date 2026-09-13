import assert from "node:assert/strict";
import childProcess from "node:child_process";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Simulate the supervisor control pipe; native job and port ownership still need local verification.
 * @param {import("node:test").TestContext} t Test-scoped mock owner.
 * @param {{boot?: Function, start?: Function, stop?: Function}} behavior Lifecycle events to override.
 * @returns {object[]} Captured supervisor calls, separate from model CLI calls.
 */
export function mockOllamaSupervisor(t, behavior = {}) {
  t.mock.method(os, "platform", () => "win32");
  const previous = childProcess.spawn;
  const calls = [];
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (command === "ollama") return previous(command, args, options);
    assert.equal(command, "powershell.exe");
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.signal, undefined);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    assert.ok(args.includes("-NoProfile"));
    assert.ok(args.includes("-NonInteractive"));
    assert.ok(!args.includes("-ExecutionPolicy"));
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    const call = {
      args,
      options,
      child,
      starts: 0,
      stops: 0,
      kills: 0,
      event: event =>
        child.stdout.write(JSON.stringify({ event }) + "\n", "utf8"),
      close(code = 0, signal = null) {
        if (closed) return;
        closed = true;
        child.stdout.end();
        child.stderr.end();
        child.emit("close", code, signal);
      },
    };
    child.kill = () => {
      call.kills++;
      call.close(null, "SIGTERM");
      return true;
    };
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", text => {
      assert.equal(text, "start\n");
      call.starts++;
      if (behavior.start) behavior.start(call);
      else call.event("listening");
    });
    child.stdin.on("finish", () => {
      call.stops++;
      if (closed) return;
      if (behavior.stop) behavior.stop(call);
      else {
        call.event("stopped");
        call.close();
      }
    });
    calls.push(call);
    queueMicrotask(() => {
      if (closed) return;
      if (behavior.boot) behavior.boot(call);
      else {
        child.emit("spawn");
        call.event("ready");
      }
    });
    return child;
  });
  return calls;
}
