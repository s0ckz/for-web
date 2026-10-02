import assert from "node:assert/strict";
import test from "node:test";
import {
  StatsCounters,
  VideoPresentation,
  selectedCandidatePair,
} from "./screenShareTelemetry.ts";

test("counter rates ignore reported FPS, preserve zero, and reset by owner/id/field", () => {
  const counters = new StatsCounters();
  const owner = {};
  const stat = (timestamp, fields = {}) => ({
    id: "video",
    timestamp,
    framesDecoded: 100,
    framesPerSecond: 30,
    ...fields,
  });
  assert.equal(
    counters.read([stat(1000)], owner).rate(stat(1000), "framesDecoded"),
    undefined,
  );
  const next = stat(2000, { framesDecoded: 115 });
  assert.equal(counters.read([next], owner).rate(next, "framesDecoded"), 15);
  const stall = stat(3000, { framesDecoded: 115, framesPerSecond: 30 });
  assert.equal(counters.read([stall], owner).rate(stall, "framesDecoded"), 0);
  const reset = stat(4000, { framesDecoded: 5 });
  assert.equal(
    counters.read([reset], owner).rate(reset, "framesDecoded"),
    undefined,
  );
  const resumed = stat(5000, { framesDecoded: 20 });
  assert.equal(
    counters.read([resumed], owner).rate(resumed, "framesDecoded"),
    15,
  );
  assert.equal(
    counters.read([stat(6000)], {}).rate(stat(6000), "framesDecoded"),
    undefined,
  );
  const changed = { ...stat(7000), id: "new-stream" };
  assert.equal(
    counters.read([changed], owner).rate(changed, "framesDecoded"),
    undefined,
  );
});

test("missing counters, equal/backward timestamps and late optional counters stay unknown", () => {
  const counters = new StatsCounters();
  const stat = { id: "source", timestamp: 1000 };
  counters.read([stat], "owner");
  let next = { ...stat, timestamp: 2000, frames: 80 };
  assert.equal(counters.read([next], "owner").rate(next, "frames"), undefined);
  assert.equal(counters.read([next], "owner").rate(next, "frames"), undefined);
  next = { ...next, timestamp: 1500, frames: 90 };
  assert.equal(counters.read([next], "owner").rate(next, "frames"), undefined);
  counters.reset();
  assert.equal(counters.read([next], "owner").rate(next, "frames"), undefined);
});

test("SSRC or codec replacement resets a reused stats ID", () => {
  const counters = new StatsCounters();
  const first = {
    id: "video",
    timestamp: 1000,
    framesDecoded: 100,
    ssrc: 1,
    codecId: "h264",
  };
  counters.read([first], "owner");
  let next = { ...first, timestamp: 2000, framesDecoded: 150, ssrc: 2 };
  assert.equal(
    counters.read([next], "owner").rate(next, "framesDecoded"),
    undefined,
  );
  next = { ...next, timestamp: 3000, framesDecoded: 180 };
  assert.equal(counters.read([next], "owner").rate(next, "framesDecoded"), 30);
  next = { ...next, timestamp: 4000, framesDecoded: 220, codecId: "vp9" };
  assert.equal(
    counters.read([next], "owner").rate(next, "framesDecoded"),
    undefined,
  );
});

test("presentation uses compositor counter jumps and reports a real stall; rebinding cancels callbacks", () => {
  let now = 0;
  let callback;
  let cancelled = 0;
  const video = {
    requestVideoFrameCallback(fn) {
      callback = fn;
      return 1;
    },
    cancelVideoFrameCallback() {
      cancelled++;
    },
  };
  const presentation = new VideoPresentation(() => now);
  const track = {};
  presentation.bind(video, track);
  assert.equal(presentation.sample().fps, undefined);
  callback(0, { presentedFrames: 100 });
  assert.equal(presentation.sample().fps, undefined);
  now = 1000;
  callback(0, { presentedFrames: 112 }); // one callback includes twelve presentations
  assert.equal(presentation.sample().fps, 12);
  now = 2000;
  assert.deepEqual(presentation.sample(), { fps: 0, sinceLastFrameMs: 1000 });
  const stale = callback;
  presentation.bind(video, {});
  stale(0, { presentedFrames: 999 });
  assert.equal(presentation.sample().fps, undefined);
  presentation.reset();
  assert.equal(cancelled, 2);
  assert.equal(presentation.sample().fps, undefined);
});

test("selected transport takes precedence over multiple nominated pairs", () => {
  const active = {
    id: "active",
    type: "candidate-pair",
    nominated: true,
    state: "succeeded",
  };
  const old = { ...active, id: "old" };
  const report = new Map([
    ["transport", { selectedCandidatePairId: "active" }],
    ["active", active],
    ["old", old],
  ]);
  assert.equal(
    selectedCandidatePair(report, { transportId: "transport" }),
    active,
  );
  assert.equal(selectedCandidatePair(report, {}), undefined);
});
