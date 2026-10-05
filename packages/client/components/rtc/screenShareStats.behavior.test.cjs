// Executes the real Solid sampler and presentation helper with fake media and time.
/* global require, __dirname, console */
/* eslint @typescript-eslint/no-require-imports: "off" -- Node/CommonJS harness evaluates transpiled TypeScript. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const test = require("node:test");

function harness(local = false) {
  let now = 0,
    nextId = 0,
    frameCallback;
  const timers = new Map(),
    cleanups = [],
    listeners = new Map();
  const document = {
    hidden: false,
    addEventListener: (key, fn) => listeners.set(key, fn),
    removeEventListener: (key) => listeners.delete(key),
  };
  const video = {
    isConnected: true,
    requestVideoFrameCallback(fn) {
      frameCallback = fn;
      return 1;
    },
    cancelVideoFrameCallback() {},
  };
  let pending;
  let reads = 0;
  let extraStats = [];
  let encodings = [{ maxFramerate: 30 }];
  let videoStat = {
    id: "v",
    type: local ? "outbound-rtp" : "inbound-rtp",
    kind: "video",
    timestamp: 1000,
    framesDecoded: 100,
    framesReceived: 100,
    framesEncoded: 100,
    framesSent: 100,
    bytesReceived: 1000,
    bytesSent: 1000,
    framesPerSecond: 30,
  };
  const owner = {
    getStats: () => {
      reads++;
      return (
        pending ??
        Promise.resolve(
          new Map([videoStat, ...extraStats].map((stat) => [stat.id, stat])),
        )
      );
    },
    getParameters: () => ({ encodings }),
  };
  let track = { mediaStreamTrack: {}, sender: owner, receiver: owner };
  const participant = { getTrackPublication: () => undefined };
  const ref = () => ({ participant, publication });
  const publication = {
    get track() {
      return track;
    },
  };
  const context = vm.createContext({
    performance: { now: () => now },
    document,
    console,
    setTimeout: (fn, delay) => {
      const id = ++nextId;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  function load(file, imports = {}) {
    const module = { exports: {} };
    const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.React,
      },
    }).outputText;
    context.module = module;
    context.exports = module.exports;
    context.require = (name) => {
      if (name in imports) return imports[name];
      throw Error("unexpected import " + name);
    };
    vm.runInContext(output, context, { filename: file });
    return module.exports;
  }
  const resolution = load(path.join(__dirname, "screenShareResolution.ts"));
  const telemetry = load(path.join(__dirname, "screenShareTelemetry.ts"), {
    "./screenShareResolution.ts": resolution,
  });
  const bandwidth = load(path.join(__dirname, "screenShareBandwidth.ts"));
  const solid = {
    createSignal: (initial) => {
      let value = initial;
      return [
        () => value,
        (next) => {
          value = next;
        },
      ];
    },
    createEffect: (fn) => fn(),
    onCleanup: (fn) => cleanups.push(fn),
  };
  const sampler = load(
    path.join(
      __dirname,
      "../ui/components/features/voice/callCard/ScreenShareStats.tsx",
    ),
    {
      "solid-js": solid,
      "@lingui/solid/macro": {},
      "@livekit/components-core": { isLocal: () => local },
      "@revolt/rtc/screenShareBandwidth": bandwidth,
      "@revolt/rtc/screenShareTelemetry": telemetry,
      "@solid-primitives/keyed": {},
      "livekit-client": { Track: { Source: { ScreenShareAudio: "audio" } } },
      "styled-system/jsx": {
        styled: new Proxy(() => undefined, { get: () => () => undefined }),
      },
      "@revolt/ui/components/utils/Symbol": {},
    },
  ).createScreenShareSample(ref, () => video);
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  return {
    sampler,
    timers,
    owner,
    row: (label) => sampler.rows().find((row) => row.label === label)?.value,
    setStat: (fields) => {
      videoStat = { ...videoStat, ...fields };
    },
    setExtraStats: (stats) => {
      extraStats = stats;
    },
    setEncodings: (value) => {
      encodings = value;
    },
    delay: (promise) => {
      pending = promise;
    },
    replaceTrack: () => {
      track = { ...track, mediaStreamTrack: {} };
    },
    presented: (frames) => frameCallback?.(now, { presentedFrames: frames }),
    reads: () => reads,
    async tick(ms = 0) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      await flush();
    },
    async visible(hidden) {
      document.hidden = hidden;
      listeners.get("visibilitychange")?.();
      await flush();
    },
    cleanup() {
      cleanups.forEach((fn) => fn());
    },
  };
}

test("viewer distinguishes 30 browser estimate, 15 decoded, and 10 presented; stall is zero", async () => {
  const h = harness();
  try {
    await h.tick();
    h.presented(100);
    h.setStat({ timestamp: 2000, framesDecoded: 115, framesReceived: 120 });
    await h.tick(1000);
    h.presented(110);
    h.setStat({ timestamp: 3000, framesDecoded: 130, framesReceived: 140 });
    await h.tick(1000);
    assert.equal(h.row("Decoded FPS"), "15.0 fps");
    assert.equal(h.row("Received FPS"), "20.0 fps");
    assert.equal(h.row("Presented FPS (compositor)"), "10.0 fps");
    assert.equal(h.row("Browser decode estimate"), "30.0 fps");
    h.setStat({ timestamp: 4000 });
    await h.tick(1000);
    assert.equal(h.row("Decoded FPS"), "0.0 fps");
    assert.equal(h.row("Presented FPS (compositor)"), "0.0 fps");
    assert.equal(h.row("Bitrate"), "0 kbps");
    h.setStat({ timestamp: 5000, framesDecoded: 5 });
    await h.tick(1000);
    assert.equal(h.row("Decoded FPS"), "--");
  } finally {
    h.cleanup();
  }
});

test("sender badge uses sent counter rather than encoded/browser FPS", async () => {
  const h = harness(true);
  try {
    await h.tick();
    h.setStat({ timestamp: 2000, framesSent: 110, framesEncoded: 115 });
    await h.tick(1000);
    assert.equal(h.row("Sent FPS"), "10.0 fps");
    assert.equal(h.row("Encoded FPS"), "15.0 fps");
    assert.equal(h.sampler.ownSummary().fps, 10);
  } finally {
    h.cleanup();
  }
});

test("sender telemetry shows recent deltas instead of historical weak-link verdicts", async () => {
  const h = harness(true);
  try {
    h.setEncodings([{ maxFramerate: 60, maxBitrate: 6000000 }]);
    h.setStat({
      qualityLimitationDurations: { bandwidth: 318.203 },
      qualityLimitationReason: "none",
    });
    await h.tick();
    assert.equal(h.row("Bandwidth limited (recent)"), "--");
    assert.equal(h.row("Weak link"), undefined);
    h.setStat({ timestamp: 2000, framesSent: 160 });
    await h.tick(1000);
    assert.equal(h.row("Bandwidth limited (recent)"), "0.0s / 1.0s");
    h.setStat({
      timestamp: 3000,
      framesSent: 220,
      qualityLimitationDurations: { bandwidth: 319.003 },
      qualityLimitationReason: "bandwidth",
    });
    await h.tick(1000);
    assert.equal(h.row("Bandwidth limited (recent)"), "0.8s / 1.0s");
    h.setStat({
      timestamp: 4000,
      framesSent: 280,
      qualityLimitationReason: "none",
    });
    await h.tick(1000);
    assert.equal(h.row("Bandwidth limited (recent)"), "0.0s / 1.0s");
    h.setEncodings([{ maxFramerate: 30, maxBitrate: 4000000 }]);
    h.setStat({ timestamp: 5000, framesSent: 310 });
    await h.tick(1000);
    assert.equal(h.row("Bandwidth limited (recent)"), "--");
    h.setStat({
      timestamp: 6000,
      framesSent: 340,
      qualityLimitationDurations: { bandwidth: 0 },
    });
    await h.tick(1000);
    assert.equal(h.row("Bandwidth limited (recent)"), "--");
  } finally {
    h.cleanup();
  }
});

test("sender quality diagnostics distinguish ceiling, target and recent counters", async () => {
  const h = harness(true);
  try {
    h.setEncodings([{ maxBitrate: 8_000_000, maxFramerate: 65 }]);
    h.setStat({
      qpSum: 2000,
      packetsSent: 100,
      retransmittedBytesSent: 1000,
      totalPacketSendDelay: 0.2,
      qualityLimitationResolutionChanges: 8,
      nackCount: 10,
      pliCount: 1,
    });
    await h.tick();
    assert.equal(h.row("Mean QP (codec-specific)"), "--");
    assert.equal(h.row("Encoder target bitrate"), "--");
    h.setStat({
      timestamp: 2000,
      framesEncoded: 130,
      framesSent: 130,
      qpSum: 2900,
      packetsSent: 200,
      retransmittedBytesSent: 6000,
      totalPacketSendDelay: 0.4,
      qualityLimitationResolutionChanges: 9,
      nackCount: 12,
      pliCount: 1,
      targetBitrate: 4_500_000,
    });
    await h.tick(1000);
    assert.equal(h.row("Bitrate ceiling"), "8.00 Mbps");
    assert.equal(h.row("Encoder target bitrate"), "4.50 Mbps");
    assert.equal(h.row("Mean QP (codec-specific)"), "30.0");
    assert.equal(h.row("Packet send delay"), "2.0 ms");
    assert.equal(h.row("Retransmission bitrate"), "40 kbps");
    assert.equal(h.row("Browser resolution changes (recent)"), "1");
    assert.equal(h.row("NACK / PLI (recent)"), "2 / 0");
    h.setStat({
      timestamp: 3000,
      codecId: "different",
      framesEncoded: 160,
      qpSum: 3800,
    });
    await h.tick(1000);
    assert.equal(h.row("Mean QP (codec-specific)"), "--");
  } finally {
    h.cleanup();
  }
});

test("sender panel observes resolution switches and resets after hidden, missing and replaced samples", async () => {
  const h = harness(true);
  try {
    h.setStat({
      frameWidth: 1280,
      frameHeight: 720,
      qualityLimitationResolutionChanges: 0,
    });
    await h.tick();
    assert.equal(h.row("Observed resolution changes (recent)"), "--");
    h.setStat({
      timestamp: 2000,
      frameWidth: 960,
      frameHeight: 540,
      framesSent: 130,
    });
    await h.tick(1000);
    assert.equal(h.row("Browser resolution changes (recent)"), "0");
    assert.equal(h.row("Observed resolution changes (recent)"), "1");
    h.setStat({ timestamp: 3000 });
    await h.tick(1000);
    assert.equal(h.row("Observed resolution changes (recent)"), "0");
    h.setStat({ timestamp: 4000, frameHeight: undefined });
    await h.tick(1000);
    assert.equal(h.row("Observed resolution changes (recent)"), "--");
    h.setStat({ timestamp: 5000, frameWidth: 640, frameHeight: 360 });
    await h.tick(1000);
    assert.equal(h.row("Observed resolution changes (recent)"), "--");
    await h.visible(true);
    h.setStat({ timestamp: 6000, frameWidth: 1280, frameHeight: 720 });
    await h.visible(false);
    await h.tick();
    assert.equal(h.row("Observed resolution changes (recent)"), "--");
    h.setStat({
      timestamp: 7000,
      codecId: "new",
      frameWidth: 960,
      frameHeight: 540,
    });
    await h.tick(1000);
    assert.equal(h.row("Observed resolution changes (recent)"), "--");
  } finally {
    h.cleanup();
  }
});

test("stale larger sender stream cannot hide a flowing layer; receiver ignores repair RTP", async () => {
  const h = harness(true);
  try {
    h.setStat({ frameWidth: 1280, ssrc: 1 });
    h.setExtraStats([
      {
        id: "old",
        type: "outbound-rtp",
        kind: "video",
        frameWidth: 1920,
        timestamp: 1000,
        framesSent: 100,
        ssrc: 2,
      },
    ]);
    await h.tick();
    h.setStat({ timestamp: 2000, framesSent: 115 });
    h.setExtraStats([
      {
        id: "old",
        type: "outbound-rtp",
        kind: "video",
        frameWidth: 1920,
        timestamp: 2000,
        framesSent: 100,
        ssrc: 2,
      },
    ]);
    await h.tick(1000);
    assert.equal(h.row("Stream SSRC"), "1");
    assert.equal(h.row("Sent FPS"), "--"); // layer switch starts a fresh window
    h.setStat({ timestamp: 3000, framesSent: 130 });
    await h.tick(1000);
    assert.equal(h.row("Sent FPS"), "15.0 fps");
  } finally {
    h.cleanup();
  }
  const viewer = harness();
  try {
    viewer.setStat({ frameWidth: 1280, ssrc: 3 });
    viewer.setExtraStats([
      {
        id: "repair",
        type: "inbound-rtp",
        kind: "video",
        codecId: "rtx",
        frameWidth: 1920,
        ssrc: 4,
      },
      { id: "rtx", type: "codec", mimeType: "video/rtx" },
    ]);
    await viewer.tick();
    assert.equal(viewer.row("Stream SSRC"), "3");
  } finally {
    viewer.cleanup();
  }
});

test("slow stats never overlap; stale track, hidden tab and disposed reads cannot publish", async () => {
  const h = harness();
  let resolve;
  try {
    h.delay(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await h.tick();
    await h.tick(5000);
    assert.equal(h.reads(), 1);
    h.replaceTrack();
    resolve(
      new Map([
        [
          "v",
          {
            id: "v",
            type: "inbound-rtp",
            kind: "video",
            timestamp: 1000,
            framesDecoded: 999,
          },
        ],
      ]),
    );
    await h.tick();
    assert.equal(h.sampler.rows().length, 0);
    h.delay(undefined);
    await h.tick(1000);
    assert.equal(h.row("Decoded FPS"), "--");
    await h.visible(true);
    await h.tick(5000);
    assert.equal(h.timers.size, 0);
    await h.visible(false);
    await h.tick();
    assert.equal(h.row("Decoded FPS"), "--");
    let finish;
    h.delay(
      new Promise((done) => {
        finish = done;
      }),
    );
    await h.tick(1000);
    h.cleanup();
    finish(new Map());
    await h.tick();
    assert.equal(h.timers.size, 0);
    assert.equal(h.sampler.rows().length, 0);
  } finally {
    h.cleanup();
  }
});
