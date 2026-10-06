import assert from "node:assert/strict";
import console from "node:console";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";
import vm from "node:vm";
import {
  ScreenShareCodecSelector,
  matchesPrimarySoftware,
} from "./screenShareCodecs.ts";
import { publishPickedScreenShare } from "./screenSharePublication.ts";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const makeTrack = (name) => ({
  name,
  stops: 0,
  mediaStreamTrack: { readyState: "live" },
  stop() {
    this.stops++;
    this.mediaStreamTrack.readyState = "ended";
  },
});
const setup = (overrides = {}) => {
  const tracks = [makeTrack("video"), makeTrack("audio")];
  const calls = [];
  const publishOptions = { videoCodec: "h264" };
  const codecDecision = { key: "1280x720@60" };
  const options = {
    isCurrent: () => true,
    acquire: async () => {
      calls.push("acquire");
      return tracks;
    },
    prepare: async () => {
      calls.push("prepare");
      return { publishOptions, codecDecision };
    },
    publish: async (track, options) => {
      calls.push(`publish:${track.name}`);
      return { track, options };
    },
    unpublish: async (track) => {
      calls.push(`unpublish:${track.name}`);
    },
    ...overrides,
  };
  return { options, calls, tracks, publishOptions, codecDecision };
};
const request = (frameRate) => ({
  width: 1280,
  height: 720,
  frameRate,
  bitrate: 6_000_000,
});

test("initial codec selection waits for the picker and uses its chosen 60 FPS preset", async () => {
  const picker = deferred();
  let chosen = request(30);
  const probes = [];
  const selector = new ScreenShareCodecSelector({
    negotiable: () => ["video/H264"],
    probe: async (contentType, value) => {
      probes.push(value.frameRate);
      return {
        contentType,
        supported: true,
        powerEfficient: value.frameRate === 30,
      };
    },
  });
  assert.equal((await selector.select(chosen)).codec, "h264");
  const env = setup();
  env.options.acquire = async () => {
    await picker.promise;
    chosen = request(60);
    return env.tracks;
  };
  env.options.prepare = async () => {
    const codecDecision = await selector.select(chosen);
    return {
      publishOptions: {
        videoCodec: codecDecision.codec,
        frameRate: chosen.frameRate,
      },
      codecDecision,
    };
  };
  const start = publishPickedScreenShare(env.options);
  await sleep(0);
  assert.equal(probes.length, 4); // only the saved-preset warmup has run
  assert.equal(env.calls.length, 0); // nothing published while the picker is open
  picker.resolve();
  const result = await start;
  assert.equal(result.codecDecision.key, "1280x720@60");
  assert.equal(result.codecDecision.codec, "vp9"); // 30 FPS hardware evidence cannot leak into 60 FPS
  assert.deepEqual(
    result.publications.map((p) => p.options),
    [
      { videoCodec: "vp9", frameRate: 60 },
      { videoCodec: "vp9", frameRate: 60 },
    ],
  );
  assert.deepEqual(
    env.tracks.map((track) => track.stops),
    [0, 0],
  );
});

test("runtime software evidence penalizes the chosen preset while leaving the saved preset eligible", async () => {
  const selector = new ScreenShareCodecSelector({
    negotiable: () => ["video/H264"],
    probe: async (contentType) => ({
      contentType,
      supported: true,
      powerEfficient: true,
    }),
  });
  await selector.select(request(30));
  const env = setup({
    prepare: async () => {
      const codecDecision = await selector.select(request(60));
      return {
        publishOptions: { videoCodec: codecDecision.codec },
        codecDecision,
      };
    },
  });
  const { codecDecision } = await publishPickedScreenShare(env.options);
  assert.equal(
    matchesPrimarySoftware(codecDecision, "1280x720@60", {
      codec: "video/h264",
      advancing: true,
      software: true,
    }),
    true,
  );
  assert.notEqual(selector.recordSoftware(codecDecision), undefined);
  assert.equal((await selector.select(request(60))).codec, "vp9");
  assert.equal((await selector.select(request(30))).codec, "h264");
});

test("cancelled acquisition never selects a codec or publishes media", async () => {
  const error = new globalThis.DOMException(
    "Picker cancelled",
    "NotAllowedError",
  );
  const env = setup({
    acquire: async () => {
      throw error;
    },
  });
  await assert.rejects(
    publishPickedScreenShare(env.options),
    (value) => value === error,
  );
  assert.deepEqual(env.calls, []);
});

