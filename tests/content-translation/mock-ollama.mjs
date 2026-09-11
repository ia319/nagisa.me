import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

/** @typedef {{text?: string | Buffer, stderr?: string | Buffer, error?: Error, code?: number, signal?: string}} MockResponse */
/** @typedef {{args: string[], options: import("node:child_process").SpawnOptions & {signal: AbortSignal}, prompt: string, child: EventEmitter & {stdin: PassThrough, stdout: PassThrough, stderr: PassThrough, kill: () => boolean}}} MockCall */

/**
 * Capture raw process bytes in memory without using the terminal.
 * @returns {{chunks: {stdout: Buffer[], stderr: Buffer[]}, output: {stdout: Writable, stderr: Writable}} Independent streams and their captured chunks.
 */
export function captureOllamaOutput() {
  const chunks = { stdout: [], stderr: [] };
  const output = Object.fromEntries(
    Object.entries(chunks).map(([name, captured]) => [
      name,
      new Writable({
        write(chunk, _encoding, callback) {
          captured.push(Buffer.from(chunk));
          callback();
        },
      }),
    ])
  );
  return { chunks, output };
}

/**
 * Simulate pipes, cancellation, and child lifecycle without spawning an executable.
 * @param {import("node:test").TestContext} t Test-scoped mock owner.
 * @param {(call: MockCall) => MockResponse | Promise<MockResponse>} respond Supplies model output or writes chunks through the simulated child.
 * @returns {MockCall[]} Captured invocations for execution assertions.
 */
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
    let closed = false;
    child.kill = () => {
      if (closed) return false;
      closed = true;
      child.stdout.destroy();
      child.stderr.destroy();
      child.emit("close", null, "SIGTERM");
      return true;
    };
    const cancel = () => {
      child.emit("error", options.signal.reason);
      child.kill();
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    child.once("close", () =>
      options.signal.removeEventListener("abort", cancel)
    );
    let prompt = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", chunk => {
      prompt += chunk;
    });
    child.stdin.on("finish", () => {
      const call = { args, options, prompt, child };
      calls.push(call);
      queueMicrotask(async () => {
        try {
          const result = await respond(call);
          if (closed) return;
          if (result.error) child.emit("error", result.error);
          child.stdout.end(result.text ?? "");
          child.stderr.end(result.stderr ?? "");
          closed = true;
          child.emit("close", result.code ?? 0, result.signal ?? null);
        } catch (error) {
          child.emit("error", error);
          child.kill();
        }
      });
    });
    return child;
  });
  return calls;
}
