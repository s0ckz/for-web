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
