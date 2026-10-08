import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import vm from "node:vm";
import {
  CODEC_CONTENT_TYPES,
  H265_RECEIVE_ATTRIBUTE,
  ScreenShareCodecSelector,
  h265ViewerSupport,
  supportsH265Receive,
} from "./screenShareCodecs.ts";
import {
  screenShareExperiment,
  screenShareExperimentsEnabled,
} from "./screenShareExperiments.ts";

const request = { width: 1280, height: 720, frameRate: 60, bitrate: 6_000_000 };
const selector = (options = {}) =>
  new ScreenShareCodecSelector({
    negotiable: () => ["video/H264", "video/H265"],
    probe: async (contentType) => ({
      contentType,
      supported: true,
      powerEfficient: true,
    }),
    ...options,
  });

test("production hosts and unflagged preview builds cannot enable test controls", () => {
  for (const host of [
    "stoat.lrl.com.br",
    "127.0.0.1.evil.example",
    "192.168.1.2",
    "",
  ]) {
    assert.equal(screenShareExperimentsEnabled(true, "true", host), false);
  }
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(screenShareExperimentsEnabled(false, undefined, host), false);
    assert.equal(screenShareExperimentsEnabled(false, "false", host), false);
    assert.equal(screenShareExperimentsEnabled(false, "true", host), true);
    assert.equal(screenShareExperimentsEnabled(true, undefined, host), true);
  }
  assert.equal(screenShareExperiment(false, "h265", 8_000_000), undefined);
});

test("only reviewed ceilings are accepted and defaults create no override", () => {
  assert.equal(screenShareExperiment(true, "auto", undefined), undefined);
  for (const bits of [-1, NaN, Infinity, "8000000", 40_000_000]) {
    assert.equal(screenShareExperiment(true, "auto", bits), undefined);
  }
  const experiment = screenShareExperiment(true, "h265", 4_500_000);
  assert.deepEqual(experiment, { codec: "h265", maxBitrate: 4_500_000 });
  assert.equal(Object.isFrozen(experiment), true);
});

test("HEVC preference requires hardware eligibility and current compatible viewers", async () => {
  assert.equal(
    (await selector().select(request, () => true, "h265")).codec,
    "h265",
  );
  const held = await selector().select(request, () => false, "h265");
  assert.equal(held.codec, "h264");
  assert.match(held.reason, /unavailable; automatic fallback/);
  const software = selector({
    probe: async (contentType) => ({
      contentType,
      supported: true,
      powerEfficient: contentType !== CODEC_CONTENT_TYPES[0],
    }),
  });
  assert.equal(
    (await software.select(request, () => true, "h265")).codec,
    "h264",
  );
  const unavailable = selector({ negotiable: () => [] });
  assert.equal(
    (await unavailable.select(request, () => true, "h265")).codec,
    "vp9",
  );
});

test("viewer eligibility is rechecked after an asynchronous preferred-codec probe", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  let compatible = true;
  const choice = selector({
    probe: async (contentType) => {
      await pending;
      return { contentType, supported: true, powerEfficient: true };
    },
  }).select(request, () => compatible, "h265");
  compatible = false;
  finish();
  assert.equal((await choice).codec, "h264");
});

test("different ceilings have separate capability evidence and share software cooldown", async () => {
  let now = 0;
  const calls = [];
  const codecs = selector({
    now: () => now,
    probe: async (contentType, config) => {
      calls.push(config.bitrate);
      return { contentType, supported: true, powerEfficient: true };
    },
  });
  const first = await codecs.select(request, () => true, "h265");
  const higher = { ...request, bitrate: 8_000_000 };
  await codecs.select(higher, () => true, "h265");
  assert.equal(calls.length, 8);
  assert.notEqual(codecs.recordSoftware(first), undefined);
  assert.equal((await codecs.select(higher, () => true, "h265")).codec, "h264");
  assert.equal(
    (await codecs.select(request, () => true, "h265")).codec,
    "h264",
  );
  now = 120_001;
  assert.equal(
    (await codecs.select(request, () => true, "h265")).codec,
    "h265",
  );
  assert.equal((await codecs.select(higher, () => true, "h265")).codec, "h265");
  assert.equal(calls.length, 16); // both bitrate-specific hints are refreshed
});

