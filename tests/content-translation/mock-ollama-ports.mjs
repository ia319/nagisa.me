import net from "node:net";
import { EventEmitter } from "node:events";

/**
 * Simulate exclusive loopback probes without binding real operating-system ports.
 * @param {import("node:test").TestContext} t Test-scoped mock owner.
 * @param {(number | Error)[]} outcomes Assigned ephemeral ports or bind failures.
 * @returns {object[]} Probe options and close state for lifecycle assertions.
 */
export function mockOllamaPorts(t, outcomes = []) {
  const calls = [];
  t.mock.method(net, "createServer", () => {
    const server = new EventEmitter();
    let call, cancel;
    server.listen = (options, ready) => {
      const outcome = outcomes[calls.length] ?? 42000 + calls.length;
      call = { ...options, selected: options.port || outcome, closed: false };
      calls.push(call);
      cancel = () => {
        call.closed = true;
      };
      options.signal.addEventListener("abort", cancel, { once: true });
      queueMicrotask(() => {
        if (options.signal.aborted) return;
        if (outcome instanceof Error) {
          options.signal.removeEventListener("abort", cancel);
          server.emit("error", outcome);
        } else ready();
      });
      return server;
    };
    server.address = () => ({ address: "127.0.0.1", port: call.selected });
    server.close = callback => {
      call.closed = true;
      call.signal.removeEventListener("abort", cancel);
      if (callback) queueMicrotask(() => callback());
    };
    return server;
  });
  return calls;
}