test("a stale start does not open another capture picker", async () => {
  const env = setup({ isCurrent: () => false });
  await assert.rejects(publishPickedScreenShare(env.options), {
    name: "AbortError",
  });
  assert.deepEqual(env.calls, []);
});

test("leaving while the picker is open stops acquired video/audio without publishing", async () => {
  const env = setup();
  let current = true;
  env.options.isCurrent = () => current;
  env.options.acquire = async () => {
    current = false;
    return env.tracks;
  };
  await assert.rejects(publishPickedScreenShare(env.options), {
    name: "AbortError",
  });
  assert.deepEqual(env.calls, []);
  assert.deepEqual(
    env.tracks.map((track) => track.stops),
    [1, 1],
  );
});

test("leaving during codec selection cannot publish the late decision", async () => {
  const pending = deferred();
  const env = setup();
  let current = true;
  env.options.isCurrent = () => current;
  env.options.prepare = async () => {
    await pending.promise;
    return {
      publishOptions: env.publishOptions,
      codecDecision: env.codecDecision,
    };
  };
  const start = publishPickedScreenShare(env.options);
  await sleep(0);
  current = false;
  pending.resolve();
  await assert.rejects(start, { name: "AbortError" });
  assert.deepEqual(env.calls, ["acquire"]);
  assert.deepEqual(
    env.tracks.map((track) => track.stops),
    [1, 1],
  );
});

test("ended media and preparation failures stop all capture tracks", async () => {
  for (const mode of ["ended", "constraints", "empty"]) {
    const env = setup();
    const error = Error("Target configuration failed");
    if (mode === "ended") env.tracks[0].mediaStreamTrack.readyState = "ended";
    if (mode === "constraints")
      env.options.prepare = async () => {
        throw error;
      };
    if (mode === "empty") env.options.acquire = async () => [];
    await assert.rejects(
      publishPickedScreenShare(env.options),
      mode === "ended"
        ? { name: "AbortError" }
        : mode === "constraints"
          ? (value) => value === error
          : /no tracks/,
    );
    assert.equal(
      env.calls.some((call) => call.startsWith("publish:")),
      false,
    );
    assert.deepEqual(
      env.tracks.map((track) => track.stops),
      mode === "empty" ? [0, 0] : [1, 1],
    );
  }
});

test("a partial failure stops capture promptly and unpublishes a late successful audio track", async () => {
  const audio = deferred();
  const error = Error("Video publication failed");
  const env = setup();
  env.options.publish = (track) =>
    track.name === "video" ? Promise.reject(error) : audio.promise;
  const start = publishPickedScreenShare(env.options);
  const failed = assert.rejects(start, (value) => value === error);
  await sleep(0);
  assert.deepEqual(
    env.tracks.map((track) => track.stops),
    [1, 1],
  );
  audio.resolve({ track: env.tracks[1] });
  await failed;
  assert.deepEqual(env.calls, ["acquire", "prepare", "unpublish:audio"]);
  assert.deepEqual(
    env.tracks.map((track) => track.stops),
    [1, 1],
  );
});

test("stale successful publications are removed and do not escape as a running share", async () => {
  const pending = deferred();
  const env = setup();
  let current = true;
  env.options.isCurrent = () => current;
  env.options.publish = async (track) => {
    await pending.promise;
    return { track };
  };
  const start = publishPickedScreenShare(env.options);
  await sleep(0);
  current = false;
  pending.resolve();
  await assert.rejects(start, { name: "AbortError" });
  assert.deepEqual(env.calls, [
    "acquire",
    "prepare",
    "unpublish:video",
    "unpublish:audio",
  ]);
  assert.deepEqual(
    env.tracks.map((track) => track.stops),
    [1, 1],
  );
});

test("synchronous publication and cleanup errors preserve the original error", async () => {
  const error = Error("Video publication failed");
  const env = setup();
  env.options.publish = (track) => {
    if (track.name === "video") throw error;
    return Promise.resolve({ track });
  };
  env.tracks[0].stop = () => {
    throw Error("Stop failed");
  };
  env.options.unpublish = () => {
    throw Error("Unpublish failed");
  };
  await assert.rejects(
    publishPickedScreenShare(env.options),
    (value) => value === error,
  );
  assert.equal(env.tracks[1].stops, 1);
});