// Execute production option/limit methods rather than reproduce their policy.
function voiceHarness(
  timers = { setTimeout, clearTimeout },
  codecOptions = {},
) {
  const ts = createRequire(import.meta.url)("typescript");
  const source = readFileSync(
    new URL("./state.tsx", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const ast = ts.createSourceFile(
    "state.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const functions = [
    "screenShareEncoding",
    "screenShareScaleFactor",
    "screenShareCodec",
    "screenSharePublishOptions",
  ];
  const helpers = ast.statements
    .filter(
      (node) =>
        ts.isFunctionDeclaration(node) && functions.includes(node.name?.text),
    )
    .map((node) => node.getText(ast))
    .join("\n");
  const method = (start, end = "\n  /**") => {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin);
    return source.slice(begin, finish);
  };
  const codecs = selector(codecOptions);
  const logs = [];
  const context = vm.createContext({
    console: { info: (value) => logs.push(value), warn() {} },
    ...timers,
    screenShareCodecSelector: codecs,
    h265ViewerSupport,
    supportsH265Receive,
    H265_RECEIVE_ATTRIBUTE,
    RTCRtpReceiver: {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/H265" }] }),
    },
    AudioPresets: { musicStereo: {} },
    BackupCodecPolicy: { REGRESSION: "regression" },
    isNativeDesktop: () => true,
  });
  const fixture = `let lastScreenShareCodecDecision;
    ${helpers}
    class Harness {
      #codecDecisionsByTrack = new WeakMap();
      #lastShareChoice;
      #diagnosticPublication;
      #stopSenderDiagnostics;
      #nativeEncoderLimitsRecheckTimer;
      #applyShareCaptureChoice = async () => {};
      #startScreenShareDiagnostics = () => {};
      sound = {playSound() {}};
      room() { return this.activeRoom; }
      getEnabledScreenShareQualities() {return {low: {resolution: {width:1280,height:720,frameRate:30}},low60: {resolution: {width:1280,height:720,frameRate:60}}};}
      bind(pub, decision) {this.#codecDecisionsByTrack.set(pub.videoTrack.mediaStreamTrack, decision);}
      get choice() {return this.#lastShareChoice;}
      apply(pub, name) {return this.#applyShareChoice(this.activeRoom,pub,name,true,false);}
      clear() {this.#clearNativeEncoderLimitsRecheck();}
      announce(room) {return this.#publishScreenShareCodecSupport(room);}
      ${method("  async #publishScreenShareCodecSupport(")}
      ${method("  async #applyEncoderLimits(")}
      ${method("  #scheduleNativeEncoderLimitsRecheck(")}
      ${method("  #clearNativeEncoderLimitsRecheck()")}
      ${method("  async #setScreenShareEncoderParams(", "\n  async #applyShareCaptureChoice(")}
      ${method("  async #applyShareChoice(")}
    }
    globalThis.Harness = Harness;
    globalThis.publishOptions = screenSharePublishOptions;`;
  vm.runInContext(
    ts.transpileModule(fixture, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return { context, codecs, logs };
}

test("actual publish decision logs the audience used after the probe without identities", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { context, logs } = voiceHarness(undefined, {
    probe: async (contentType) => {
      await pending;
      return { contentType, supported: true, powerEfficient: true };
    },
  });
  const room = {
    remoteParticipants: new Map([
      ["private-viewer-id", { attributes: { [H265_RECEIVE_ATTRIBUTE]: "1" } }],
    ]),
  };
  const publication = context.publishOptions(request, room, { codec: "h265" });
  room.remoteParticipants.set("private-newcomer-id", { attributes: {} });
  room.remoteParticipants.set("private-unsupported-id", {
    attributes: { [H265_RECEIVE_ATTRIBUTE]: "0" },
  });
  finish();
  const result = await publication;
  assert.equal(result.publishOptions.videoCodec, "h264");
  assert.equal(result.codecDecision.h265Allowed, false);
  assert.deepEqual(result.codecDecision.viewerSupport, {
    total: 3,
    supported: 1,
    unsupported: 1,
    unknown: 1,
    allowed: false,
  });
  const logged = JSON.parse(logs[0].slice(logs[0].indexOf("{")));
  assert.deepEqual(logged.viewerSupport, result.codecDecision.viewerSupport);
  assert.equal(logs.join().includes("private-"), false);
});

test("actual receive announcement distinguishes decoder support and rejected updates", async () => {
  const { context, logs } = voiceHarness();
  const voice = new context.Harness();
  const updates = [];
  const room = {
    localParticipant: { setAttributes: async (value) => updates.push(value) },
  };
  voice.activeRoom = room;
  await voice.announce(room);
  assert.equal(updates[0][H265_RECEIVE_ATTRIBUTE], "1");
  assert.match(logs[0], /"supported":true,"advertised":true/);
  context.RTCRtpReceiver.getCapabilities = () => ({
    codecs: [{ mimeType: "video/H264" }],
  });
  await voice.announce(room);
  assert.equal(updates[1][H265_RECEIVE_ATTRIBUTE], "0");
  assert.match(logs[1], /"supported":false,"advertised":true/);
  room.localParticipant.setAttributes = async () => {
    throw new Error("private-error");
  };
  await voice.announce(room);
  assert.match(logs[2], /"supported":false,"advertised":false/);
  context.RTCRtpReceiver.getCapabilities = () => {
    throw new Error("private-probe-error");
  };
  await voice.announce(room);
  assert.match(logs[3], /"supported":null,"advertised":false/);
  assert.equal(logs.join().includes("private-"), false);
});

test("a receive announcement finishing after leaving does not log current-room success or failure", async () => {
  for (const rejected of [false, true]) {
    const { context, logs } = voiceHarness();
    const voice = new context.Harness();
    let finish;
    const update = new Promise((resolve, reject) => {
      finish = rejected ? reject : resolve;
    });
    const room = { localParticipant: { setAttributes: () => update } };
    voice.activeRoom = room;
    const announcement = voice.announce(room);
    voice.activeRoom = undefined;
    finish();
    await announcement;
    assert.deepEqual(logs, []);
  }
});

test("actual publish options preserve defaults and pair test preference with its ceiling", async () => {
  const { context } = voiceHarness();
  const room = {
    remoteParticipants: new Map([
      ["viewer", { attributes: { [H265_RECEIVE_ATTRIBUTE]: "1" } }],
    ]),
  };
  const normal = await context.publishOptions(request, room);
  assert.equal(normal.publishOptions.videoCodec, "h264");
  assert.equal(normal.publishOptions.screenShareEncoding.maxBitrate, 6_000_000);
  assert.equal(
    normal.publishOptions.degradationPreference,
    "maintain-resolution",
  );
  assert.equal(normal.codecDecision.experiment, undefined);
  const experiment = screenShareExperiment(true, "h265", 8_000_000);
  const preferred = await context.publishOptions(request, room, experiment);
  assert.equal(preferred.codecDecision.experiment, experiment);
  assert.equal(preferred.publishOptions.videoCodec, "h265");
  assert.equal(
    preferred.publishOptions.screenShareEncoding.maxBitrate,
    8_000_000,
  );
  assert.equal(preferred.publishOptions.backupCodecPolicy, "regression");
  assert.equal(preferred.publishOptions.simulcast, false);
  assert.equal(
    preferred.publishOptions.degradationPreference,
    "maintain-resolution",
  );
});

test("every screen share preset preserves resolution with H.264, H.265 and VP9 fallback", async () => {
  const room = {
    remoteParticipants: new Map([
      ["viewer", { attributes: { [H265_RECEIVE_ATTRIBUTE]: "1" } }],
    ]),
  };
  for (const codec of ["h264", "h265", "vp9"]) {
    const { context } = voiceHarness(
      undefined,
      codec === "vp9" ? { negotiable: () => [] } : {},
    );
    for (const height of [720, 1080]) {
      for (const frameRate of [30, 60]) {
        const resolution = {
          width: height === 720 ? 1280 : 1920,
          height,
          frameRate,
        };
        const result = await context.publishOptions(
          resolution,
          room,
          codec === "vp9" ? undefined : { codec },
        );
        assert.equal(result.publishOptions.videoCodec, codec);
        assert.equal(
          result.publishOptions.degradationPreference,
          "maintain-resolution",
        );
        assert.equal(result.publishOptions.simulcast, false);
        assert.equal(
          result.publishOptions.screenShareEncoding.maxFramerate,
          frameRate + 5,
        );
      }
    }
  }
});

test("a republished sender restores resolution preference even when every encoding limit already matches", async () => {
  const { context } = voiceHarness();
  const voice = new context.Harness();
  voice.activeRoom = { remoteParticipants: new Map(), localParticipant: {} };
  let writes = 0;
  let parameters = {
    degradationPreference: "maintain-framerate",
    encodings: [
      {
        maxBitrate: 6_000_000,
        maxFramerate: 65,
        scaleResolutionDownBy: 1,
        active: true,
      },
    ],
  };
  const pub = {
    videoTrack: {
      mediaStreamTrack: { getSettings: () => ({ width: 1280, height: 720 }) },
      sender: {
        getParameters: () => structuredClone(parameters),
        setParameters: async (value) => {
          writes++;
          parameters = value;
        },
      },
    },
  };
  await voice.apply(pub, "low60");
  assert.equal(writes, 1);
  assert.equal(parameters.degradationPreference, "maintain-resolution");
  assert.deepEqual(parameters.encodings, [
    {
      maxBitrate: 6_000_000,
      maxFramerate: 65,
      scaleResolutionDownBy: 1,
      active: true,
    },
  ]);
  await voice.apply(pub, "low60");
  assert.equal(writes, 1, "Do not repeatedly write unchanged parameters");
  voice.clear();
});

test("quality changes and recovered publications retain the owning experiment instead of defaults", async () => {
  const { context } = voiceHarness();
  const room = {
    remoteParticipants: new Map(),
    localParticipant: { getTrackPublication: () => undefined },
  };
  const experiment = screenShareExperiment(true, "h264", 8_000_000);
  const original = await context.publishOptions(request, room, experiment);
  const voice = new context.Harness();
  voice.activeRoom = room;
  let parameters = {
    encodings: [
      { maxBitrate: 6_000_000, maxFramerate: 65, scaleResolutionDownBy: 1 },
    ],
  };
  const publication = () => ({
    videoTrack: {
      mediaStreamTrack: { getSettings: () => ({ width: 1280, height: 720 }) },
      sender: {
        getParameters: () => globalThis.structuredClone(parameters),
        setParameters: async (value) => {
          parameters = value;
        },
      },
    },
  });
  const first = publication();
  voice.bind(first, original.codecDecision);
  await voice.apply(first, "low");
  assert.equal(parameters.encodings[0].maxBitrate, 8_000_000);
  assert.equal(parameters.encodings[0].maxFramerate, 35);
  assert.equal(parameters.degradationPreference, "maintain-resolution");
  assert.equal(voice.choice.experiment, experiment);
  // The recovery calls pass this snapshot, even when the next-share UI changes.
  const recovery = await context.publishOptions(
    request,
    room,
    voice.choice.experiment,
  );
  const second = publication();
  voice.bind(second, recovery.codecDecision);
  await voice.apply(second, "low60");
  assert.equal(parameters.encodings[0].maxBitrate, 8_000_000);
  assert.equal(parameters.degradationPreference, "maintain-resolution");
  assert.equal(voice.choice.experiment, experiment);
  voice.clear();
});

test("deferred native scaling correction preserves the owning test ceiling", async () => {
  let correction;
  const { context } = voiceHarness({
    setTimeout: (fn) => {
      correction = fn;
      return 1;
    },
    clearTimeout() {},
  });
  const room = {
    remoteParticipants: new Map(),
    localParticipant: { getTrackPublication: () => undefined },
  };
  const selection = await context.publishOptions(
    request,
    room,
    screenShareExperiment(true, "h264", 8_000_000),
  );
  const voice = new context.Harness();
  voice.activeRoom = room;
  let parameters = {
    encodings: [
      { maxBitrate: 6_000_000, maxFramerate: 65, scaleResolutionDownBy: 1 },
    ],
  };
  const pub = {
    videoTrack: {
      mediaStreamTrack: { getSettings: () => ({ width: 1920, height: 1080 }) },
      sender: {
        getParameters: () => globalThis.structuredClone(parameters),
        setParameters: async (value) => {
          parameters = value;
        },
      },
    },
  };
  voice.bind(pub, selection.codecDecision);
  await voice.apply(pub, "low60");
  assert.equal(parameters.encodings[0].maxBitrate, 8_000_000);
  assert.equal(parameters.encodings[0].scaleResolutionDownBy, 1);
  parameters.encodings[0].maxBitrate = 6_000_000;
  correction();
  await Promise.resolve();
  assert.equal(parameters.encodings[0].maxBitrate, 8_000_000);
  assert.equal(parameters.encodings[0].scaleResolutionDownBy, 1.5);
  voice.clear();
});
