import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers";
import {
  startSenderDiagnostics,
  summarizeSenderDiagnostics,
} from "./screenShareDiagnostics.ts";
const outbound = (timestamp, extras = {}) => ({
  id: "video",
  type: "outbound-rtp",
  kind: "video",
  timestamp,
  framesEncoded: 0,
  framesSent: 0,
  bytesSent: 0,
  totalEncodeTime: 0,
  ...extras,
});
test("first sample has no invented rates; missing fields remain unknown", () => {
  const result = summarizeSenderDiagnostics([outbound(1000)], new Map());
  assert.equal(result.streams[0].encodedFps, null);
  assert.equal(result.streams[0].meanEncodeMs, null);
  assert.equal(result.availableOutgoingBitrate, null);
});
test("computes interval rates and limitation deltas, not lifetime durations", () => {
  const before = outbound(1000, {
    framesEncoded: 30,
    framesSent: 30,
    bytesSent: 1000,
    totalEncodeTime: 0.15,
    qualityLimitationDurations: { bandwidth: 20 },
    codecId: "codec",
  });
  const now = outbound(11000, {
    framesEncoded: 330,
    framesSent: 320,
    bytesSent: 501000,
    totalEncodeTime: 1.65,
    qualityLimitationDurations: { bandwidth: 22 },
    codecId: "codec",
  });
  const result = summarizeSenderDiagnostics(
    [
      now,
      { id: "codec", type: "codec", timestamp: 11000, mimeType: "video/H264" },
    ],
    new Map([[before.id, before]]),
  );
  assert.equal(result.streams[0].encodedFps, 30);
  assert.equal(result.streams[0].sentFps, 29);
  assert.equal(result.streams[0].bitrateBps, 400000);
  assert.equal(result.streams[0].meanEncodeMs, 5);
  assert.equal(result.streams[0].limitedSeconds.bandwidth, 2);
  assert.equal(result.streams[0].codec, "video/H264");
});
test("counter reset and new RTP stream do not produce negative or inflated rates", () => {
  const old = outbound(1000, { framesEncoded: 900, bytesSent: 500000 });
  const result = summarizeSenderDiagnostics(
    [
      outbound(11000, { framesEncoded: 1 }),
      { ...outbound(11000), id: "new-video" },
    ],
    new Map([[old.id, old]]),
  );
  assert.equal(result.streams[0].encodedFps, null);
  assert.equal(result.streams[1].encodedFps, null);
});
test("selected candidate pair overrides a stale nominated pair", () => {
  const result = summarizeSenderDiagnostics(
    [
      {
        id: "transport",
        type: "transport",
        timestamp: 1,
        selectedCandidatePairId: "selected",
      },
      {
        id: "stale",
        type: "candidate-pair",
        timestamp: 1,
        nominated: true,
        state: "succeeded",
        availableOutgoingBitrate: 1,
      },
      {
        id: "selected",
        type: "candidate-pair",
        timestamp: 1,
        availableOutgoingBitrate: 6000000,
      },
    ],
    new Map(),
  );
  assert.equal(result.availableOutgoingBitrate, 6000000);
});

