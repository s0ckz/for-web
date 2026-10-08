import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers";
import { URL } from "node:url";
import vm from "node:vm";
import { screenShareExperiment } from "./screenShareExperiments.ts";
import {
  startScreenShareFlowTrace,
  summarizeCaptureFlow,
} from "./screenShareFlowTrace.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function clock() {
  let now = 0,
    next = 0;
  const tasks = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++next;
      tasks.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, task] of [...tasks].sort((a, b) => a[1].at - b[1].at))
        if (tasks.has(id) && task.at <= now) {
          tasks.delete(id);
          task.fn();
        }
    },
    tasks,
  };
}
const capture = (at, n, extras = {}) => ({
  sessionId: 1,
  configurationVersion: 1,
  path: "MediaStreamTrackGenerator",
  sampledAtMs: at,
  renderer: {
    received: n,
    constructed: n,
    accepted: n,
    written: n,
    backpressure: 0,
    writeFailures: 0,
    canvasDrawn: 0,
    drawFailures: 0,
  },
  native: {
    sampledAtMs: at,
    native: { incomingFrames: n, emittedFrames: n, jsDeliveredFrames: n },
    delivery: { posted: n, acknowledged: n, coalesced: 0, failures: 0 },
  },
  timings: { write: { count: n, totalMs: n * 2, maxMs: 3 } },
  ...extras,
});
const stats = (at, frames, sourceFrames = frames) =>
  new Map([
    [
      "v",
      {
        id: "v",
        type: "outbound-rtp",
        kind: "video",
        timestamp: at,
        framesEncoded: frames,
        framesSent: frames,
        bytesSent: frames * 100,
        frameWidth: 1280,
        frameHeight: 720,
        codecId: "c",
        mediaSourceId: "s",
      },
    ],
    [
      "s",
      {
        id: "s",
        type: "media-source",
        kind: "video",
        timestamp: at,
        frames: sourceFrames,
      },
    ],
    ["c", { id: "c", type: "codec", timestamp: at, mimeType: "video/H264" }],
  ]);

test("trace is opt-in and cannot escape production experiment gating", () => {
  assert.equal(
    screenShareExperiment(false, "h264", 8_000_000, true),
    undefined,
  );
  assert.equal(
    screenShareExperiment(true, "auto", undefined, "true"),
    undefined,
  );
  assert.deepEqual(screenShareExperiment(true, "auto", undefined, true), {
    codec: "auto",
    maxBitrate: undefined,
    traceSeconds: 90,
  });
  const events = [];
  startScreenShareFlowTrace({
    experiment: { codec: "auto" },
    getSender: () => {
      throw Error("must not poll");
    },
    log: (r) => events.push(r),
  });
  assert.equal(events.length, 0);
});

test("stage rates use actual clocks, preserve unknowns, and reset at a quality/session change", () => {
  assert.equal(summarizeCaptureFlow(null, null), null);
  assert.equal(
    summarizeCaptureFlow(capture(1000, 60), null).renderer.rates.written,
    null,
  );
  const result = summarizeCaptureFlow(capture(2000, 120), capture(1000, 60));
  assert.equal(result.native.rates.emittedFrames, 60);
  assert.equal(result.renderer.rates.written, 60);
  assert.equal(result.timings.write.meanMs, 2);
  assert.equal(result.timings.write.maxSinceFirstTraceMs, 3);
  for (const extras of [
    { sessionId: 2 },
    { configurationVersion: 2 },
    { sampledAtMs: 500 },
  ])
    assert.equal(
      summarizeCaptureFlow(capture(2000, 120, extras), capture(1000, 60))
        .renderer.rates.written,
      null,
    );
  assert.equal(
    summarizeCaptureFlow(capture(2000, 10), capture(1000, 60)).renderer.rates
      .written,
    null,
  );
  assert.equal(
    summarizeCaptureFlow(
      capture(2000, 120, { native: null }),
      capture(1000, 60),
    ).native,
    null,
  );
});

