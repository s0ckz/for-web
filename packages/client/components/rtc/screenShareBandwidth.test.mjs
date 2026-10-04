import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { URL } from "node:url";
import vm from "node:vm";
import {
  ScreenShareBandwidthObserver,
  screenShareBandwidthConfiguration,
} from "./screenShareBandwidth.ts";
import { startSenderDiagnostics } from "./screenShareDiagnostics.ts";

const stat = (seconds, bandwidth = seconds, extra = {}) => ({
  id: "video",
  type: "outbound-rtp",
  kind: "video",
  ssrc: 1,
  timestamp: seconds * 1000,
  framesSent: seconds * 60,
  frameWidth: 1280,
  codecId: "h264",
  transportId: "transport",
  qualityLimitationReason: "bandwidth",
  qualityLimitationDurations: { bandwidth },
  ...extra,
});
const setup = () => {
  let now = 0;
  const observer = new ScreenShareBandwidthObserver(() => now);
  const owner = {};
  return {
    observer,
    owner,
    read(
      seconds,
      bandwidth = seconds,
      extra = {},
      configuration = "720p60",
      sender = owner,
      visible = true,
    ) {
      now = seconds * 1000;
      return observer.read(
        [
          stat(seconds, bandwidth, extra),
          {
            id: "transport",
            type: "transport",
            timestamp: now,
            selectedCandidatePairId: "pair",
          },
          {
            id: "pair",
            type: "candidate-pair",
            timestamp: now,
            availableOutgoingBitrate: 1,
          },
        ],
        sender,
        configuration,
        visible,
      );
    },
  };
};

test("318 seconds of historical limitation and low transport estimates are not recent pressure", () => {
  const h = setup();
  assert.equal(h.read(0, 318.203).limitedSeconds, undefined);
  for (const time of [10, 20, 30, 40, 50]) {
    const sample = h.read(time, 318.203, {
      qualityLimitationReason: "none",
      availableOutgoingBitrate: 1,
    });
    assert.equal(sample.limitedSeconds, 0);
    assert.equal(sample.sustained, false);
  }
});

test("startup congestion followed by recovery never becomes an advisory", () => {
  const h = setup();
  for (const time of [0, 10, 20]) assert.equal(h.read(time).sustained, false);
  for (const time of [30, 40, 50]) {
    const sample = h.read(time, 20, { qualityLimitationReason: "none" });
    assert.equal(sample.sustained, false);
    assert.equal(sample.limitedSeconds, 0);
  }
});

test("sustained pressure requires 20 seconds after settling and clears on recovery", () => {
  const h = setup();
  for (const time of [0, 10, 20, 30])
    assert.equal(h.read(time).sustained, false);
  assert.equal(h.read(40).sustained, true);
  assert.equal(
    h.read(50, 40, { qualityLimitationReason: "none" }).sustained,
    false,
  );
  assert.equal(h.read(60, 50).sustained, false);
  assert.equal(h.read(70, 60).sustained, true);
});

test("one-second UI reads and ten-second diagnostics use the same duration requirement", () => {
  const h = setup();
  for (let time = 0; time < 40; time++)
    assert.equal(h.read(time).sustained, false);
  assert.equal(h.read(40).sustained, true);
});

test("a transient, CPU limit, stale reason or idle stream cannot accumulate bandwidth pressure", () => {
  for (const extra of [
    { qualityLimitationReason: "cpu" },
    { qualityLimitationReason: "none" },
    { framesSent: 0 },
  ]) {
    const h = setup();
    for (const time of [0, 10, 20, 30, 40, 50])
      assert.equal(h.read(time, time, extra).sustained, false);
  }
  const h = setup();
  for (const time of [0, 10, 20, 30, 40])
    assert.equal(h.read(time, time * 0.4).sustained, false);
});

test("quality, sender, RTP identity and selected transport replacements restart settling", () => {
  for (const change of [
    { configuration: "1080p60" },
    { sender: {} },
    { extra: { ssrc: 2 } },
    { extra: { codecId: "vp9" } },
    { extra: { id: "new-video" } },
    { extra: { transportId: "new-transport" } },
  ]) {
    const h = setup();
    for (const time of [0, 10, 20, 30]) h.read(time);
    assert.equal(
      h.read(40, 40, change.extra, change.configuration, change.sender)
        .sustained,
      false,
    );
  }
  let now = 0;
  const observer = new ScreenShareBandwidthObserver(() => now);
  for (const time of [0, 10, 20, 30, 40]) {
    now = time * 1000;
    const sample = observer.read(
      [
        stat(time),
        {
          id: "transport",
          type: "transport",
          timestamp: now,
          selectedCandidatePairId: time < 40 ? "old" : "new",
        },
      ],
      "sender",
      "720p60",
    );
    assert.equal(sample.sustained, false);
  }
});