test("diagnostics follow the flowing video's transport and leave ambiguous estimates unknown", () => {
  const stats = [
    outbound(1000, { transportId: "video-transport" }),
    {
      id: "audio-transport",
      type: "transport",
      selectedCandidatePairId: "audio-pair",
    },
    {
      id: "video-transport",
      type: "transport",
      selectedCandidatePairId: "video-pair",
    },
    { id: "audio-pair", type: "candidate-pair", availableOutgoingBitrate: 1 },
    {
      id: "video-pair",
      type: "candidate-pair",
      availableOutgoingBitrate: 9000000,
    },
  ];
  assert.equal(
    summarizeSenderDiagnostics(stats, new Map()).availableOutgoingBitrate,
    9000000,
  );
  assert.equal(
    summarizeSenderDiagnostics(stats.slice(1), new Map())
      .availableOutgoingBitrate,
    null,
  );
});
test("cleanup prevents an in-flight sample from logging or rescheduling", async () => {
  let resolve;
  let calls = 0;
  let logs = 0;
  let observations = 0;
  const sender = {
    getStats: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
    getParameters: () => ({ encodings: [] }),
  };
  const stop = startSenderDiagnostics(
    () => sender,
    () => logs++,
    1,
    () => observations++,
  );
  stop();
  resolve(new Map());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(logs, 0);
  assert.equal(calls, 1);
  assert.equal(observations, 0);
});
test("a sender replaced while getStats is pending cannot emit stale results", async () => {
  let resolve;
  let logs = 0;
  const oldSender = {
    getStats: () =>
      new Promise((r) => {
        resolve = r;
      }),
  };
  let current = oldSender;
  const stop = startSenderDiagnostics(
    () => current,
    () => logs++,
    1000,
  );
  current = { getStats: async () => new Map() };
  resolve(new Map());
  await new Promise((r) => setTimeout(r, 10));
  stop();
  assert.equal(logs, 0);
});
test("an idle sender reports zero FPS rather than an unknown rate", () => {
  const before = outbound(1000, { framesEncoded: 300, framesSent: 300 });
  const current = outbound(11000, { framesEncoded: 300, framesSent: 300 });
  const result = summarizeSenderDiagnostics(
    [current],
    new Map([[before.id, before]]),
  );
  assert.equal(result.streams[0].encodedFps, 0);
  assert.equal(result.streams[0].sentFps, 0);
  assert.equal(result.streams[0].meanEncodeMs, null);
});

test("optional quality, adaptation and packet metrics use interval deltas", () => {
  const before = outbound(1000, {
    framesEncoded: 30,
    packetsSent: 100,
    retransmittedBytesSent: 500,
    totalPacketSendDelay: 0.1,
    qpSum: 600,
    qualityLimitationResolutionChanges: 4,
    nackCount: 10,
    pliCount: 1,
    firCount: 0,
    remoteId: "receiver",
  });
  const current = outbound(11000, {
    framesEncoded: 330,
    packetsSent: 1100,
    retransmittedBytesSent: 50500,
    totalPacketSendDelay: 2.1,
    qpSum: 9600,
    qualityLimitationResolutionChanges: 6,
    nackCount: 13,
    pliCount: 2,
    firCount: 0,
    remoteId: "receiver",
    targetBitrate: 4_500_000,
  });
  const receiver = (timestamp, packetsLost) => ({
    id: "receiver",
    type: "remote-inbound-rtp",
    timestamp,
    ssrc: 9,
    packetsLost,
    fractionLost: 0.01,
    roundTripTime: 0.05,
  });
  const stream = summarizeSenderDiagnostics(
    [current, receiver(11000, 12)],
    new Map([
      [before.id, before],
      ["receiver", receiver(1000, 10)],
    ]),
  ).streams[0];
  assert.equal(stream.targetBitrateBps, 4_500_000);
  assert.equal(stream.retransmissionBitrateBps, 40000);
  assert.equal(stream.meanPacketSendDelayMs, 2);
  assert.equal(stream.meanQp, 30);
  assert.equal(stream.resolutionChanges, 2);
  assert.deepEqual(stream.feedback, { nack: 3, pli: 1, fir: 0 });
  assert.deepEqual(stream.receiverReport, {
    intervalSeconds: 10,
    packetsLostDelta: 2,
    reportedFractionLost: 0.01,
    roundTripTimeMs: 50,
  });
  const absent = summarizeSenderDiagnostics(
    [outbound(11000)],
    new Map([[before.id, before]]),
  ).streams[0];
  for (const key of [
    "targetBitrateBps",
    "meanQp",
    "resolutionChanges",
    "meanPacketSendDelayMs",
    "retransmissionBitrateBps",
    "receiverReport",
  ])
    assert.equal(absent[key], null);
});

test("SSRC, codec, source and transport replacement reset reused RTP IDs", () => {
  const before = outbound(1000, {
    ssrc: 1,
    codecId: "h264",
    mediaSourceId: "source",
    transportId: "transport",
    qpSum: 100,
  });
  for (const changed of [
    { ssrc: 2 },
    { codecId: "vp9" },
    { mediaSourceId: "other" },
    { transportId: "other" },
  ]) {
    const current = {
      ...before,
      timestamp: 11000,
      framesEncoded: 300,
      qpSum: 10000,
      ...changed,
    };
    const stream = summarizeSenderDiagnostics(
      [current],
      new Map([[before.id, before]]),
    ).streams[0];
    assert.equal(stream.intervalSeconds, null);
    assert.equal(stream.encodedFps, null);
    assert.equal(stream.meanQp, null);
  }
});

