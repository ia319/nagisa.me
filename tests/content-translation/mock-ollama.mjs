import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** Simulate pipes and child lifecycle without spawning an executable. */
export function mockOllama(t, respond) {
  const calls = [];
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    assert.equal(command, "ollama");
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit("close", null, "SIGTERM");
      return true;
    };
    let prompt = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", chunk => {
      prompt += chunk;
    });
    child.stdin.on("finish", () => {
      const call = { args, options, prompt };
      calls.push(call);
      queueMicrotask(() => {
        const result = respond(call);
        if (result.error) child.emit("error", result.error);
        else {
          child.stdout.end(result.text ?? "");
          child.stderr.end(result.stderr ?? "");
          child.emit("close", result.code ?? 0, result.signal ?? null);
        }
      });
    });
    return child;
  });
  return calls;
}