test("one-second trace distinguishes native, browser source, encoding and sending without leaking extra fields", async () => {
  const time = clock(),
    events = [];
  let frames = 0,
    nativeFrames = 0,
    sourceFrames = 0;
  const track = {
    readyState: "live",
    getSettings: () => ({ width: 1280, height: 720, frameRate: 60 }),
    getCaptureDiagnostics: async () => capture(time.now() + 1000, nativeFrames),
  };
  const sender = {
    track,
    getParameters: () => ({
      degradationPreference: "maintain-resolution",
      encodings: [{ maxBitrate: 6_000_000 }],
    }),
    getStats: async () => {
      const report = stats(time.now() + 1000, frames, sourceFrames);
      report.set("ip", {
        id: "ip",
        type: "local-candidate",
        address: "PRIVATE_ADDRESS",
      });
      return report;
    },
  };
  const stop = startScreenShareFlowTrace({
    getSender: () => sender,
    experiment: { codec: "h264", traceSeconds: 90, maxBitrate: 6_000_000 },
    log: (r) => events.push(r),
    clock: time,
  });
  await flush();
  frames = 54;
  sourceFrames = 55;
  nativeFrames = 60;
  time.advance(1000);
  await flush();
  const latest = events.at(-1);
  assert.equal(latest.capture.native.rates.emittedFrames, 60);
  assert.equal(latest.capture.renderer.rates.written, 60);
  assert.equal(latest.sender.streams[0].sentFps, 54);
  assert.equal(latest.sender.streams[0].sourceFps, 55);
  assert.equal(latest.limits[0].maxBitrate, 6_000_000);
  assert.equal(latest.degradationPreference, "maintain-resolution");
  assert.equal(JSON.stringify(events).includes("PRIVATE_ADDRESS"), false);
  stop();
  assert.equal(time.tasks.size, 0);
  assert.equal(events.at(-1).reason, "stopped");
});

test("frame-gap buckets expose interval cadence and retain unknown/reset histograms", () => {
  const timing = (count, buckets) => ({
    count,
    totalMs: count * 17,
    minMs: 6,
    maxMs: 36,
    buckets,
  });
  const before = capture(1000, 2, {
    timings: { arrivalGap: timing(2, [0, 0, 0, 2, 0, 0, 0, 0, 0]) },
  });
  const current = capture(2000, 7, {
    timings: { arrivalGap: timing(7, [1, 0, 0, 4, 1, 0, 1, 0, 0]) },
  });
  const result = summarizeCaptureFlow(current, before).timings.arrivalGap;
  assert.deepEqual(result.gapUpperMs, [8, 12, 16, 20, 25, 33, 50, 100]);
  assert.deepEqual(result.gapBuckets, [1, 0, 0, 2, 1, 0, 1, 0, 0]);
  assert.equal(result.minSinceFirstTraceMs, 6);
  assert.equal(
    summarizeCaptureFlow(capture(2000, 7), capture(1000, 2)).timings.arrivalGap
      .gapBuckets,
    null,
  );
  assert.equal(
    summarizeCaptureFlow(current, null).timings.arrivalGap.gapBuckets,
    null,
  );
  for (const invalid of [
    undefined,
    [],
    [1, 0, 0, 1, 0, 0, 0, 0, 0],
    [1, 0, 0, 4, 1, 0, NaN, 0, 0],
    [1, 0, 0, 4, 1, 0, 0.5, 0, 0],
    [1, 0, 0, 1, 1, 0, 4, 0, 0],
  ]) {
    const bad = capture(2000, 7, {
      timings: { arrivalGap: timing(7, invalid) },
    });
    assert.equal(
      summarizeCaptureFlow(bad, before).timings.arrivalGap.gapBuckets,
      null,
    );
  }
  assert.equal(
    summarizeCaptureFlow({ ...current, configurationVersion: 2 }, before)
      .timings.arrivalGap.gapBuckets,
    null,
  );
});

test("a resolution adaptation policy change resets trace baselines", async () => {
  const time = clock(),
    events = [];
  let preference = "maintain-framerate";
  const track = {
    readyState: "live",
    getSettings: () => ({ width: 1280, height: 720, frameRate: 60 }),
    getCaptureDiagnostics: async () =>
      capture(time.now() + 1000, time.now() * 0.06),
  };
  const sender = {
    track,
    getParameters: () => ({
      degradationPreference: preference,
      encodings: [{ maxBitrate: 6_000_000 }],
    }),
    getStats: async () => stats(time.now() + 1000, time.now() * 0.06),
  };
  const stop = startScreenShareFlowTrace({
    getSender: () => sender,
    experiment: { codec: "h264", traceSeconds: 90 },
    clock: time,
    log: (record) => events.push(record),
  });
  await flush();
  time.advance(1000);
  await flush();
  assert.equal(events.at(-1).sender.streams[0].sentFps, 60);
  preference = "maintain-resolution";
  time.advance(1000);
  await flush();
  assert.equal(events.at(-1).degradationPreference, "maintain-resolution");
  assert.equal(events.at(-1).sender.streams[0].sentFps, null);
  assert.equal(events.at(-1).capture.renderer.rates.written, null);
  time.advance(1000);
  await flush();
  assert.equal(events.at(-1).sender.streams[0].sentFps, 60);
  stop();
});