test("missing, reset or impossible counters and long/hidden gaps remain unknown", () => {
  for (const extra of [
    { qualityLimitationDurations: undefined },
    { qualityLimitationDurations: { bandwidth: 1 } },
    { qualityLimitationDurations: { bandwidth: 1000 } },
    { qualityLimitationDurations: { bandwidth: NaN } },
    { timestamp: 0 },
    { framesSent: 1 },
    { active: false },
  ]) {
    const h = setup();
    for (const time of [0, 10, 20, 30]) h.read(time);
    const sample = h.read(40, 40, extra);
    assert.equal(sample.limitedSeconds, undefined);
    assert.equal(sample.sustained, false);
  }
  const h = setup();
  for (const time of [0, 10, 20, 30]) h.read(time);
  assert.equal(
    h.read(40, 40, {}, "720p60", h.owner, false).limitedSeconds,
    undefined,
  );
  assert.equal(h.read(50).sustained, false);
  assert.equal(h.read(100).limitedSeconds, undefined);
});

test("flowing layers override stale larger/inactive streams; retained counters are snapshots", () => {
  let now = 0;
  const observer = new ScreenShareBandwidthObserver(() => now);
  const stale = stat(0, 900, { id: "old", frameWidth: 1920, framesSent: 0 });
  const active = stat(0, 318);
  observer.read([active, stale], "sender", "720p60");
  for (const time of [10, 20, 30, 40, 50]) {
    now = time * 1000;
    active.timestamp = now;
    active.framesSent = time * 60;
    active.qualityLimitationDurations.bandwidth = 318;
    const sample = observer.read(
      [active, { ...stale, timestamp: now }],
      "sender",
      "720p60",
    );
    assert.equal(sample.sustained, false);
    if (time > 10) assert.equal(sample.limitedSeconds, 0);
  }
  now = 60000;
  active.timestamp = now;
  active.framesSent += 600;
  active.qualityLimitationDurations.bandwidth += 10;
  assert.equal(observer.read([active], "sender", "720p60").limitedSeconds, 10);
});

const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