test("video-only acquisition publishes one track and retains its decision", async () => {
  const env = setup();
  env.tracks.pop();
  const result = await publishPickedScreenShare(env.options);
  assert.equal(result.publications.length, 1);
  assert.equal(result.codecDecision, env.codecDecision);
  assert.deepEqual(env.calls, ["acquire", "prepare", "publish:video"]);
});

// Execute the production Voice action with RTC/modal dependencies replaced,
// without loading the app's JSX/store graph or duplicating its start sequence.
function startHarness({ native = true, audio = true } = {}) {
  const source = readFileSync(
    new URL("./state.tsx", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const begin = source.indexOf("  async toggleScreenshare() {");
  const end = source.indexOf(
    "\n  /**\n   * Apply a quality/audio choice",
    begin,
  );
  assert.ok(begin >= 0 && end > begin);
  const method = source.slice(begin, end);
  const ts = createRequire(import.meta.url)("typescript");
  const captured = deferred();
  const ready = deferred();
  const tracks = [makeTrack("video"), ...(audio ? [makeTrack("audio")] : [])];
  tracks[0].kind = "video";
  const calls = [];
  const publications = new Map();
  let pickerListener;
  let experiment;
  const participant = {
    isScreenShareEnabled: false,
    createScreenTracks: async () => {
      calls.push("acquire");
      pickerListener([]);
      return captured.promise;
    },
    publishTrack: async (track, options) => {
      calls.push({
        publish: track.name,
        frameRate: options.frameRate,
        maxBitrate: options.maxBitrate,
      });
      const pub = track.name === "video" ? { videoTrack: track } : { track };
      publications.set(track.name, pub);
      participant.isScreenShareEnabled = true;
      return pub;
    },
    unpublishTrack: async (track) => publications.delete(track.name),
    getTrackPublication: (source) =>
      publications.get(source === "screen" ? "video" : "audio"),
    setScreenShareEnabled: async (_, capture, options) => {
      calls.push({ browserPublish: options.frameRate });
      return participant.publishTrack(tracks[0], options);
    },
  };
  const selector = new ScreenShareCodecSelector({
    negotiable: () => ["video/H264"],
    probe: async (contentType) => ({
      contentType,
      supported: true,
      powerEfficient: true,
    }),
  });
  const context = vm.createContext({
    Symbol,
    console,
    Promise,
    Error,
    window: {
      native: native
        ? {
            onceScreenPicker: (callback) => {
              pickerListener = callback;
            },
            screenPickerCallback: (index) =>
              index === -1 ? captured.resolve([]) : captured.resolve(tracks),
          }
        : undefined,
    },
    Track: {
      Kind: { Video: "video" },
      Source: { ScreenShare: "screen", ScreenShareAudio: "audio" },
    },
    publishPickedScreenShare,
    getScreenShareExperiment: () => experiment,
    screenSharePublishOptions: async (
      resolution,
      _room,
      selectedExperiment,
    ) => {
      calls.push({ probe: resolution.frameRate });
      const codecDecision = await selector.select(
        {
          ...resolution,
          bitrate: selectedExperiment?.maxBitrate ?? 6_000_000,
        },
        () => false,
        selectedExperiment?.codec,
      );
      codecDecision.experiment = selectedExperiment;
      return {
        publishOptions: {
          videoCodec: codecDecision.codec,
          frameRate: resolution.frameRate,
          maxBitrate: codecDecision.bitrate,
        },
        codecDecision,
      };
    },
    browserCaptureOptions: () => ({}),
    classifyCapturedSurface: () => ({ risk: "none" }),
    setNextScreenShareFrameRate: (value) => {
      calls.push({ captureRate: value });
    },
    SCREEN_SHARE_AUDIO: {},
  });
  const fixture = `class StartHarness {
    #screenShareStart;
    #settings = { screenShareQualityAsk: false, screenShareAudio: false };
    #screenShareQuality = () => "low";
    #setScreenshare = (value) => { this.shared = value; };
    #armScreenShareEnded = () => {};
    #watchForSoftwareFallback = (_, decision) => { this.decision = decision; };
    #screenShareQualityOptions = () => [];
    #endScreenShare = async () => {};
    #applyShareCaptureChoice = async (_, quality) => { this.preparedRate = quality.resolution.frameRate; };
    #applyShareChoice = async (_, __, qualityName, audio) => { this.choice = { qualityName, audio }; };
    activeRoom;
    shared = false;
    errors = [];
    get starting() { return this.#screenShareStart !== undefined; }
    room() { return this.activeRoom; }
    screenshare() { return this.shared; }
    getEnabledScreenShareQualities() { return {
      low: { name: "low", resolution: {width: 1280, height: 720, frameRate: 30} },
      low60: { name: "low60", resolution: {width: 1280, height: 720, frameRate: 60} },
    }; }
    openModal(value) { this.picker = value; this.onPicker(); }
    onErr(error, ignored) { if (!ignored.includes(error.name)) this.errors.push(error); }
    ${method}
  }
  globalThis.StartHarness = StartHarness;`;
  const compiled = ts.transpileModule(fixture, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInContext(compiled, context);
  const voice = new context.StartHarness();
  voice.activeRoom = { state: "connected", localParticipant: participant };
  voice.onPicker = () => ready.resolve();
  return {
    voice,
    ready,
    calls,
    tracks,
    publications,
    setExperiment(value) {
      experiment = value;
    },
  };
}

test("Voice native start publishes the picker's 60 FPS choice, including audio, and blocks duplicate starts", async () => {
  const env = startHarness();
  const start = env.voice.toggleScreenshare();
  await env.ready.promise;
  await env.voice.toggleScreenshare();
  assert.equal(env.calls.filter((call) => call === "acquire").length, 1);
  assert.equal(
    env.calls.some((call) => call.probe),
    false,
  );
  env.voice.picker.callback(0, "low60", true);
  await start;
  assert.equal(env.voice.preparedRate, 60);
  assert.equal(env.voice.decision.key, "1280x720@60");
  assert.deepEqual(
    env.calls.filter((call) => call.publish).map((call) => call.frameRate),
    [60, 60],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(env.voice.choice)), {
    qualityName: "low60",
    audio: true,
  });
  assert.equal(env.voice.shared, true);
  assert.equal(env.voice.starting, false);
});

test("Voice picker cancellation releases the start guard without publishing or reporting an error", async () => {
  const env = startHarness();
  const start = env.voice.toggleScreenshare();
  await env.ready.promise;
  env.voice.picker.onCancel();
  await start;
  assert.equal(env.voice.starting, false);
  assert.equal(env.publications.size, 0);
  assert.equal(env.voice.errors.length, 0);
});

test("Voice native picker snapshots test choices before probing and publishing", async () => {
  const env = startHarness();
  const start = env.voice.toggleScreenshare();
  await env.ready.promise;
  const experiment = Object.freeze({ codec: "h264", maxBitrate: 8_000_000 });
  env.setExperiment(experiment);
  env.voice.picker.callback(0, "low60", true);
  await start;
  assert.equal(env.voice.decision.experiment, experiment);
  assert.equal(env.voice.decision.bitrate, 8_000_000);
  assert.deepEqual(
    env.calls.filter((call) => call.publish).map((call) => call.maxBitrate),
    [8_000_000, 8_000_000],
  );
});

test("Voice leaving during a native picker cannot publish its later selection", async () => {
  const env = startHarness();
  const start = env.voice.toggleScreenshare();
  await env.ready.promise;
  env.voice.activeRoom = undefined;
  env.voice.picker.callback(0, "low60", true);
  await start;
  assert.equal(env.publications.size, 0);
  assert.deepEqual(
    env.tracks.map((track) => track.stops),
    [1, 1],
  );
  assert.equal(env.voice.starting, false);
  assert.equal(env.voice.errors.length, 0);
});

test("Voice browser start preserves the existing SDK capture/publish path", async () => {
  const env = startHarness({ native: false, audio: false });
  await env.voice.toggleScreenshare();
  assert.equal(env.calls.includes("acquire"), false);
  assert.deepEqual(
    env.calls
      .filter((call) => call.browserPublish)
      .map((call) => call.browserPublish),
    [30],
  );
  assert.equal(env.voice.decision.key, "1280x720@30");
  assert.equal(env.voice.shared, true);
});
