import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CODEC_CONTENT_TYPES,
  CODEC_SOFTWARE_COOLDOWN_MS,
  H265_RECEIVE_ATTRIBUTE,
  ScreenShareCodecSelector,
  codecProfile,
  matchesPrimarySoftware,
  startScreenShareEncoderMonitor,
  supportsH265Receive,
  viewersAllowH265,
} from "./screenShareCodecs.ts";

const request = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  bitrate: 6_000_000,
};
const hint = (contentType, hardware = true) => ({
  contentType,
  supported: true,
  powerEfficient: hardware,
});
const makeSelector = (overrides = {}) =>
  new ScreenShareCodecSelector({
    negotiable: () => ["video/H264", "video/H265", "video/VP9"],
    probe: async (contentType) => hint(contentType),
    timeoutMs: 20,
    ...overrides,
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("default H.264 preference ignores Main/High-only hardware hints", async () => {
  const normal = await makeSelector().select(request, () => true);
  assert.equal(normal.codec, "h264");
  const mainOnly = await makeSelector({
    probe: async (type) =>
      hint(
        type,
        type !== CODEC_CONTENT_TYPES[1] && type !== CODEC_CONTENT_TYPES[0],
      ),
  }).select(request, () => true);
  assert.equal(mainOnly.codec, "vp9");
});

test("software evidence uses a bounded per-codec cooldown and re-probes after expiry", async () => {
  let now = 100;
  let probes = 0;
  const selector = makeSelector({
    now: () => now,
    probe: async (type) => {
      probes++;
      return hint(type);
    },
  });
  const first = await selector.select(request);
  assert.equal(
    selector.recordSoftware(first),
    now + CODEC_SOFTWARE_COOLDOWN_MS,
  );
  const recovery = await selector.select(request);
  assert.equal(recovery.codec, "vp9");
  assert.equal(recovery.cbpHardware, false);
  assert.equal(probes, 4);
  now += CODEC_SOFTWARE_COOLDOWN_MS;
  assert.equal((await selector.select(request)).codec, "h264");
  assert.equal(probes, 8);
});

test("H.265 recovery needs affirmative current-viewer receive support", async () => {
  const selector = makeSelector();
  selector.recordSoftware(await selector.select(request));
  assert.equal((await selector.select(request, () => false)).codec, "vp9");
  const hevc = await selector.select(request, () => true);
  assert.equal(hevc.codec, "h265");
  selector.recordSoftware(hevc);
  assert.equal((await selector.select(request, () => true)).codec, "vp9");
  assert.equal(viewersAllowH265([]), false);
  assert.equal(viewersAllowH265([{}]), false);
  assert.equal(
    viewersAllowH265([{ [H265_RECEIVE_ATTRIBUTE]: "1" }, {}]),
    false,
  );
  assert.equal(viewersAllowH265([{ [H265_RECEIVE_ATTRIBUTE]: "0" }]), false);
  assert.equal(viewersAllowH265([{ [H265_RECEIVE_ATTRIBUTE]: "1" }]), true);
});

test("HEVC receive advertisement requires the Main profile and single-stream RTP", () => {
  assert.equal(supportsH265Receive(undefined), false);
  assert.equal(supportsH265Receive([{ mimeType: "video/H264" }]), false);
  assert.equal(supportsH265Receive([{ mimeType: "video/H265" }]), true);
  for (const sdpFmtpLine of [
    "profile-id=2",
    "profile-id",
    "profile-id=",
    "profile-space=1",
    "tx-mode=MRST",
  ]) {
    assert.equal(
      supportsH265Receive([{ mimeType: "video/H265", sdpFmtpLine }]),
      false,
      sdpFmtpLine,
    );
  }
  assert.equal(
    supportsH265Receive([
      { mimeType: "video/h265", sdpFmtpLine: "profile-id=1;tx-mode=SRST" },
    ]),
    true,
  );
});

test("backup encodes, changed presets and idle/unknown samples cannot record primary failure", async () => {
  const decision = await makeSelector().select(request);
  const active = { codec: "video/h264", advancing: true, software: true };
  assert.equal(matchesPrimarySoftware(decision, decision.key, active), true);
  for (const patch of [
    { codec: "video/vp8" },
    { codec: null },
    { advancing: false },
    { software: false },
  ]) {
    assert.equal(
      matchesPrimarySoftware(decision, decision.key, { ...active, ...patch }),
      false,
    );
  }
  assert.equal(matchesPrimarySoftware(decision, "1280x720@60", active), false);
  assert.equal(matchesPrimarySoftware(decision, undefined, active), false);
});

test("one preset's software fallback does not poison another preset", async () => {
  const selector = makeSelector();
  selector.recordSoftware(await selector.select(request));
  const other = await selector.select({ ...request, width: 1280, height: 720 });
  assert.equal(other.codec, "h264");
  assert.equal(other.retryAt, null);
});

test("a late observation cannot overwrite a newer probe generation", async () => {
  let now = 0;
  const selector = makeSelector({ now: () => now });
  const old = await selector.select(request);
  now = 300_001;
  const current = await selector.select(request);
  assert.notEqual(current.revision, old.revision);
  assert.equal(selector.recordSoftware(old), undefined);
  assert.equal((await selector.select(request)).codec, "h264");
});

test("concurrent publishers receive their own decisions despite different viewer gates", async () => {
  const probe = deferred();
  const selector = makeSelector({
    probe: async (type) => {
      await probe.promise;
      return hint(type, type !== CODEC_CONTENT_TYPES[1]);
    },
  });
  const compatible = selector.select(request, () => true);
  const unknown = selector.select(request, () => false);
  probe.resolve();
  assert.equal((await compatible).codec, "h265");
  assert.equal((await unknown).codec, "vp9");
});

test("the viewer gate is evaluated after the asynchronous probe, not before it", async () => {
  const probe = deferred();
  let viewers = [{ [H265_RECEIVE_ATTRIBUTE]: "1" }];
  const selector = makeSelector({
    probe: async (type) => {
      await probe.promise;
      return hint(type, type !== CODEC_CONTENT_TYPES[1]);
    },
  });
  const decision = selector.select(request, () => viewersAllowH265(viewers));
  viewers = [{}];
  probe.resolve();
  assert.equal((await decision).codec, "vp9");
});

test("a rejected H.265 probe does not discard a successful H.264 candidate", async () => {
  let calls = 0;
  const selector = makeSelector({
    probe: async (type) => {
      calls++;
      if (type === CODEC_CONTENT_TYPES[0]) throw Error("unsupported API");
      return hint(type);
    },
  });
  assert.equal((await selector.select(request)).codec, "h264");
  assert.equal((await selector.select(request)).codec, "h264");
  assert.equal(calls, 8); // rejected capability evidence is retried on the next start
});

test("timeout keeps a safe snapshot; a late successful probe benefits the next share", async () => {
  const probe = deferred();
  const selector = makeSelector({
    timeoutMs: 2,
    probe: async (type) => {
      await probe.promise;
      return hint(type);
    },
  });
  const timedOut = await selector.select(request);
  assert.equal(timedOut.codec, "vp9");
  probe.resolve();
  await sleep(0);
  assert.equal(timedOut.codec, "vp9");
  assert.equal((await selector.select(request)).codec, "h264");
});

test("hung and superseded probes cannot pin the cache or overwrite a newer result", async () => {
  let now = 0;
  let calls = 0;
  const old = deferred();
  const selector = makeSelector({
    now: () => now,
    timeoutMs: 2,
    probe: async (type) => {
      if (++calls <= 4) {
        await old.promise;
        return hint(type);
      }
      return hint(type, false);
    },
  });
  assert.equal((await selector.select(request)).codec, "vp9");
  now = 10;
  assert.equal((await selector.select(request)).codec, "vp9");
  old.resolve();
  await sleep(0);
  assert.equal((await selector.select(request)).codec, "vp9");
  assert.equal(calls, 8);
});

test("codec profile diagnostics discard arbitrary SDP and malformed values", () => {
  assert.deepEqual(
    codecProfile(
      "profile-level-id=42e01f;packetization-mode=1;private-address=192.0.2.1;profile-id=1;tx-mode=SRST;level-id=<script>",
    ),
    {
      "profile-level-id": "42e01f",
      "packetization-mode": "1",
      "profile-id": "1",
      "tx-mode": "SRST",
    },
  );
});

const report = (frames, extras = {}) =>
  new Map([
    [
      "video",
      {
        id: "video",
        type: "outbound-rtp",
        kind: "video",
        codecId: "codec",
        framesEncoded: frames,
        ...extras,
      },
    ],
    [
      "codec",
      {
        id: "codec",
        type: "codec",
        mimeType: "video/H264",
        sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1",
      },
    ],
  ]);

test("unknown identity is retried; software is accompanied by real advancing frames", async () => {
  const observations = [];
  const ready = deferred();
  let sample = 0;
  const sender = {
    getStats: async () =>
      report(
        ++sample * 30,
        sample < 2
          ? {}
          : { encoderImplementation: "OpenH264", powerEfficientEncoder: false },
      ),
  };
  const stop = startScreenShareEncoderMonitor({
    getSender: () => sender,
    isCurrent: () => true,
    intervalMs: 2,
    observe: (value) => {
      observations.push(value);
      if (observations.length === 2) ready.resolve();
    },
  });
  try {
    await ready.promise;
    assert.equal(observations[0].software, false);
    assert.equal(observations[0].advancing, false);
    assert.equal(observations[1].software, true);
    assert.equal(observations[1].advancing, true);
    assert.equal(observations[1].codec, "video/h264");
    assert.equal(observations[1].profile["profile-level-id"], "42e01f");
  } finally {
    stop();
  }
});

test("stopped or superseded publications discard an in-flight stats result", async () => {
  for (const mode of ["stopped", "superseded", "sender-replaced"]) {
    const pending = deferred();
    let current = true;
    let sender = { getStats: () => pending.promise };
    const observations = [];
    const stop = startScreenShareEncoderMonitor({
      getSender: () => sender,
      isCurrent: () => current,
      intervalMs: 100,
      observe: (value) => observations.push(value),
    });
    if (mode === "stopped") stop();
    if (mode === "superseded") current = false;
    if (mode === "sender-replaced") sender = undefined;
    pending.resolve(report(30, { encoderImplementation: "OpenH264" }));
    await sleep(0);
    stop();
    assert.equal(observations.length, 0, mode);
  }
});

test("counter resets and inactive streams are not advancing software evidence", async () => {
  const observations = [];
  const ready = deferred();
  const counts = [100, 100, 0];
  const sender = {
    getStats: async () =>
      report(counts.shift(), { encoderImplementation: "OpenH264" }),
  };
  const stop = startScreenShareEncoderMonitor({
    getSender: () => sender,
    isCurrent: () => true,
    intervalMs: 2,
    observe: (value) => {
      observations.push(value);
      if (observations.length === 3) ready.resolve();
    },
  });
  try {
    await ready.promise;
    assert.deepEqual(
      observations.map((value) => value.advancing),
      [false, false, false],
    );
  } finally {
    stop();
  }
});

test("a changed negotiated codec must establish its own advancing-frame baseline", async () => {
  const observations = [];
  const ready = deferred();
  let count = 0;
  const sender = {
    getStats: async () => {
      const stats = report(++count * 30, { encoderImplementation: "OpenH264" });
      if (count > 1) {
        stats.get("video").codecId = "replacement";
        stats.set("replacement", {
          id: "replacement",
          type: "codec",
          mimeType: "video/H264",
        });
      }
      return stats;
    },
  };
  const stop = startScreenShareEncoderMonitor({
    getSender: () => sender,
    isCurrent: () => true,
    intervalMs: 2,
    observe: (value) => {
      observations.push(value);
      if (observations.length === 3) ready.resolve();
    },
  });
  try {
    await ready.promise;
    assert.deepEqual(
      observations.map((value) => value.advancing),
      [false, false, true],
    );
  } finally {
    stop();
  }
});