// Execute the actual Voice methods and diagnostics poll, replacing only media/UI.
function voiceHarness(t, frameRate = 60) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  let pending;
  let preparing;
  const notices = [];
  const visibilityListeners = new Set();
  const source = readFileSync(new URL("./state.tsx", import.meta.url), "utf8");
  const method = (start, end) => {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin);
    return source.slice(begin, finish);
  };
  const start = method("  #startScreenShareDiagnostics(", "\n  /**");
  const apply = method("  async #applyShareChoice(", "\n  /**");
  const clear = method("  #clearSenderDiagnostics()", "\n  /**");
  const sender = {
    getStats: () =>
      pending ?? Promise.resolve(new Map([["video", stat(now / 1000)]])),
    getParameters: () => ({
      encodings: [{ maxFramerate: frameRate, maxBitrate: 6_000_000 }],
    }),
  };
  const publication = { videoTrack: { sender, mediaStreamTrack: {} } };
  let currentPublication = publication;
  const room = {
    localParticipant: { getTrackPublication: () => currentPublication },
  };
  const context = vm.createContext({
    console: { info() {} },
    document: {
      visibilityState: "visible",
      addEventListener: (_, listener) => visibilityListeners.add(listener),
      removeEventListener: (_, listener) =>
        visibilityListeners.delete(listener),
    },
    Track: { Source: { ScreenShare: "screen", ScreenShareAudio: "audio" } },
    ScreenShareBandwidthObserver: class extends ScreenShareBandwidthObserver {
      constructor() {
        super(() => now);
      }
    },
    screenShareBandwidthConfiguration,
    startSenderDiagnostics,
    t: (strings) => strings[0],
  });
  const fixture = `let bandwidthAdvisoryShown = false;
    class Harness {
      #stopSenderDiagnostics;
      #stopEncoderMonitor;
      #diagnosticPublication;
      #lastShareChoice = {qualityName: "selected", audio: true};
      activeRoom;
      snackbar = {show: (notice) => this.notices.push(notice)};
      notices = [];
      sound = {playSound() {}};
      room() { return this.activeRoom; }
      getEnabledScreenShareQualities() { return {selected: {resolution: {frameRate: this.frameRate}}, low: {resolution: {frameRate: 30}}}; }
      #applyShareCaptureChoice = async () => this.prepare();
      #applyEncoderLimits = async () => {};
      prepare = () => {};
      start(pub) { this.#diagnosticPublication = pub; this.#startScreenShareDiagnostics(this.activeRoom, pub); }
      clear() { this.#clearSenderDiagnostics(); }
      apply(pub, name = "selected") { return this.#applyShareChoice(this.activeRoom, pub, name, true, false); }
      ${start}
      ${apply}
      ${clear}
    }
    globalThis.Harness = Harness;`;
  const ts = createRequire(import.meta.url)("typescript");
  vm.runInContext(
    ts.transpileModule(fixture, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  const voice = new context.Harness();
  voice.notices = notices;
  voice.frameRate = frameRate;
  voice.activeRoom = room;
  voice.prepare = () => preparing;
  voice.start(publication);
  return {
    voice,
    notices,
    publication,
    setPending(value) {
      pending = value;
    },
    setPreparing(value) {
      preparing = value;
    },
    replacePublication() {
      currentPublication = {};
    },
    visibilityChanged() {
      visibilityListeners.forEach((listener) => listener());
    },
    visibilityListeners,
    async tick() {
      now += 10000;
      t.mock.timers.tick(10000);
      await flush();
    },
  };
}

test("Voice uses one nonblocking advisory after settling, never nags again, and gates 30 FPS", async (t) => {
  const h = voiceHarness(t);
  try {
    await flush();
    for (let index = 0; index < 3; index++) await h.tick();
    assert.equal(h.notices.length, 0);
    await h.tick();
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0].message, /bandwidth limited/);
    assert.equal(h.notices[0].autoCloseDelay, 8000);
    for (let index = 0; index < 5; index++) await h.tick();
    await h.voice.apply(h.publication);
    for (let index = 0; index < 5; index++) await h.tick();
    assert.equal(h.notices.length, 1);
  } finally {
    h.voice.clear();
  }
  const low = voiceHarness(t, 30);
  try {
    await flush();
    for (let index = 0; index < 5; index++) await low.tick();
    assert.equal(low.notices.length, 0);
  } finally {
    low.voice.clear();
  }
});

test("quality changes cancel an in-flight old sample before applying capture and restart settling", async (t) => {
  const h = voiceHarness(t);
  try {
    await flush();
    for (let index = 0; index < 3; index++) await h.tick();
    let finish;
    h.setPending(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await h.tick();
    let prepared;
    h.setPreparing(
      new Promise((resolve) => {
        prepared = resolve;
      }),
    );
    const applying = h.voice.apply(h.publication);
    finish(new Map([["video", stat(40)]]));
    await flush();
    assert.equal(h.notices.length, 0);
    h.setPending(undefined);
    prepared();
    await applying;
    for (let index = 0; index < 3; index++) await h.tick();
    assert.equal(h.notices.length, 0);
    await h.tick();
    assert.equal(h.notices.length, 1);
  } finally {
    h.voice.clear();
  }
});

test("pending stats cannot notify after room/publication replacement or teardown", async (t) => {
  for (const invalidate of [
    (h) => {
      h.voice.activeRoom = undefined;
    },
    (h) => h.replacePublication(),
    (h) => h.voice.clear(),
    (h) => {
      h.publication.videoTrack.mediaStreamTrack.readyState = "ended";
    },
  ]) {
    const h = voiceHarness(t);
    try {
      await flush();
      for (let index = 0; index < 3; index++) await h.tick();
      let finish;
      h.setPending(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      await h.tick();
      invalidate(h);
      finish(new Map([["video", stat(40)]]));
      await flush();
      assert.equal(h.notices.length, 0);
    } finally {
      h.voice.clear();
    }
  }
});

test("visibility changes between polls restart settling and cleanup removes the listener", async (t) => {
  const h = voiceHarness(t);
  try {
    await flush();
    for (let index = 0; index < 3; index++) await h.tick();
    assert.equal(h.visibilityListeners.size, 1);
    h.visibilityChanged();
    for (let index = 0; index < 4; index++) await h.tick();
    assert.equal(h.notices.length, 0);
    await h.tick();
    assert.equal(h.notices.length, 1);
  } finally {
    h.voice.clear();
  }
  assert.equal(h.visibilityListeners.size, 0);
});