test("receiver loss correction may be negative but a replaced/stale report has no delta", () => {
  const before = outbound(1000, { remoteId: "receiver" });
  const current = outbound(11000, { remoteId: "receiver" });
  const oldRemote = {
    id: "receiver",
    type: "remote-inbound-rtp",
    timestamp: 1000,
    ssrc: 1,
    packetsLost: 10,
  };
  const previous = new Map([
    [before.id, before],
    [oldRemote.id, oldRemote],
  ]);
  const read = (changes) =>
    summarizeSenderDiagnostics(
      [current, { ...oldRemote, timestamp: 11000, packetsLost: 8, ...changes }],
      previous,
    ).streams[0].receiverReport;
  assert.equal(read({}).packetsLostDelta, -2);
  assert.equal(read({ ssrc: 2 }).packetsLostDelta, null);
  assert.equal(read({ timestamp: 1000 }).packetsLostDelta, null);
  assert.equal(read({ type: "codec" }), null);
});

test("poll logs the effective degradation policy and content hint", async () => {
  let captured;
  let stop;
  const sender = {
    track: {
      contentHint: "motion",
      getSettings: () => ({ width: 1280, height: 720, frameRate: 60 }),
    },
    getStats: async () => new Map(),
    getParameters: () => ({
      degradationPreference: "maintain-framerate",
      encodings: [{ maxBitrate: 8_000_000 }],
    }),
  };
  await new Promise((resolve) => {
    stop = startSenderDiagnostics(
      () => sender,
      (summary) => {
        captured = summary;
        resolve();
      },
      10000,
    );
  });
  stop();
  assert.equal(captured.degradationPreference, "maintain-framerate");
  assert.equal(captured.capture.contentHint, "motion");
  assert.equal(captured.limits[0].maxBitrate, 8_000_000);
});

test("sampled dimension changes remain visible when the browser adaptation counter stays zero", () => {
  const before = outbound(1000, {
    frameWidth: 1280,
    frameHeight: 720,
    qualityLimitationResolutionChanges: 0,
  });
  const current = outbound(2000, {
    framesSent: 60,
    frameWidth: 960,
    frameHeight: 540,
    qualityLimitationResolutionChanges: 0,
  });
  const stream = summarizeSenderDiagnostics(
    [current],
    new Map([[before.id, before]]),
  ).streams[0];
  assert.equal(stream.resolutionChanges, 0);
  assert.equal(stream.observedResolutionChanges, 1);
  assert.deepEqual(stream.resolutionTransition, {
    changes: 1,
    timestampMs: 2000,
    from: [1280, 720],
    to: [960, 540],
  });
  const same = { ...current, timestamp: 3000 };
  const unchanged = summarizeSenderDiagnostics(
    [same],
    new Map([[current.id, current]]),
  ).streams[0];
  assert.equal(unchanged.observedResolutionChanges, 0);
  assert.equal(unchanged.resolutionTransition, null);
});

test("resolution observations never bridge missing dimensions, resets or replaced streams", () => {
  const before = outbound(1000, {
    frameWidth: 1280,
    frameHeight: 720,
    framesSent: 100,
    ssrc: 1,
  });
  const current = {
    ...before,
    timestamp: 2000,
    frameWidth: 960,
    frameHeight: 540,
    framesSent: 160,
  };
  const read = (now, old = before) =>
    summarizeSenderDiagnostics([now], new Map([[old.id, old]])).streams[0];
  for (const changes of [
    { frameWidth: undefined },
    { frameHeight: 0 },
    { frameWidth: Infinity },
    { frameHeight: -1 },
    { frameWidth: 960.5 },
    { ssrc: 2 },
    { codecId: "new" },
    { framesSent: 5 },
    { timestamp: 1000 },
    { timestamp: 500 },
  ]) {
    assert.equal(
      read({ ...current, ...changes }).observedResolutionChanges,
      null,
    );
    assert.equal(read({ ...current, ...changes }).resolutionTransition, null);
  }
  assert.equal(
    read(current, { ...before, frameHeight: undefined })
      .observedResolutionChanges,
    null,
  );
  assert.equal(
    summarizeSenderDiagnostics([current], new Map()).streams[0]
      .observedResolutionChanges,
    null,
  );
});
