import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const module = { exports: {} };
new Function(
  "module",
  "exports",
  ts.transpileModule(
    readFileSync(new URL("./desktopUpdates.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText,
)(module, module.exports);
const { observeDesktopUpdates } = module.exports;

function bridge() {
  let receive, resolve, reject;
  const snapshot = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let reads = 0,
    stops = 0;
  return {
    api: {
      getState() {
        reads++;
        return snapshot;
      },
      onState(fn) {
        receive = fn;
        return () => stops++;
      },
    },
    emit: (state) => receive(state),
    resolve,
    reject,
    reads: () => reads,
    stops: () => stops,
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("plain browsers and older desktop builds need no updater or polling", () => {
  const states = [];
  observeDesktopUpdates(undefined, (state) => states.push(state))();
  assert.deepEqual(states, []);
});

test("one local snapshot restores a downloaded update after reload", async () => {
  const h = bridge(),
    states = [];
  const stop = observeDesktopUpdates(h.api, (state) => states.push(state));
  h.resolve({ status: "ready", version: "1.9.0" });
  await tick();
  assert.deepEqual(states, [{ status: "ready", version: "1.9.0" }]);
  assert.equal(h.reads(), 1);
  stop();
  assert.equal(h.stops(), 1);
});

test("events win over an older snapshot and cleanup prevents late UI changes", async () => {
  const h = bridge(),
    states = [];
  const stop = observeDesktopUpdates(h.api, (state) => states.push(state));
  h.emit({ status: "downloading", version: null });
  h.emit({ status: "ready", version: "1.9.0" });
  h.resolve({ status: "idle", version: null });
  await tick();
  assert.deepEqual(
    states.map((state) => state.status),
    ["downloading", "ready"],
  );
  stop();
  h.emit({ status: "installing", version: "1.9.0" });
  assert.equal(states.length, 2);
});

test("snapshot failures are handled and unmount discards a late snapshot", async () => {
  for (const reject of [false, true]) {
    const h = bridge(),
      states = [];
    const stop = observeDesktopUpdates(h.api, (state) => states.push(state));
    stop();
    if (reject) h.reject(new Error("renderer gone"));
    else h.resolve({ status: "ready", version: "1.9.0" });
    await tick();
    assert.deepEqual(states, []);
  }
});