test("hung reads never overlap and the hard deadline prevents late publication", async () => {
  const time = clock(),
    events = [];
  let calls = 0,
    resolve;
  const sender = {
    track: { readyState: "live" },
    getStats: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  startScreenShareFlowTrace({
    getSender: () => sender,
    experiment: { codec: "auto", traceSeconds: 90 },
    log: (r) => events.push(r),
    clock: time,
  });
  time.advance(3000);
  await flush();
  assert.equal(calls, 1);
  time.advance(87_000);
  await flush();
  assert.equal(events.at(-1).reason, "completed");
  resolve(stats(90_000, 100));
  await flush();
  assert.equal(events.length, 2);
  assert.equal(time.tasks.size, 0);
});

test("capture read failures retain browser statistics and diagnostic failures stay isolated", async () => {
  for (const asynchronous of [false, true]) {
    const time = clock(),
      events = [];
    const sender = {
      track: {
        readyState: "live",
        getSettings: () => ({}),
        getCaptureDiagnostics: () => {
          if (asynchronous) return Promise.reject(Error("capture read"));
          throw Error("capture read");
        },
      },
      getStats: async () => stats(time.now() + 1000, 60),
      getParameters: () => ({}),
    };
    const stop = startScreenShareFlowTrace({
      getSender: () => sender,
      experiment: { codec: "auto", traceSeconds: 90 },
      log: (r) => events.push(r),
      clock: time,
    });
    await flush();
    assert.equal(events.at(-1).event, "sample");
    assert.equal(events.at(-1).capture, null);
    stop();
    assert.equal(time.tasks.size, 0);
  }
  const time = clock();
  let calls = 0;
  const stop = startScreenShareFlowTrace({
    getSender: () => {
      calls++;
      throw Error("sender lookup");
    },
    experiment: { codec: "auto", traceSeconds: 90 },
    log: () => {
      throw Error("logging");
    },
    clock: time,
  });
  time.advance(1000);
  await flush();
  assert.equal(calls, 2);
  stop();
  assert.equal(time.tasks.size, 0);
});

test("timer failures stop optional diagnostics without throwing into sharing", async () => {
  for (const failure of ["deadline", "sample", "cleanup"]) {
    const time = clock(),
      events = [];
    const schedule = time.setTimeout,
      cancel = time.clearTimeout;
    time.setTimeout = (fn, ms) => {
      if (
        (failure === "deadline" && ms === 90_000) ||
        (failure === "sample" && ms === 1000)
      )
        throw Error("timer unavailable");
      return schedule(fn, ms);
    };
    time.clearTimeout = (id) => {
      if (failure === "cleanup") throw Error("timer cleanup unavailable");
      cancel(id);
    };
    let reads = 0;
    const track = {
      readyState: "live",
      getSettings: () => ({ frameRate: 60 }),
    };
    const sender = {
      track,
      getParameters: () => ({}),
      getStats: async () => {
        reads++;
        return stats(time.now() + 1000, 0);
      },
    };
    const stop = startScreenShareFlowTrace({
      getSender: () => sender,
      experiment: { codec: "h264", traceSeconds: 90 },
      log: (r) => events.push(r),
      clock: time,
    });
    await flush();
    assert.equal(reads, failure === "deadline" ? 0 : 1);
    stop();
    const count = events.length;
    time.advance(90_000);
    await flush();
    assert.equal(events.length, count);
    assert.equal(track.readyState, "live");
    assert.equal(events.at(-1).event, "end");
    assert.equal(
      events.at(-1).reason,
      failure === "cleanup" ? "stopped" : "timer-unavailable",
    );
  }
});

test("a ceiling change resets baselines and replacing the track ends the trace", async () => {
  const time = clock(),
    events = [];
  let maxBitrate = 6_000_000;
  const track = {
    readyState: "live",
    getSettings: () => ({ width: 1280, height: 720, frameRate: 60 }),
    getCaptureDiagnostics: async () =>
      capture(time.now() + 1000, time.now() * 0.06),
  };
  const sender = {
    track,
    getStats: async () => stats(time.now() + 1000, time.now() * 0.054),
    getParameters: () => ({ encodings: [{ maxBitrate }] }),
  };
  startScreenShareFlowTrace({
    getSender: () => sender,
    experiment: { codec: "h264", traceSeconds: 90 },
    log: (r) => events.push(r),
    clock: time,
  });
  await flush();
  time.advance(1000);
  await flush();
  assert.equal(events.at(-1).sender.streams[0].sentFps, 54);
  maxBitrate = 8_000_000;
  time.advance(1000);
  await flush();
  assert.equal(events.at(-1).sender.streams[0].sentFps, null);
  assert.equal(events.at(-1).capture.native.rates.emittedFrames, null);
  time.advance(1000);
  await flush();
  assert.equal(events.at(-1).capture.native.rates.emittedFrames, 60);
  sender.track = { ...track };
  time.advance(1000);
  await flush();
  assert.equal(events.at(-1).reason, "sender-replaced");
  assert.equal(time.tasks.size, 0);
});

test("replacement and stop discard in-flight reads; Chromium/old desktop capture stays unknown", async () => {
  for (const action of ["replace", "stop"]) {
    const time = clock(),
      events = [];
    let resolve;
    let sender = {
      track: { readyState: "live", getSettings: () => ({ frameRate: 60 }) },
      getParameters: () => ({}),
      getStats: () =>
        new Promise((r) => {
          resolve = r;
        }),
    };
    const stop = startScreenShareFlowTrace({
      getSender: () => sender,
      experiment: { codec: "auto", traceSeconds: 90 },
      log: (r) => events.push(r),
      clock: time,
    });
    await flush();
    if (action === "replace") sender = {};
    else stop();
    resolve(stats(1000, 0));
    await flush();
    assert.equal(events.at(-1).event, "end");
    assert.equal(events.filter((r) => r.event === "sample").length, 0);
    assert.equal(time.tasks.size, 0);
  }
  const time = clock(),
    events = [];
  const sender = {
    track: { readyState: "live", getSettings: () => ({ frameRate: 60 }) },
    getParameters: () => ({}),
    getStats: async () => stats(1000, 0),
  };
  const stop = startScreenShareFlowTrace({
    getSender: () => sender,
    experiment: { codec: "auto", traceSeconds: 90 },
    log: (r) => events.push(r),
    clock: time,
  });
  await flush();
  assert.equal(events.at(-1).capture, null);
  stop();
});

test("Voice starts an opted-in trace once per track and tears it down with the publication", () => {
  const source = readFileSync(new URL("./state.tsx", import.meta.url), "utf8");
  const method = (start) => {
    const begin = source.indexOf(start);
    const end = source.indexOf("\n  /**", begin);
    assert.ok(begin >= 0 && end > begin);
    return source.slice(begin, end);
  };
  const traces = [];
  let stops = 0;
  const context = vm.createContext({
    console: { info() {} },
    Track: { Source: { ScreenShare: "screen" } },
    startScreenShareEncoderMonitor: () => () => {},
    startScreenShareFlowTrace: (options) => {
      traces.push(options);
      return () => {
        stops++;
      };
    },
  });
  const fixture = `class Harness {
    #codecDecisionsByTrack = new WeakMap();
    #tracedFlowTracks = new WeakSet();
    #stopFlowTrace; #stopSenderDiagnostics; #stopEncoderMonitor;
    #diagnosticPublication; #lastShareChoice;
    room() { return this.activeRoom; }
    watch(pub, decision) {this.#diagnosticPublication = pub; this.#watchForSoftwareFallback(pub, decision);}
    clear() {this.#clearSenderDiagnostics();}
    ${method("  #clearSenderDiagnostics()")}
    ${method("  #watchForSoftwareFallback(")}
  }; globalThis.Harness = Harness;`;
  const ts = createRequire(import.meta.url)("typescript");
  vm.runInContext(
    ts.transpileModule(fixture, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  const voice = new context.Harness();
  const pub = { videoTrack: { mediaStreamTrack: {}, sender: {} } };
  let current = pub;
  const room = { localParticipant: { getTrackPublication: () => current } };
  voice.activeRoom = room;
  voice.watch(pub, { codec: "h264" });
  assert.equal(traces.length, 0);
  const decision = {
    codec: "h264",
    experiment: { codec: "h264", traceSeconds: 90 },
  };
  voice.watch(pub, decision);
  assert.equal(traces[0].getSender(), pub.videoTrack.sender);
  voice.watch(pub, decision);
  assert.equal(traces.length, 1);
  current = {};
  assert.equal(traces[0].getSender(), undefined);
  current = pub;
  voice.activeRoom = {};
  assert.equal(traces[0].getSender(), undefined);
  voice.activeRoom = room;
  voice.clear();
  assert.equal(stops, 1);
  assert.equal(traces[0].getSender(), undefined);
  const replacement = { videoTrack: { mediaStreamTrack: {}, sender: {} } };
  current = replacement;
  voice.watch(replacement, decision);
  assert.equal(traces.length, 2);
  voice.clear();
  assert.equal(stops, 2);
});
