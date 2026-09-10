import {
  Accessor,
  batch,
  createContext,
  createEffect,
  createRoot,
  createSignal,
  JSX,
  Setter,
  useContext,
} from "solid-js";
import {
  RoomContext,
  TrackReferenceOrPlaceholder,
  useTracks,
} from "solid-livekit-components";

import {
  AudioPresets,
  DisconnectReason,
  LocalTrack,
  LocalTrackPublication,
  LocalVideoTrack,
  Room,
  ScreenShareCaptureOptions,
  ScreenSharePresets,
  Track,
  TrackEvent,
  TrackPublishOptions,
  VideoCodec,
  VideoResolution,
} from "livekit-client";
import { Channel } from "stoat.js";

import { SoundController, useSound } from "@revolt/client";
import { useInstance } from "@revolt/instance";
import { ModalController, useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  NoiseSuppresionState,
  ScreenShareQualityName,
  ScreenShareQualityNames,
  Voice as VoiceSettings,
} from "@revolt/state/stores/Voice";
import {
  SnackbarController,
  useSnackbar,
} from "@revolt/ui/components/design/Snackbar";
import { VoiceCallCardContext } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";

import { Device, useDevice } from "@revolt/common";
import { InRoom } from "./components/InRoom";
import { RoomAudioManager } from "./components/RoomAudioManager";
import { setNextScreenShareFrameRate } from "./screenShareCapture";
import {
  browserCaptureOptions,
  classifyCapturedSurface,
  isNativeDesktop,
} from "./screenShareSurface";
import {
  getMicPublication,
  hasSoundboardPublication,
  isSoundboardPublication,
  SoundboardPlayer,
  SoundboardSound,
} from "./soundboard";
import { registerSpeakingMeter } from "./speaking";
import { VoiceProcessor } from "./VoiceProcessor";
import { perceptualGain } from "./volume";

type State =
  | "READY"
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING";

type ScreenShareQuality = {
  name: ScreenShareQualityName;
  resolution: VideoResolution;
  fullName: string;
  contentHint: string;
};

/** Capture constraints for the screen share's audio half */
const SCREEN_SHARE_AUDIO: ScreenShareCaptureOptions["audio"] = {
  autoGainControl: false,
  echoCancellation: false,
  noiseSuppression: false,
  voiceIsolation: false,
  restrictOwnAudio: true,
  // Advisory, not `exact`: a plain value can never fail the capture, it just
  // asks getUserMedia to prefer a 2-channel source when the device offers
  // one. Without this, `forceStereo: true` below is an assertion over an
  // unknown source -- if the capture happens to come back mono (e.g. a
  // single-app/window share), we would tell the SFU stereo arrived and spend
  // the stereo bitrate budget on two channels of duplicated content. With it,
  // the capture is genuinely stereo when the device allows it, and
  // `getSettings().channelCount` (and therefore `isStereoInput`) would be 2
  // on its own -- forceStereo becomes belt-and-braces rather than the only
  // thing making the SDP say stereo.
  channelCount: 2,
};

/**
 * Publishing options for a screen share at a given resolution.
 *
 * LiveKit's h1080fps30 preset caps the stream at roughly 2.5 Mbps. 1080p
 * screen content cannot hold 30fps within that, so the encoder trades frames
 * away and settles around 10-12fps even on a connection with plenty of
 * headroom. Give it room, and tell it to protect the framerate rather than the
 * resolution.
 *
 * The ceiling used to be keyed on resolution alone, justified by both presets
 * running at 30fps -- that premise is gone now that 1080p60 ("high60", see
 * {@link ScreenShareQualityName}) exists, so framerate is now a second factor.
 * 1080p60 gets 9 Mbps: 1.5x the 1080p30 ceiling, not 2x, because H.26x
 * inter-frame coding gets cheaper per frame as the temporal distance between
 * frames shrinks -- doubling the frame rate does not double the bits needed
 * to hold the same perceptual quality.
 *
 * 1080p30 itself was lowered from 8 Mbps to 6 Mbps after a real uplink
 * measured at 7.78 Mbps kept tripping publisher reconnects on it: asking the
 * encoder for more than the link can sustain does not degrade gracefully
 * here, LiveKit tears the publish down and republishes it, which is a
 * visible stop/start for every viewer. 6 Mbps now fits comfortably under
 * that link.
 *
 * high60's 9 Mbps is deliberately *not* brought down to fit that same link --
 * it is the ungated top preset offered everywhere, and sizing it to one
 * user's uplink would degrade it for everyone with more headroom. That
 * preset staying above a marginal link is expected and left to {@link
 * Voice.#watchForWeakLink}'s advisory warning; what makes overshooting it
 * survivable rather than a repeated visible stop/start is the rest of this
 * PR -- re-applying encoder limits and re-arming the ended listener after a
 * republish (see the `localTrackPublished` handler in `connect()`).
 * @param resolution Target resolution, or undefined to use the 720p ceiling
 * @returns Publish options
 */
function screenShareEncoding(resolution: VideoResolution | undefined) {
  const height = resolution?.height ?? 720;
  const frameRate = resolution?.frameRate ?? 30;

  let maxBitrate: number;
  if (height <= 720) {
    maxBitrate = 4_000_000;
  } else if (frameRate > 30) {
    maxBitrate = 9_000_000;
  } else {
    maxBitrate = 6_000_000;
  }

  return {
    // This is a ceiling, not a target -- a hardware H.26x encoder settles
    // well under it, so the extra headroom just leaves it room to breathe
    // rather than forcing it there.
    maxBitrate,
    // Deliberately above the source's own cap (`frameRate`, applied via
    // `applyConstraints` in #applyShareChoice/#recoverScreenShare), not equal
    // to it. The source is the real limiter; this is a second, independent
    // cap sitting right on top of it. Frame capture timestamps jitter by a
    // few ms even when the source is healthy, so a frame delivered fractionally
    // early for its nominal slot reads to the encoder's rate limiter as
    // arriving "too soon" -- and at an equal ceiling that frame gets dropped
    // instead of encoded, silently shaving achieved fps below what the source
    // is actually producing. +5fps of headroom absorbs that jitter without
    // giving the encoder room to run away: the source cap still does the
    // actual limiting.
    //
    // On for-desktop's native generator track, `applyConstraints` is not a
    // real track constraint at all -- the injected page patch
    // (appAudioPatch.ts) overrides `generator.applyConstraints` to read the
    // requested `frameRate` and forward it to the native capturer via
    // `screenCaptureBridge.setFps()` (IPC to `setLiveFps` in
    // screenCapture.ts), then resolves immediately without the browser ever
    // seeing a constraint on the (fake) track. That native capturer is the
    // actual source-side limiter there, playing the same role Chromium's own
    // track constraint plays on the browser capture path -- so this encoder
    // ceiling needs the same headroom above it either way.
    maxFramerate: frameRate + 5,
    priority: "high" as const,
    // For consistency with `priority` above; LiveKit already derives
    // `networkPriority` from `priority` when it applies encoding parameters
    // to the sender, so this has no practical effect of its own today. Kept
    // explicit anyway so this object states its own priority intent fully
    // rather than relying on that LiveKit-internal derivation to keep doing
    // it.
    networkPriority: "high" as const,
  };
}

/**
 * The scalar to hand `scaleResolutionDownBy` so a captured frame fits
 * *inside* the target resolution rather than filling it.
 *
 * `scaleResolutionDownBy` is one scalar applied to both axes, so it has to
 * come from whichever axis overflows the target more. Keying it off height
 * alone (the previous behaviour) is exactly the bug this fixes: a 21:9
 * capture scaled by its height-only ratio still has a too-wide result, e.g.
 * a 3440x1440 capture targeting 1920x1080 scaled by height (1440/1080 =
 * 1.333) lands at 2580x1080 -- 1.8x the pixels a correct fit-inside 1920x804
 * would carry, through the same bitrate ceiling.
 *
 * Missing `getSettings()` dimensions degrade to a factor of 1 (publish as
 * captured), the existing safe direction. The result is never allowed below
 * 1 -- `RTCRtpSender.setParameters` throws a `RangeError` for anything under
 * 1.0, and a captured frame already smaller than the target is as good as
 * it gets.
 *
 * The raw fractional factor is returned deliberately unquantized. Chromium's
 * `AlignmentAdjuster` reads the encoder's requested resolution alignment and
 * crops the source so the scaled output lands aligned; snapping the factor
 * by hand here to force even output dimensions would give up real
 * resolution for an arbitrary aspect ratio (a 3440x1440 source would need
 * ~1892x792, about 4% less linear resolution) to solve a problem the
 * browser already handles.
 * @param captured The capturer's actual output dimensions (from
 * `getSettings()`), which may be larger or smaller than the target
 * @param target The resolution the user actually chose
 * @returns The scalar to assign to `RTCRtpEncodingParameters.scaleResolutionDownBy`
 */
function screenShareScaleFactor(
  captured: { width?: number; height?: number },
  target: VideoResolution,
): number {
  return Math.max(
    1,
    captured.width && target.width ? captured.width / target.width : 1,
    captured.height && target.height ? captured.height / target.height : 1,
  );
}

/** One `mediaCapabilities.encodingInfo` probe's outcome, kept for logging. */
type CodecProbe = {
  contentType: string;
  supported: boolean;
  powerEfficient: boolean;
};

/**
 * The codec decision computed for one resolution/framerate key, kept around
 * so `screenSharePublishOptions` can read the CBP hardware verdict back out
 * without re-probing, and so `getScreenShareCodecDecision()` can expose it.
 */
type ScreenShareCodecDecision = {
  key: string;
  codec: VideoCodec;
  reason: string;
  probes: CodecProbe[];
  /** Whether hardware H.264 was found at Constrained Baseline specifically. */
  cbpHardware: boolean;
  at: number;
};

/** Last decision computed by {@link screenShareCodec}, for devtools inspection. */
let lastScreenShareCodecDecision: ScreenShareCodecDecision | undefined;

/**
 * Decisions already computed, keyed by `${width}x${height}@${frameRate}`.
 *
 * A failed probe (see {@link screenShareCodec}) is never written here, so a
 * cold GPU process timing out on the first share does not pin every later
 * share at that resolution to software.
 */
const screenShareCodecDecisions = new Map<string, ScreenShareCodecDecision>();

/** In-flight probes, so priming and a fast publish share one probe rather than racing two. */
const screenShareCodecInFlight = new Map<string, Promise<VideoCodec>>();

/** How long the whole probe batch gets before giving up and using vp9 for this share. */
const SCREEN_SHARE_CODEC_PROBE_TIMEOUT_MS = 1_500;

const H265_CONTENT_TYPE = "video/H265";
/**
 * The only H.264 probe we can act on. On Windows, Chromium does not
 * advertise hardware Constrained Baseline support unless the
 * `PlatformH264CbpEncoding` feature is enabled, while Main/High are
 * advertised regardless of it -- and LiveKit only takes `videoCodec:
 * "h264"`, never a specific profile; the profile is decided afterwards by
 * SDP negotiation with the SFU. So a Main/High-only hardware hit is not
 * something we can hand LiveKit, and trusting it would reproduce this exact
 * regression under a different profile string.
 */
const H264_CBP_CONTENT_TYPE =
  "video/H264;profile-level-id=42e01f;packetization-mode=1";
/** Diagnostics only, never decisive -- see {@link H264_CBP_CONTENT_TYPE}. */
const H264_MAIN_CONTENT_TYPE =
  "video/H264;profile-level-id=4d001f;packetization-mode=1";
/** Diagnostics only, never decisive -- see {@link H264_CBP_CONTENT_TYPE}. */
const H264_HIGH_CONTENT_TYPE =
  "video/H264;profile-level-id=640c1f;packetization-mode=1";

/** A probe counts as hardware only when both flags agree -- see {@link screenShareCodec}. */
function isHardware(probe: CodecProbe): boolean {
  return probe.supported && probe.powerEfficient;
}

/**
 * The best codec this client can hardware-encode for a share at the given
 * resolution/framerate, in preference order h265 > h264 (Constrained
 * Baseline only) > vp9.
 *
 * `RTCRtpSender.getCapabilities("video")` lists every codec Chromium can
 * *negotiate*, including OpenH264 -- a software fallback Chromium always
 * bundles and therefore always lists -- so relying on it alone picks H.264
 * on a machine with no working hardware encoder at all and silently lands
 * on software (confirmed in production: `encoderImplementation:
 * "OpenH264"` at 5.28 Mbps for only 1280x536, worse than the VP9/libvpx it
 * replaced).
 *
 * `navigator.mediaCapabilities.encodingInfo()`'s `powerEfficient` flag is
 * Chromium's own hardware-encode signal: it routes through the same
 * `webrtc::VideoEncoderFactory::QueryCodecSupport()` that PeerConnection
 * itself uses. `smooth` is deliberately never read -- it depends on encode
 * history a fresh profile does not have, and reports false on perfectly
 * good hardware.
 *
 * A codec only counts as usable here if it is BOTH (a) present in
 * `RTCRtpSender.getCapabilities("video")` -- necessary, it must be
 * offerable in SDP -- AND (b) hardware per {@link isHardware} -- sufficient,
 * it must not be software.
 *
 * Probed at the resolution/framerate about to be published, not some fixed
 * default: Chromium applies per-profile min/max resolution filtering, so
 * e.g. 1080p60 HEVC can be genuinely absent on hardware that has 720p30
 * HEVC. Every probe is wrapped in one shared {@link
 * SCREEN_SHARE_CODEC_PROBE_TIMEOUT_MS} timeout (`Promise.all` raced against
 * it, so the wall-clock cost of waiting is one probe's worth, not four) --
 * a slow first `encodingInfo` call on a cold GPU process must not stall the
 * share starting. If `mediaCapabilities.encodingInfo` is missing or any
 * probe rejects outright, this returns "vp9" for *this* call only and
 * writes nothing to the cache, so the next attempt retries from scratch.
 *
 * A bare timeout is different: the four `encodingInfo` calls are not
 * cancelled by losing the race, only abandoned by *this* call -- they keep
 * running, and whichever one of them resolves the batch still computes and
 * caches the real decision when it eventually lands, exactly as if it had
 * won the race. So only the very first share of a cold session (the one
 * that hits a cold GPU process) actually pays the probe latency; by the
 * time a second share asks for the same key, the backgrounded probe has
 * usually already finished and cached the answer, however late it was too
 * late for the *first* share to use.
 *
 * AV1 is deliberately never probed: LiveKit treats it as SVC and forces
 * L1T3, which non-Intel hardware cannot do, so it would quietly land on
 * libaom regardless of what we found here.
 * @param resolution Resolution/framerate about to be published, or
 * undefined to probe at 1920x1080@30 (only the recovery path can pass
 * undefined, and over-asking there is the safe direction)
 * @returns The codec to publish with
 */
async function screenShareCodec(
  resolution: VideoResolution | undefined,
): Promise<VideoCodec> {
  const width = resolution?.width || 1920;
  const height = resolution?.height || 1080;
  const frameRate = resolution?.frameRate || 30;
  const key = `${width}x${height}@${frameRate}`;

  const cached = screenShareCodecDecisions.get(key);
  if (cached) {
    lastScreenShareCodecDecision = cached;
    return cached.codec;
  }

  const inFlight = screenShareCodecInFlight.get(key);
  if (inFlight) return inFlight;

  // Typed as non-optional in lib.dom.d.ts, but not every Chromium build
  // actually implements `encodingInfo` -- check before using it rather
  // than trust the type.
  const mediaCapabilities: MediaCapabilities | undefined =
    navigator.mediaCapabilities;

  if (typeof RTCRtpSender === "undefined" || !mediaCapabilities?.encodingInfo) {
    // Same reasoning as the rejection path below: record it so a stale
    // `cbpHardware` from an earlier share cannot leak into the backup
    // codec choice, but do not cache it. Nothing to probe here, so there is
    // no in-flight work to hand later callers either.
    lastScreenShareCodecDecision = {
      key,
      codec: "vp9",
      reason:
        "mediaCapabilities.encodingInfo unavailable; cannot verify hardware",
      probes: [],
      cbpHardware: false,
      at: Date.now(),
    };
    return "vp9";
  }

  const negotiable = new Set(
    (RTCRtpSender.getCapabilities?.("video")?.codecs ?? []).map((codec) =>
      codec.mimeType.toLowerCase(),
    ),
  );

  // Built from the already-defaulted width/height/frameRate locals, not
  // the raw (possibly undefined) `resolution` param, so the bitrate probed
  // here always matches the resolution actually probed above.
  const bitrate = screenShareEncoding({
    width,
    height,
    frameRate,
  }).maxBitrate;

  const probe = (contentType: string): Promise<CodecProbe> =>
    mediaCapabilities
      .encodingInfo({
        type: "webrtc",
        video: {
          contentType,
          width,
          height,
          framerate: frameRate,
          bitrate,
          scalabilityMode: "L1T1",
        },
      })
      .then((info) => ({
        contentType,
        supported: info.supported,
        powerEfficient: info.powerEfficient,
      }));

  // The actual probe work, kept as its own promise rather than folded
  // straight into the race below. This is what lets a probe that loses the
  // race to the timeout keep going instead of being thrown away: this
  // promise is never cancelled by anything, so whichever caller (this one,
  // or a later one that joins it via `screenShareCodecInFlight`) is still
  // around when it settles gets the real decision, and it is cached exactly
  // once regardless of whether that happens before or after the timeout.
  const probesPromise: Promise<VideoCodec> = Promise.all([
    probe(H265_CONTENT_TYPE),
    probe(H264_CBP_CONTENT_TYPE),
    probe(H264_MAIN_CONTENT_TYPE),
    probe(H264_HIGH_CONTENT_TYPE),
  ]).then(
    (probes) => {
      const [h265, h264Cbp, h264Main, h264High] = probes;

      let codec: VideoCodec;
      let reason: string;

      if (negotiable.has("video/h265") && isHardware(h265)) {
        codec = "h265";
        reason = "hardware h265 available and negotiable";
      } else if (negotiable.has("video/h264") && isHardware(h264Cbp)) {
        codec = "h264";
        reason = "hardware h264 available at constrained baseline";
      } else if (isHardware(h264Main) || isHardware(h264High)) {
        codec = "vp9";
        reason =
          "hardware h264 exists here but only for main/high, which the SFU will not negotiate -- falling back to vp9";
      } else {
        codec = "vp9";
        reason = "no hardware h265/h264 found, falling back to vp9";
      }

      const decision: ScreenShareCodecDecision = {
        key,
        codec,
        reason,
        probes,
        cbpHardware: isHardware(h264Cbp),
        at: Date.now(),
      };

      console.info(
        `[rtc] screen share codec for ${key}: ${codec} (${reason})`,
        probes.map(
          (p) =>
            `${p.contentType} supported=${p.supported} powerEfficient=${p.powerEfficient}`,
        ),
      );

      screenShareCodecDecisions.set(key, decision);
      lastScreenShareCodecDecision = decision;

      return codec;
    },
    () => {
      // A genuine rejection (not the timeout below, which never touches
      // this promise) -- e.g. `encodingInfo` itself threw. Record it
      // without caching, same as the missing-API branch above, so a
      // transient failure cannot pin this key at vp9 forever.
      lastScreenShareCodecDecision = {
        key,
        codec: "vp9",
        reason: "probe rejected; not cached, will retry next share",
        probes: [],
        cbpHardware: false,
        at: Date.now(),
      };
      return "vp9";
    },
  );

  // Tracked under the real probe, not the race below -- and only cleared
  // once the real probe settles. A concurrent call for this key, whether it
  // arrives while we are still waiting on the timeout or only after we have
  // already fallen back to vp9 here, joins this same probe instead of
  // starting a second one.
  screenShareCodecInFlight.set(key, probesPromise);
  probesPromise.finally(() => screenShareCodecInFlight.delete(key));

  const raced = await Promise.race([
    probesPromise,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), SCREEN_SHARE_CODEC_PROBE_TIMEOUT_MS),
    ),
  ]);

  if (raced !== "timeout") return raced;

  console.info(
    `[rtc] screen share codec probe for ${key} timed out, using vp9 for this share -- the probe keeps running in the background and will cache its result for the next share`,
  );
  // Record it as the last decision without caching it yet. Skipping this
  // would leave `lastScreenShareCodecDecision` pointing at some earlier
  // share's result, and `screenSharePublishOptions` reads `cbpHardware` off
  // it -- so a stale `true` would pick an h264 backup codec on the strength
  // of a probe that never actually finished for this configuration. Once
  // `probesPromise` above does resolve, its own `.then` overwrites this with
  // the real decision.
  lastScreenShareCodecDecision = {
    key,
    codec: "vp9",
    reason:
      "probe timed out; not cached yet -- the backgrounded probe will cache its result once it resolves",
    probes: [],
    cbpHardware: false,
    at: Date.now(),
  };
  return "vp9";
}

/**
 * The last screen share codec decision computed, for inspection from
 * devtools during a live call.
 */
export function getScreenShareCodecDecision() {
  return lastScreenShareCodecDecision;
}

async function screenSharePublishOptions(
  resolution: VideoResolution | undefined,
): Promise<TrackPublishOptions> {
  const videoCodec = await screenShareCodec(resolution);
  const decision = getScreenShareCodecDecision();

  return {
    screenShareEncoding: screenShareEncoding(resolution),
    videoCodec,
    // vp8 and h264 are the only codecs LiveKit accepts as a backup. Reaching
    // for h264 just because it's "probably hardware" was the exact mistake
    // behind the bug this codec picker fixes -- doing that for the *backup*
    // codec would reproduce it one layer down. So h264 is only offered here
    // when the Constrained Baseline probe that decided the primary codec
    // actually found hardware for it, and it isn't already the primary
    // (asking for a second hardware encode of the same codec is pointless).
    // Everything else falls back to vp8.
    backupCodec:
      decision?.cbpHardware && videoCodec !== "h264"
        ? { codec: "h264" }
        : { codec: "vp8" },
    // h264/h265 are not SVC codecs, so LiveKit routes them down its simulcast
    // branch and adds a second 960x540 encode -- one hardware encode is the
    // whole point, so this matters for them. For vp9 it's redundant on its
    // own: LiveKit's SVC branch in computeVideoEncodings returns before ever
    // reading `options.simulcast`. Redundant, not harmful, so there is no
    // reason to special-case it away -- `simulcast` defaults to true, so say
    // no explicitly regardless of which codec was picked.
    simulcast: false,
    degradationPreference: "maintain-framerate",
    // The fields below are meant for the *audio* half of the share, but
    // LocalParticipant's setTrackEnabled loop calls
    // publishTrack(track, publishOptions) once per acquired track using this
    // same `opts` object, so the screen-share *video* track's TrackInfo goes
    // up with `stereo: true`, `disableDtx: true` and `audioFeatures:
    // [TF_NO_DTX]` too -- fields that mean nothing for video. That is inert,
    // not a bug: nothing client-side reads those fields back off a video
    // publication, so it costs nothing beyond a few unused bytes in the
    // signalling message. Left unset, the audio track fell through to
    // livekit-client's generic defaults (audioPreset: music, dtx: true,
    // forceStereo: false) -- tuned for a mic, not for a desktop mixer feeding
    // continuous game/app audio.
    //
    // These are publish-time options: LocalParticipant snapshots them onto
    // `publication.options` and reuses that snapshot on every future
    // `republishAllTracks` pass. Unlike video's `scaleResolutionDownBy`, they
    // need no re-apply in the `localTrackPublished` handler -- that asymmetry
    // is deliberate, not an oversight, so don't "fix" it by adding one.
    //
    // forceStereo and audioPreset are one decision, not two. LocalParticipant
    // computes `isStereo = opts.forceStereo ?? isStereoInput`, and `??` does
    // not fall through on `false` -- so without an explicit `true` here,
    // stereo *capture* was always negotiated as mono, and the SDP never
    // carried `stereo=1`/`sprop-stereo=1` for the desktop app's stereo mixer
    // output. Turning stereo on without also raising the bitrate would be a
    // regression on its own: 48 kbps split across two channels is worse than
    // 48 kbps mono, hence the bump to the stereo preset alongside it.
    forceStereo: true,
    // 64 kbps, not the 128 kbps "high quality" stereo preset: the reported
    // problem is artefacts, not fidelity, and RED (below) roughly doubles
    // bytes on the wire. The real question is how much this adds versus
    // before, not what share of the video ceiling it is -- that ceiling is
    // a cap the encoder rarely reaches, not actual throughput, so comparing
    // audio to it overstates how small the change is. Mono audio already
    // carried RED (see below), so the prior real cost was ~48 kbps + RED ≈
    // 96 kbps; stereo at this preset + RED ≈ 128 kbps. The delta this change
    // actually adds is +32 kbps, and audio already carries
    // `networkPriority: 'high'`, so that delta is what could matter on a
    // marginal link, not a percentage of a video number that was never
    // comparable to begin with.
    audioPreset: AudioPresets.musicStereo,
    // The only field here that plausibly explains "robotic". DTX is a speech
    // optimisation: the encoder's own VAD decides a frame is silence and
    // gates transmission off, and the decoder fills the gap with synthesized
    // comfort noise. On continuous game/desktop audio the VAD misfires on
    // quiet passages and music tails, and gating on and off is heard as
    // warbling and hollow. It buys nothing here -- a screen share worth
    // publishing audio for is rarely truly silent.
    dtx: false,
    // RED was already on: it's livekit-client's own `publishDefaults.red`,
    // so this line changes nothing about today's behaviour by itself. What
    // it guards against is LocalParticipant's "disable dtx/red for stereo
    // unless set explicitly" branch, which never fired before this change
    // because `isStereo` was always false -- now that `forceStereo` makes it
    // true, that branch would silently turn RED back off unless we pin it
    // here explicitly. Forward redundancy is what protects the "all viewers
    // degrade at once" case on a marginal uplink, and pinning it means it
    // cannot flip off as a side effect of `forceStereo` changing above.
    //
    // DTX is different: `dtx: false` above only stops *us* from asking for
    // it. Whether it was ever actually active depended on the SFU's own
    // answer setting `usedtx=1` -- there is no client-side SDP munging for
    // this in the codebase, so the request is the only lever we have.
    red: true,
  };
}

/** How long to wait after publishing before sampling for a software encoder. */
const SOFTWARE_FALLBACK_CHECK_DELAY_MS = 5_000;

/** How long to wait after applying a quality choice before checking the link. */
const WEAK_LINK_CHECK_DELAY_MS = 5_000;

/**
 * Whether the network looks unable to sustain a chosen screen-share bitrate
 * ceiling.
 *
 * Either signal alone is enough: a link whose current headroom already sits
 * under the ceiling is obviously too weak for it, but a link that measures
 * enough headroom *right now* while the encoder has already spent real time
 * bandwidth-limited recently is still one that could not hold the ceiling
 * moment to moment (`availableOutgoingBitrate` is an instantaneous BWE
 * estimate, so it can look fine between the congestion events that produced
 * that time).
 *
 * Exported so {@link ScreenShareStats} can show the same verdict as a
 * persistent row, computed from stats it already reads, without duplicating
 * the threshold logic.
 *
 * Gated on `document.visibilityState` and a higher bandwidth-limited
 * threshold (2s, up from a hair-trigger 0.1s): a backgrounded/minimised
 * sharer's encoder can look bandwidth-limited for reasons that have nothing
 * to do with the actual link -- Chromium throttles a hidden tab's encode
 * pace -- and that used to be enough on its own to pop the weak-link modal
 * on a perfectly fine connection. Requiring the page to be visible when the
 * sample is taken keeps this verdict about the link, not about whether the
 * sharer alt-tabbed a moment ago.
 * @param maxBitrate The encoder's bitrate ceiling for the chosen quality
 * @param availableOutgoingBitrate `candidate-pair.availableOutgoingBitrate`, if reported
 * @param bandwidthLimitedSeconds `outbound-rtp.qualityLimitationDurations.bandwidth`, if reported
 * @returns Whether the link looks too weak for `maxBitrate`
 */
export function isScreenShareLinkWeak(
  maxBitrate: number,
  availableOutgoingBitrate: number | undefined,
  bandwidthLimitedSeconds: number | undefined,
): boolean {
  if (document.visibilityState !== "visible") return false;

  const belowCeiling =
    availableOutgoingBitrate !== undefined &&
    availableOutgoingBitrate < maxBitrate;
  const bandwidthLimited = (bandwidthLimitedSeconds ?? 0) > 2;
  return belowCeiling || bandwidthLimited;
}

/**
 * Surfaced at most once per session (see {@link Voice.#watchForWeakLink}) so
 * a link that stays weak across several shares does not nag on every one.
 */
let weakLinkWarningShown = false;

/** At most this many automatic share recoveries ... */
const MAX_RECOVERIES = 3;

/** ... within this window, so a permanently broken capture cannot loop */
const RECOVERY_WINDOW_MS = 60_000;

/**
 * At most this many automatic rejoins after an *unexpected* room
 * disconnect (see {@link Voice.#handleUnexpectedDisconnect}) within
 * {@link DISCONNECT_RECOVERY_WINDOW_MS}, mirroring the
 * {@link MAX_RECOVERIES}/{@link RECOVERY_WINDOW_MS} sliding-window idiom
 * screen-share recovery already uses -- same shape, deliberately a
 * *separate* budget (own constants, own {@link Voice.#disconnectRecoveryAttempts}
 * array) so a connection that keeps dropping and a capture that keeps dying
 * cannot exhaust each other's allowance.
 */
const MAX_DISCONNECT_RECOVERIES = 3;

/** ... within this window, so a connection that cannot stay up stops flapping. */
const DISCONNECT_RECOVERY_WINDOW_MS = 60_000;

/**
 * `DisconnectReason`s that mean the server deliberately ended *this exact*
 * session rather than the connection merely failing -- rejoining would just
 * reconnect into the same eviction (a second tab/device with the same
 * identity, an explicit kick, the room being torn down) and flap against
 * whatever caused it. Every other reason, including `undefined` (older
 * livekit-server versions, or a reason livekit-client itself does not know
 * about), is treated as recoverable and gets one bounded rejoin -- see
 * {@link Voice.#handleUnexpectedDisconnect}.
 */
const TERMINAL_DISCONNECT_REASONS: ReadonlySet<DisconnectReason> = new Set([
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
]);

/**
 * Renders a `DisconnectReason` as a stable, human-readable string for logs
 * and the snackbar -- `DisconnectReason` is a numeric enum, so the bare
 * value alone (`2`) means nothing in `app-audio.log` without this reverse
 * lookup. `undefined` is named explicitly rather than falling through to
 * `"undefined"`: livekit-client does not always supply a reason, and that
 * is itself useful information to capture, not an error in this function.
 */
function describeDisconnectReason(
  reason: DisconnectReason | undefined,
): string {
  if (reason === undefined) return "no reason given";
  return `${DisconnectReason[reason] ?? "UNRECOGNIZED"} (${reason})`;
}

/**
 * Backoff schedule for {@link Voice.#scheduleReacquireRetry}: how long to
 * wait before each retry once {@link Voice.#recoverScreenShare} has failed to
 * bring a share back up. The last entry repeats for as long as the share
 * stays down -- there is no give-up here, only the user stopping does.
 */
const REACQUIRE_BACKOFF_MS = [5_000, 15_000, 60_000];

/**
 * Absolute cap on how long a screen share may sit parked (counted from when
 * the capture first went down -- see {@link Voice.#onScreenShareEnded}
 * stamping {@link Voice.#parkedSince}, not from when
 * {@link Voice.#scheduleReacquireRetry} first parks it) before we give up
 * and end it for real, even though {@link Voice.#recoverScreenShare} never
 * got a definitive answer either way. This is the platform-independent
 * safety net: for-desktop's own reacquire poll already gives up after
 * REACQUIRE_TIMEOUT_MS (90s, in `window.ts`) per attempt and can report the
 * terminal `"gone"` immediately on a confirmed-destroyed window, but an
 * older desktop build only ever resolves a bare `false`, and plain web
 * (`#recoverScreenShareBrowser`) has no terminal signal at all -- both would
 * otherwise retry with {@link REACQUIRE_BACKOFF_MS}'s backoff forever, which
 * is exactly the "never stops" bug this whole cap exists to close. Set
 * comfortably longer than one reacquire poll (90s) so a genuinely slow
 * window recreation (e.g. a heavy app restarting) still wins and the share
 * recovers instead of being cut off from under it.
 *
 * Not a hard bound, though: the cap is only ever tested *between*
 * `#recoverScreenShare` calls (before starting one, and again after it
 * resolves), never while one is in flight, so a reacquire call that was
 * already running when the cap ticked over is left to finish rather than
 * cut off mid-call. Worst case the share therefore lives for roughly
 * `MAX_PARKED_MS` plus one more reacquire poll (up to REACQUIRE_TIMEOUT_MS,
 * 90s) on top -- not the ~2 minutes this constant might otherwise imply.
 */
const MAX_PARKED_MS = 2 * 60 * 1000;

/**
 * How long the sharer's own "screen share ended" notice
 * ({@link Voice.screenShareState}`()` starting with `"ended-"`) stays up
 * before Voice clears it back to `"idle"` on its own -- see
 * {@link Voice.#showEndedNotice}. Owned here rather than as a timer inside
 * `ParticipantTile`: `screenShareState` is shared Voice state, not view
 * state, so a stray remount of the tile (e.g. the participant grid
 * re-rendering) must not reset or duplicate the clock.
 */
const ENDED_NOTICE_MS = 4_000;

/** What a screen share was started with, remembered so a capture that dies
 * can be recovered with the same quality/audio rather than the saved default. */
type ShareChoice = { qualityName: ScreenShareQualityName; audio: boolean };

class Voice {
  #settings: VoiceSettings;

  channel: Accessor<Channel | undefined>;
  #setChannel: Setter<Channel | undefined>;

  room: Accessor<Room | undefined>;
  #setRoom: Setter<Room | undefined>;

  vidTracks: Accessor<TrackReferenceOrPlaceholder[]>;

  state: Accessor<State>;
  #setState: Setter<State>;

  deafen: Accessor<boolean>;
  microphone: Accessor<boolean>;

  video: Accessor<boolean>;
  #setVideo: Setter<boolean>;

  screenshare: Accessor<boolean>;
  #setScreenshare: Setter<boolean>;

  /**
   * Whether a live screen share's capture is currently down and being
   * automatically retried (see {@link #scheduleReacquireRetry}), or has just
   * ended on a terminal verdict. Distinct from {@link screenshare}, which
   * stays `true` throughout `"reacquiring"` -- from the sharer's perspective
   * the share never stopped, this is just enough for their own tile to show
   * an inline notice while it waits to come back. The `"ended-"` states are
   * different: `screenshare()` has already flipped `false` by the time
   * either is set (see {@link #endScreenShare}), and they exist purely so
   * the sharer can be told why their tile just lost its share instead of it
   * silently vanishing -- the UI clears back to `"idle"` a few seconds later
   * (see `#showEndedNotice`). The two are split rather than a single
   * `"ended"` because they know different amounts: `"ended-gone"` is a
   * confirmed-destroyed window (for-desktop's `"gone"` verdict, see
   * `#recoverScreenShare`) and can say so specifically, while
   * `"ended-timeout"` is {@link MAX_PARKED_MS} giving up on an *ambiguous*
   * verdict (an older desktop build's bare `false`, or plain web, neither of
   * which ever confirms the window/tab is actually gone) and must not claim
   * a cause it was never told.
   */
  screenShareState: Accessor<
    "idle" | "reacquiring" | "ended-gone" | "ended-timeout"
  >;
  #setScreenShareState: Setter<
    "idle" | "reacquiring" | "ended-gone" | "ended-timeout"
  >;

  fullscreen: Accessor<boolean>;
  #setFullscreen: Setter<boolean>;

  focusId: Accessor<string | undefined>;
  #setFocus: Setter<string | undefined>;

  showBar: Accessor<boolean>;
  #setShowBar: Setter<boolean>;

  soundboard: Accessor<SoundboardPlayer | undefined>;
  #setSoundboard: Setter<SoundboardPlayer | undefined>;

  private sound: SoundController;
  private device: Device;

  private openModal;
  private config;
  private limits;
  private snackbar: SnackbarController;
  private screenShareTracks: Set<string>;
  private voiceProcessor?: VoiceProcessor;
  #localSpeakingMeter?: () => void;

  /**
   * Disposer for the `createRoot` that owns `vidTracks`'s `useTracks` call
   * (see {@link connect}). `connect` runs outside any Solid render tree, so
   * without an explicit root the effect and rxjs subscription `useTracks`
   * creates would never be torn down -- rejoining a call would just keep
   * stacking more of them. Cleared by {@link disconnect}.
   */
  #disposeVidTracks?: () => void;

  /** What the last successful share was started with, for recovery */
  #lastShareChoice?: ShareChoice;
  #recoveryAttempts: number[] = [];
  #recovering = false;

  /**
   * Sliding window of automatic-rejoin timestamps, bounding
   * {@link Voice.#handleUnexpectedDisconnect}'s auto-rejoin the same way
   * {@link #recoveryAttempts} bounds screen-share recovery. Kept separate
   * from {@link #recoveryAttempts} on purpose: a flapping LiveKit connection
   * and a flapping screen-share capture are unrelated failures and must not
   * share (and so prematurely exhaust) the same budget.
   */
  #disconnectRecoveryAttempts: number[] = [];

  /**
   * The publication {@link #armScreenShareEnded} last attached its "ended"
   * listener to, so it can tell a publication it has already armed apart
   * from a genuinely new one. A full reconnect's `republishAllTracks`
   * discards the old `LocalTrackPublication` and fires `localTrackPublished`
   * for a fresh one, which also routes through `#armScreenShareEnded` -- and
   * `toggleScreenshare`/`#recoverScreenShare` call it directly on that same
   * fresh publication too. Without this guard both call paths would attach
   * their own "ended" listener to the one live publication, so a single
   * capture death would run two recovery cycles instead of one.
   */
  #armedShareEndedPublication?: LocalTrackPublication;

  /**
   * The `LocalVideoTrack` {@link #armScreenShareEnded} last attached its
   * upstream-pause listener to (see that method). Unlike
   * {@link #armedShareEndedPublication}, this is keyed on the *track*, not
   * the publication: `republishAllTracks` wraps the same live
   * `LocalVideoTrack` in a brand new `LocalTrackPublication` on a full
   * reconnect (it does not restart screen-share tracks), so guarding on the
   * publication alone would re-arm a second listener on the same track object
   * and double-fire `resumeUpstream()` on every future mute.
   */
  #armedScreenShareUpstreamTrack?: LocalVideoTrack;

  /** Pending {@link #scheduleReacquireRetry} timer, if a share is currently parked. */
  #reacquireTimer?: ReturnType<typeof setTimeout>;
  /** How far into {@link REACQUIRE_BACKOFF_MS} the next retry is. */
  #reacquireBackoffStep = 0;

  /**
   * Timestamp of the moment the capture first went down in the current
   * parking episode, or `undefined` when nothing is parked. Stamped at the
   * top of {@link #onScreenShareEnded}, *before* the first
   * {@link #recoverScreenShare} call -- not inside {@link
   * #scheduleReacquireRetry}, which only runs after that first call already
   * returned. Stamping it that early matters: {@link #recoverScreenShare}
   * can itself block for up to REACQUIRE_TIMEOUT_MS (90s, in for-desktop's
   * `window.ts`) per attempt, and stamping only once parking starts would
   * let one or more such in-flight calls run before {@link MAX_PARKED_MS}
   * is ever measured against anything, letting the real parked duration
   * balloon well past what the cap documents. Compared against
   * {@link MAX_PARKED_MS} both before and after every {@link
   * #recoverScreenShare} call so a share that never gets a definitive
   * answer either way still ends close to on schedule instead of parking
   * indefinitely. Cleared in {@link #stopReacquireBackoff}, the single place
   * all three "stop being parked" paths -- a real stop, disconnect, and a
   * successful recovery -- already funnel through.
   */
  #parkedSince?: number;

  /** Pending {@link #showEndedNotice} auto-clear timer. */
  #endedNoticeTimer?: ReturnType<typeof setTimeout>;

  /**
   * Whether the one silent re-acquire {@link #recoverScreenShareBrowser}
   * is allowed has already been spent for the share currently running.
   * Reset when a fresh share starts and when the current one stops -- see
   * `toggleScreenshare`, `disconnect`, and `changeScreenShareSource` (a
   * manually picked new source is "fresh" for this budget too, and backing
   * all the way out of it is a real stop).
   */
  #browserReacquireAttempted = false;

  constructor(
    voiceSettings: VoiceSettings,
    modals: ModalController,
    sound: SoundController,
    device: Device,
    snackbar: SnackbarController,
  ) {
    this.#settings = voiceSettings;
    this.sound = sound;
    this.device = device;
    this.snackbar = snackbar;

    const [channel, setChannel] = createSignal<Channel>();
    this.channel = channel;
    this.#setChannel = setChannel;

    const [room, setRoom] = createSignal<Room>();
    this.room = room;
    this.#setRoom = setRoom;

    this.vidTracks = () => [];

    const [state, setState] = createSignal<State>("READY");
    this.state = state;
    this.#setState = setState;

    this.deafen = () => voiceSettings.deafen;
    this.microphone = () => voiceSettings.micOn && !voiceSettings.deafen;

    const [video, setVideo] = createSignal(false);
    this.video = video;
    this.#setVideo = setVideo;

    const [screenshare, setScreenshare] = createSignal(false);
    this.screenshare = screenshare;
    this.#setScreenshare = setScreenshare;

    const [screenShareState, setScreenShareState] = createSignal<
      "idle" | "reacquiring" | "ended-gone" | "ended-timeout"
    >("idle");
    this.screenShareState = screenShareState;
    this.#setScreenShareState = setScreenShareState;

    const [fullscreen, setFullscreen] = createSignal(false);
    this.fullscreen = fullscreen;
    this.#setFullscreen = setFullscreen;

    const [focus, setFocus] = createSignal<string>();
    this.focusId = focus;
    this.#setFocus = setFocus;

    const [showBar, setShowBar] = createSignal(true);
    this.showBar = showBar;
    this.#setShowBar = setShowBar;

    const [soundboard, setSoundboard] = createSignal<SoundboardPlayer>();
    this.soundboard = soundboard;
    this.#setSoundboard = setSoundboard;

    const inst = useInstance();
    this.config = inst.config;
    this.limits = inst.limits;
    this.openModal = modals.openModal;

    this.screenShareTracks = new Set();

    // Setup settings listeners
    this.settingsListeners();
  }

  // Dynamically set echo cancellation and gain control when the settings are changed
  // These functions are needed to maintain reactivity. Don't ask me why but if you make them not functions it breaks.
  private settingsListeners() {
    const getSettings = () => this.#settings;

    const setEchoCancellation = (echoCancellation: boolean) => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        track.constraints.echoCancellation = echoCancellation;
      }
    };

    const setAutoGainControl = (autoGainControl: boolean) => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        track.constraints.autoGainControl = autoGainControl;
      }
    };

    const setNoiseSuppression = (noiseSuppression: NoiseSuppresionState) => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        if (noiseSuppression === "browser") {
          track.constraints.noiseSuppression = true;
          //@ts-expect-error voiceIsolation is not yet standard, but it supported by livekit and most chromium based browsers, including electron.
          track.constraints.voiceIsolation = true;
        } else {
          track.constraints.noiseSuppression = false;
          //@ts-expect-error voiceIsolation is not yet standard, but it supported by livekit and most chromium based browsers, including electron.
          track.constraints.voiceIsolation = false;
        }
      }
    };

    const restartTrack = () => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        track.restartTrack();
      }
    };

    createEffect(() => {
      setEchoCancellation(getSettings().echoCancellation ?? true);
      setAutoGainControl(getSettings().autoGainControl ?? true);
      setNoiseSuppression(getSettings().noiseSupression ?? "browser");
      restartTrack();
    });

    // Keep local monitoring of our own soundboard sounds in line with settings
    createEffect(() => {
      const soundboard = this.soundboard();
      if (!soundboard) return;

      const settings = getSettings();
      const muted = settings.soundboardMuted || settings.deafen;
      soundboard.setMonitorVolume(
        muted
          ? 0
          : perceptualGain(settings.soundboardVolume) *
              perceptualGain(settings.outputVolume),
      );
    });

    createEffect(() => {
      this.soundboard()?.setSinkId(getSettings().preferredAudioOutputDevice);
    });
  }

  async connect(channel: Channel, auth?: { url: string; token: string }) {
    this.disconnect();

    this.device.setWakeLocked();

    const room = new Room({
      // livekit-client defaults this to false. It force-enables it at
      // publish time whenever a track's resolved primary video codec
      // differs from its backup codec (LocalParticipant.publish, "multi-codec
      // simulcast requires dynacast") -- which `screenSharePublishOptions`
      // above triggers for most screen shares (vp9/h264 primary against a
      // vp8/h264 backup), but NOT when the primary codec itself resolves to
      // plain vp8 (matches the vp8 backup, so the mismatch check is false),
      // and NOT for camera publishes, which go through `setCameraEnabled`
      // with livekit-client's own `publishDefaults` (videoCodec: 'vp8',
      // backupCodec: true -> {codec: 'vp8'} -- same codec, same gap). Setting
      // it explicitly here closes both gaps instead of relying on an
      // incidental codec-mismatch side effect. Does NOT enable
      // `adaptiveStream` -- that stays off; see the perf-plan decisions.
      dynacast: true,
      audioCaptureDefaults: {
        deviceId: this.#settings.preferredAudioInputDevice,
        echoCancellation: this.#settings.echoCancellation,
        noiseSuppression: this.#settings.noiseSupression === "browser",
        autoGainControl: this.#settings.autoGainControl,
        voiceIsolation: this.#settings.noiseSupression === "browser",
      },
      audioOutput: {
        deviceId: this.#settings.preferredAudioOutputDevice,
      },
      videoCaptureDefaults: {
        resolution: {
          width: 1280,
          height: 720,
          frameRate: 30,
        },
        deviceId: this.#settings.preferredVideoDevice,
      },
    });

    createRoot((dispose) => {
      this.#disposeVidTracks = dispose;
      this.vidTracks = useTracks(
        [
          { source: Track.Source.Camera, withPlaceholder: true },
          { source: Track.Source.ScreenShare, withPlaceholder: false },
        ],
        { room, onlySubscribed: false },
      );
    });

    batch(() => {
      this.#setRoom(room);
      this.#setChannel(channel);
      this.#setState("CONNECTING");
      this.#setVideo(false);
      this.#setScreenshare(false);
      this.#setScreenShareState("idle");
      this.#setSoundboard(new SoundboardPlayer(room));
    });

    room.addListener("connected", () => {
      this.#setState("CONNECTED");
      if (this.speakingPermission)
        this.#setMicEnabled(room, this.#settings.micOn).then((track) => {
          this.#settings.micOn = track != null;
        });
      for (const p of room.remoteParticipants.values()) {
        const screenShareTrack = p.getTrackPublication(
          Track.Source.ScreenShare,
        );
        if (screenShareTrack) {
          this.screenShareTracks.add(screenShareTrack.trackSid);
        }
      }
      this.sound.playSound("userJoinVoice");
      // Only here, not the constructor: `this.limits()` (from `useInstance`)
      // isn't populated yet at construction, so priming earlier could probe
      // the wrong resolution for an instance that hasn't granted 1080p.
      this.#primeScreenShareCodec();
    });

    // This fires ONLY for a drop the user did not ask for: `disconnect()`
    // (below) calls `room.removeAllListeners()` before `room.disconnect()`,
    // so a deliberate leave (or a channel switch, which tears down through
    // the same path via `connect()`'s own `this.disconnect()` call) unhooks
    // this listener before it ever gets the chance to fire. No
    // `DisconnectReason.CLIENT_INITIATED` special-case is needed to tell
    // "we meant to do that" apart from "something went wrong" -- the
    // listener's absence already does that job.
    room.addListener("disconnected", (reason) => {
      // Deliberately not awaited here: a LiveKit event callback must stay
      // synchronous, and #handleUnexpectedDisconnect's own try/catch
      // already accounts for connect()'s rejection (its `Promise.any` node
      // probe throws if every node fails) -- nothing here can throw past
      // that, so there is no unhandled rejection to worry about.
      void this.#handleUnexpectedDisconnect(reason);
    });

    // A media/signal reconnect attempt in progress -- see RoomEvent.Reconnecting
    // in livekit-client. Screen share recovery (#recoverScreenShare) is a
    // separate concern (a dead capture, not a dead connection), so this only
    // drives the existing RECONNECTING UI state.
    room.addListener("reconnecting", () => {
      console.warn("[rtc] room reconnecting");
      this.#setState("RECONNECTING");
    });

    room.addListener("reconnected", () => {
      console.info("[rtc] room reconnected");
      this.#setState("CONNECTED");
    });

    room.addListener("localTrackPublished", (pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        // LiveKit's `republishAllTracks` (run on a full reconnect via
        // `handleSignalRestarted`) unpublishes and republishes the screen
        // share, creating a brand new `LocalTrackPublication` backed by a
        // fresh sender configured only from `pub.options` -- so
        // `scaleResolutionDownBy` is back to 1 (full capture size, e.g. a
        // 3440x1440 ultrawide going out uncapped) and the old publication's
        // "ended" listener is orphaned on an object nothing will ever touch
        // again. Both need to be redone on the new publication, and this is
        // the only hook that runs on that path -- nothing else observes a
        // signal-restart republish.
        //
        // This also fires on two other, harmless paths:
        //  - The *initial* publish from `toggleScreenshare`, which arms the
        //    listener itself once `setScreenShareEnabled` resolves
        //    (`#armScreenShareEnded` is idempotent per publication, so
        //    re-arming here first is a no-op) and applies the chosen
        //    quality afterwards. `#lastShareChoice` is only ever written by
        //    `#applyShareChoice`, so it is still unset here and there is
        //    nothing yet to re-apply.
        //  - `#recoverScreenShare`'s own republish, where `#lastShareChoice`
        //    *is* already set, to the choice recovery is restoring -- so
        //    this runs early and redundantly, moments before
        //    `#recoverScreenShare` calls `#applyShareChoice` with that same
        //    choice. Both compute the same scale factor from the same live
        //    track, so the duplicate work is harmless.
        this.#armScreenShareEnded(room, pub);

        const choice = this.#lastShareChoice;
        if (choice) {
          // Same fallback `#applyShareChoice` uses: `choice.qualityName` was
          // valid when the share started, but the enabled set is a function
          // of `this.limits()` and could theoretically have shrunk since.
          // Warn rather than silently skipping if even "low" -- which
          // `getEnabledScreenShareQualities` always enables -- comes back
          // missing, since that would mean this PR's whole fix quietly did
          // not run.
          const qualities = this.getEnabledScreenShareQualities();
          const quality = qualities[choice.qualityName] || qualities.low!;
          if (quality) {
            void this.#applyEncoderLimits(pub, quality.resolution);
          } else {
            console.warn(
              "[rtc] no screen share quality available to re-apply encoder limits after republish",
            );
          }
        }
      }

      if (
        pub.audioTrack &&
        pub.audioTrack.source === Track.Source.Microphone &&
        !isSoundboardPublication(pub)
      ) {
        if (!pub.audioTrack.getProcessor()) {
          pub.audioTrack?.setProcessor(
            (this.voiceProcessor = new VoiceProcessor(this.#settings)),
          );
        }

        this.#meterLocalMicrophone(room, pub);
      }
    });

    room.addListener("localTrackUnpublished", (pub) => {
      if (
        pub.source === Track.Source.Microphone &&
        !isSoundboardPublication(pub)
      ) {
        this.#localSpeakingMeter?.();
        this.#localSpeakingMeter = undefined;
      }
    });

    room.addListener("participantConnected", () => {
      this.sound.playSound("userJoinVoice");
    });

    room.addListener("participantDisconnected", () => {
      this.sound.playSound("userLeaveVoice");
    });

    room.addListener("trackPublished", (pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        pub.once("subscribed", (track) => {
          // Play the sound once playback starts, which might be quite a bit after subscription
          // as it starts paused for the screen share settings modal.
          track.once("videoPlaybackStarted", () => {
            this.sound.playSound("streamStart");
            if (track.sid) {
              this.screenShareTracks.add(track.sid);
            }
          });
        });
      }
    });

    room.addListener("trackUnpublished", (unpub) => {
      if (this.screenShareTracks.has(unpub.trackSid)) {
        this.sound.playSound("streamEnd");
        this.screenShareTracks.delete(unpub.trackSid);
      }
    });

    // Gather latency
    const selected = await Promise.any(
      this.config.features.livekit.nodes.map(async (node) => {
        return fetch(node.public_url.replace("wss", "https")).then(() => {
          return node.name;
        });
      }),
    );

    if (!auth) {
      auth = await channel.joinCall(selected);
    }

    await room.connect(auth.url, auth.token, {
      autoSubscribe: false,
    });
  }

  disconnect() {
    this.device.releaseWakeLock();
    try {
      const room = this.room();
      if (!room) return;

      this.soundboard()?.dispose();

      this.#localSpeakingMeter?.();
      this.#localSpeakingMeter = undefined;

      this.#lastShareChoice = undefined;
      this.#recoveryAttempts = [];
      this.#armedShareEndedPublication = undefined;
      this.#armedScreenShareUpstreamTrack = undefined;
      this.#browserReacquireAttempted = false;
      this.#stopReacquireBackoff();

      room.removeAllListeners();
      room.disconnect();

      this.#disposeVidTracks?.();
      this.#disposeVidTracks = undefined;

      batch(() => {
        this.#setState("READY");
        this.#setRoom();
        this.#setChannel();
        this.#setFullscreen(false);
        this.#setSoundboard();
        this.vidTracks = () => [];
      });

      this.screenShareTracks = new Set();

      this.sound.playSound("userLeaveVoice");
    } catch (e) {
      this.onErr(e);
    }
  }

  /**
   * Handles `room`'s `"disconnected"` event -- the whole unexpected-drop
   * path (a deliberate leave never reaches this listener at all; see the
   * comment where it is attached in {@link connect}). Before this existed,
   * an unexpected LiveKit disconnect left the client in a zombie state
   * indefinitely: wake lock held, listeners attached to a dead `Room`, and
   * the call card still mounted with controls that operated on nothing.
   *
   * Order of operations matters and is deliberate:
   *
   * 1. Capture `channel()` *before* tearing down -- {@link disconnect}
   *    clears it.
   * 2. Always tear down via {@link disconnect}, whether or not a rejoin
   *    follows -- this is what releases the wake lock, detaches the dead
   *    room's listeners, drops the call card back to "not in a call", and
   *    (as a side effect of reusing `disconnect()` rather than duplicating
   *    it) plays `userLeaveVoice`, which doubles as this path's "make it
   *    perceptible" signal -- there is no dedicated error/disconnect sound
   *    asset in `public/assets/sounds/`, and this is the only suitable
   *    existing one.
   * 3. Only *then* decide whether to rejoin, via the existing `connect()` --
   *    not a bespoke reconnect -- because the LiveKit token from
   *    `channel.joinCall()` is single-use and may already be expired, and
   *    `connect()` is what re-fetches a fresh one.
   *
   * `reason` is classified into terminal (never rejoin: the server evicted
   * or removed *this exact* session on purpose, and rejoining would just
   * fight whatever caused that) versus recoverable (everything else,
   * including `undefined`) -- see {@link TERMINAL_DISCONNECT_REASONS}.
   * Recoverable attempts are bounded by {@link MAX_DISCONNECT_RECOVERIES}
   * within {@link DISCONNECT_RECOVERY_WINDOW_MS}, the same sliding-window
   * idiom {@link #recoveryAttempts} already uses for screen-share recovery,
   * kept as a separate counter so the two budgets cannot exhaust each
   * other.
   *
   * Every branch reports through the snackbar so the user is actually told
   * what happened -- the only surface that used to change at all was a
   * low-contrast grey caption in the call card's control strip (see
   * `VoiceCallCardStatus.tsx`), invisible unless you were already looking
   * at it.
   */
  async #handleUnexpectedDisconnect(reason: DisconnectReason | undefined) {
    const reasonName = describeDisconnectReason(reason);

    // console.error (level 3) is what for-desktop's `window.ts` forwards
    // into `app-audio.log` -- this alone persists the reason with no new
    // IPC and no preload change, and it works identically on plain web via
    // devtools. This is the first deliverable: the reason was previously
    // discarded entirely, which is why the drop that prompted this fix was
    // undiagnosable.
    console.error(
      `[rtc] room disconnected unexpectedly (reason: ${reasonName})`,
    );

    // Capture before disconnect() clears channel() to undefined.
    const channel = this.channel();

    // Always run teardown, rejoin or not -- see the doc comment above for
    // why this must happen before the rejoin decision, not after it.
    this.disconnect();

    // Nothing to rejoin into. Shouldn't happen in practice -- a
    // "disconnected" event implies connect() had previously set a channel
    // -- but keeps this method total rather than assuming it.
    if (!channel) return;

    if (reason !== undefined && TERMINAL_DISCONNECT_REASONS.has(reason)) {
      this.snackbar.show({
        message: `Disconnected from voice: ${reasonName}. Not rejoining automatically.`,
        closeable: true,
      });
      return;
    }

    const now = Date.now();
    this.#disconnectRecoveryAttempts = this.#disconnectRecoveryAttempts.filter(
      (at) => now - at < DISCONNECT_RECOVERY_WINDOW_MS,
    );
    if (this.#disconnectRecoveryAttempts.length >= MAX_DISCONNECT_RECOVERIES) {
      console.warn("[rtc] voice keeps dropping, giving up on automatic rejoin");
      this.snackbar.show({
        message: `Disconnected from voice: ${reasonName}. Giving up after repeated drops -- rejoin manually.`,
        closeable: true,
      });
      return;
    }
    this.#disconnectRecoveryAttempts.push(now);

    this.snackbar.show({
      message: `Disconnected from voice: ${reasonName}. Attempting to rejoin...`,
      closeable: true,
    });

    try {
      await this.connect(channel);
    } catch (err) {
      console.error("[rtc] automatic voice rejoin failed", err);
      // Guard against a rejoin racing a user action: if the user left again
      // or switched to a different channel while this connect() call was in
      // flight, channel() will no longer be the one we captured above, and
      // reporting *this* attempt's failure would be misleading -- whatever
      // the user did since is what actually determines their state now.
      if (this.channel() !== channel) return;
      this.snackbar.show({
        message: "Could not rejoin voice automatically.",
        replaceActive: true,
        closeable: true,
      });
      return;
    }

    // Same race guard as the catch branch above, for the success path.
    if (this.channel() !== channel) return;
    this.snackbar.show({
      message: "Reconnected to voice.",
      replaceActive: true,
      closeable: true,
    });
  }

  async toggleDeafen(fromMute?: boolean) {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await this.#setMicEnabled(
        room,
        (this.#settings.micOn || !!fromMute) && !this.#isMicEnabled(room),
      );

      this.#settings.deafen = !this.#settings.deafen;
      if (fromMute) {
        this.#settings.micOn = this.#isMicEnabled(room);
      }
      if (this.#settings.deafen) {
        this.sound.playSound("deafen");
      } else {
        this.sound.playSound("undeafen");
      }
    } catch (e) {
      this.onErr(e);
    }
  }

  async toggleMute() {
    if (this.#settings.deafen) {
      this.toggleDeafen(true);
      return;
    }
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await this.#setMicEnabled(room, !this.#isMicEnabled(room));

      this.#settings.micOn = this.#isMicEnabled(room);

      if (this.#settings.micOn) {
        this.sound.playSound("unmute");
      } else {
        this.sound.playSound("mute");
      }
    } catch (e) {
      this.onErr(e);
    }
  }

  async toggleCamera() {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setCameraEnabled(
        !room.localParticipant.isCameraEnabled,
      );

      this.#setVideo(room.localParticipant.isCameraEnabled);
    } catch (e) {
      this.#onCameraErr(e);
    }
  }

  /**
   * Surface a camera acquisition failure.
   *
   * `onErr`'s `NotAllowedError`/`AbortError` exclusion does not apply here.
   * That exclusion exists so dismissing the *screen-share* picker doesn't
   * raise an error modal (see `toggleScreenshare`'s catch), but those same
   * names are exactly what a denied camera permission or an aborted
   * `getUserMedia` request produce -- which is why enabling the camera used
   * to silently do nothing with no error at all: `onErr` was throwing the
   * one error a permission denial produces.
   * @param e Whatever `setCameraEnabled` rejected with
   */
  #onCameraErr(e: unknown) {
    const name = (e as Error)?.name;
    console.warn("[rtc] camera acquisition failed", e);

    let message: string | undefined;
    switch (name) {
      case "NotAllowedError":
        message = "Camera permission was denied.";
        break;
      case "NotFoundError":
        message = "No camera was found.";
        break;
      case "NotReadableError":
        message =
          "The camera could not be started -- it may already be in use by another application.";
        break;
    }

    this.openModal({
      type: "error2",
      error: message ? new Error(message) : e,
    });
  }

  /**
   * Get the enabled screen share qualities. "low" will always be enabled.
   * Each screen share quality is checked against the limit if the limit is available on the client.
   *
   * TODO: Translate the fullNames here, I can't figure out how to do it.
   *
   * @param name The name of the screen share quality to get
   * @returns A partial record of ScreenShareQualityName to ScreenShareQuality. Will always contain "low" quality.
   */
  /**
   * Resolve the configured quality, healing settings that were saved while the
   * removed "text" option still existed.
   *
   * Falls back to the closest *enabled* quality rather than jumping straight
   * to "low" when the saved one isn't offered here (e.g. this instance's
   * video_resolution limit is lower than it was when the setting was saved).
   * Walks {@link ScreenShareQualityNames} backward from the saved choice --
   * it's declared low to high -- so a saved "high60" that isn't enabled lands
   * on "high" if that is enabled, and only falls all the way to "low" if
   * nothing in between is either. "low" is always enabled, so the loop always
   * has somewhere to land.
   */
  #screenShareQuality(): ScreenShareQualityName {
    const saved = this.#settings.screenShareQuality;
    const qualities = this.getEnabledScreenShareQualities();

    if (saved && qualities[saved]) return saved;

    const savedIndex = saved ? ScreenShareQualityNames.indexOf(saved) : -1;
    for (let i = savedIndex - 1; i >= 0; i--) {
      const name = ScreenShareQualityNames[i];
      if (qualities[name]) return name;
    }

    return "low";
  }

  getEnabledScreenShareQualities(): Partial<
    Record<ScreenShareQualityName, ScreenShareQuality>
  > {
    // Always enable low
    const qualities: Partial<
      Record<ScreenShareQualityName, ScreenShareQuality>
    > = {
      low: {
        name: "low",
        resolution: ScreenSharePresets.h720fps30.resolution,
        fullName: `720p 30FPS`,
        contentHint: "motion",
      },
    };

    const limit = this.limits().video_resolution;

    // TODO: Add more resolutions to stream from if they're enabled. May tie into premium users in the future?
    if (
      (limit[0] === 0 || limit[0] >= 1920) &&
      (limit[1] === 0 || limit[1] >= 1080)
    ) {
      qualities.high = {
        name: "high",
        resolution: ScreenSharePresets.h1080fps30.resolution,
        fullName: `1080p 30FPS`,
        contentHint: "motion",
      };

      // LiveKit has no 60fps screen-share preset -- ScreenSharePresets stops
      // at h1080fps30 -- so this one is hand-built to match the same
      // VideoResolution shape the presets above use.
      //
      // Offered ungated, on every platform, by deliberate product decision:
      // 60fps is only actually reachable on Windows window shares through the
      // native GPU capture path in for-desktop, which does not run through
      // Chromium's capture governor. Everywhere else (other platforms, or a
      // whole-screen share even on Windows) this raises the bitrate ceiling
      // (see screenShareEncoding) without the capture pipeline producing any
      // extra frames to spend it on -- see #watchForWeakLink for the
      // mitigation.
      qualities.high60 = {
        name: "high60",
        resolution: { width: 1920, height: 1080, frameRate: 60 },
        fullName: `1080p 60FPS`,
        contentHint: "motion",
      };

      // The upstream "Source 5FPS" option lived here. It is deliberately gone:
      // it shares this 1080p-capable branch, so raising an instance's
      // video_resolution limit silently added a 5 fps mode that is easy to
      // pick by accident and looks broken when you do.
    }

    return qualities;
  }

  /**
   * The offered qualities as `{ name, fullName }` pairs, for the two modals
   * that let the user pick one (the native screen picker and the "always
   * ask" settings dialog).
   *
   * Walks {@link ScreenShareQualityNames} rather than
   * `Object.keys(qualities)`: that keeps the list typed as
   * `ScreenShareQualityName` end to end (no `as ScreenShareQualityName` cast
   * at the call site) and keeps the order the one declared here rather than
   * object key insertion order.
   */
  #screenShareQualityOptions(): {
    name: ScreenShareQualityName;
    fullName: string;
  }[] {
    const qualities = this.getEnabledScreenShareQualities();
    return ScreenShareQualityNames.filter((name) => qualities[name]).map(
      (name) => ({ name, fullName: qualities[name]!.fullName }),
    );
  }

  /**
   * Warm the codec probe for every enabled screen-share quality, not just
   * the one currently configured, without anyone waiting on it -- so the
   * first real `toggleScreenshare` call finds an already-cached decision no
   * matter which quality it ends up publishing at, instead of eating the
   * probe's latency for whichever one was not primed.
   *
   * Primed one quality at a time rather than all at once. `screenShareCodec`
   * already fans a single quality's probe out to four parallel
   * `encodingInfo` calls (see its doc comment); firing all enabled qualities
   * (up to three -- low/high/high60) together would mean up to twelve
   * simultaneous GPU capability queries the moment the room connects,
   * stacked on top of everything else the client is doing at startup, for no
   * wall-clock benefit since nothing here is awaited by a caller anyway.
   * Sequencing keeps the burst to four probes in flight at a time.
   * `screenShareCodec` caches each quality under its own resolution/
   * framerate key, so nothing about the eventual cache depends on the order
   * they were primed in -- only the first `toggleScreenshare` for a
   * not-yet-primed quality still has to wait its turn.
   */
  #primeScreenShareCodec() {
    const qualities = this.getEnabledScreenShareQualities();
    const resolutions = ScreenShareQualityNames.filter(
      (name) => qualities[name],
    ).map((name) => qualities[name]!.resolution);

    void (async () => {
      for (const resolution of resolutions) {
        await screenShareCodec(resolution);
      }
    })();
  }

  async toggleScreenshare() {
    const room = this.room();
    if (!room) throw "invalid state";

    if (this.screenshare()) {
      // Deliberately stopping means there is nothing left to recover.
      await this.#endScreenShare(room);
    } else {
      const qualities = this.getEnabledScreenShareQualities();
      let screenPickerQualityName: ScreenShareQualityName | undefined;
      let screenPickerAudio: boolean | undefined;

      // The desktop picker answers a cancel with `callback({})`, which
      // getDisplayMedia rejects with something other than NotAllowedError, so
      // the generic error modal used to pop up on a plain "never mind".
      let cancelled = false;

      // Register the modal on screen picker handler if it exists
      if (window.native && window.native.onceScreenPicker) {
        window.native.onceScreenPicker((sources) => {
          this.openModal({
            type: "screen_share_picker",
            onCancel: () => {
              cancelled = true;
              window.native.screenPickerCallback(-1, false);
            },
            callback: (
              idx: number,
              qualityName: ScreenShareQualityName,
              audio: boolean,
            ) => {
              window.native.screenPickerCallback(idx, audio);
              screenPickerQualityName = qualityName;
              screenPickerAudio = audio;
            },
            sources: sources,
            qualities: this.#screenShareQualityOptions(),
          });
        });
      }

      try {
        // The picker can still change this, but capturing at the saved quality
        // avoids capturing at one resolution/bitrate and then immediately
        // re-publishing at another once the dialog resolves.
        const startingQuality =
          qualities[this.#screenShareQuality()] ?? qualities.low!;

        // Computed before setScreenShareEnabled so the codec decision it
        // made is available for the post-publish software-fallback check
        // below without depending on nothing else having probed a different
        // resolution in between.
        const publishOptions = await screenSharePublishOptions(
          startingQuality.resolution,
        );
        const codecDecision = getScreenShareCodecDecision();

        // Deliberately no `resolution` below: see the comment on
        // setNextScreenShareFrameRate (screenShareCapture.ts) and the
        // getDisplayMedia wrapper in index.ts for why the framerate still
        // has to be threaded in separately once resolution is gone.
        setNextScreenShareFrameRate(startingQuality.resolution.frameRate ?? 30);
        let localTrack: LocalTrackPublication | undefined;
        try {
          localTrack = await room.localParticipant.setScreenShareEnabled(
            true,
            {
              audio: SCREEN_SHARE_AUDIO,
              // Browser-only (returns `{}` on desktop, leaving this
              // byte-identical to before): see screenShareSurface.ts for
              // why `video.displaySurface` and `systemAudio` live here
              // rather than in the getDisplayMedia wrapper in index.ts.
              ...browserCaptureOptions({
                screenShareQualityAsk: this.#settings.screenShareQualityAsk,
                screenShareAudio: this.#settings.screenShareAudio,
              }),
            },
            publishOptions,
          );
        } finally {
          setNextScreenShareFrameRate(undefined);
        }

        const screenAudioTrack = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio,
        );

        // `risk === "none"` on desktop unconditionally -- see
        // classifyCapturedSurface's doc comment.
        const { displaySurface, risk: surfaceRisk } = classifyCapturedSurface(
          localTrack?.videoTrack?.mediaStreamTrack,
          !!screenAudioTrack,
        );

        this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

        if (localTrack) {
          this.#armScreenShareEnded(room, localTrack);
          this.#watchForSoftwareFallback(localTrack, codecDecision);

          const callback = (
            qualityName: ScreenShareQualityName,
            audio: boolean,
          ) => this.#applyShareChoice(room, localTrack, qualityName, audio);

          if (screenPickerQualityName) {
            callback(
              screenPickerQualityName || "low",
              screenPickerAudio || false,
            );
          } else if (
            this.#settings.screenShareQualityAsk ||
            surfaceRisk === "leak"
          ) {
            // "Don't ask me about quality" (screenShareQualityAsk === false)
            // is not consent to broadcast every sound on the machine -- a
            // confirmed `"leak"` forces this dialog open regardless. Those
            // users (who skip this dialog by choice, and would otherwise
            // silently get `screenShareAudio`'s saved default applied via
            // the `else` branch below) are exactly who this needs to
            // reach.
            //
            // No longer gated on there being more than one quality to choose
            // from: even with a single preset (an instance whose
            // video_resolution limit sits below 1080p) this dialog is still
            // the only place to toggle share audio at share time and to set
            // "Don't ask me again" -- losing it there would silently remove
            // both. Form2.ButtonGroup renders fine with one pre-selected
            // button.
            //
            // Concurrent, not sequential, and audio first: video and audio
            // are separate LocalTrack objects with their own
            // pauseUpstreamLock mutex (livekit-client's
            // LocalTrack.pauseUpstream/LocalTrackPublication.pauseUpstream),
            // so they never contended -- awaiting video before starting
            // audio's call only delayed audio, which is the actual leak
            // vector, for no benefit. Promise.allSettled so a thrown
            // DeviceUnsupportedError from either (pauseUpstream flips
            // `_isUpstreamPaused` to true before it can throw) cannot skip
            // the other's call or escape into this method's catch. This
            // still runs after publish -- audio was already live for a few
            // tens of ms before this point regardless, and closing that
            // window fully needs the deferred acquire-then-publish
            // restructure, not this.
            await Promise.allSettled([
              screenAudioTrack?.pauseUpstream(),
              localTrack.pauseUpstream(),
            ]);
            this.openModal({
              onCancel: async () => {
                cancelled = true;
                await room.localParticipant.setScreenShareEnabled(false);
                this.#setScreenshare(
                  room.localParticipant.isScreenShareEnabled,
                );
              },
              type: "screen_share_settings",
              trackReference: {
                participant: room.localParticipant,
                publication: localTrack,
                source: Track.Source.ScreenShare,
              },
              qualities: this.#screenShareQualityOptions(),
              audio: !!screenAudioTrack,
              surfaceRisk,
              displaySurface,
              callback: async (qualityName, audio) => {
                callback(qualityName, audio);
                localTrack.resumeUpstream();
                if (audio) {
                  screenAudioTrack?.resumeUpstream();
                }
              },
            });
          } else {
            // "Always ask" off and no native picker: nothing used to apply the
            // saved quality or honour the audio preference at all.
            callback(
              this.#screenShareQuality(),
              this.#settings.screenShareAudio,
            );
          }
        }
      } catch (e) {
        if (cancelled) return;
        // NotAllowedError is the spec cancel; Firefox/Safari answer a
        // dismissed picker with AbortError. Neither is worth an error modal
        // here -- but this exclusion is scoped to the screen-share path via
        // `ignoreNames`, not baked into `onErr` itself, precisely so
        // `toggleCamera` (which shares `onErr`) still surfaces the same
        // error names when they mean a denied camera permission instead.
        this.onErr(e, ["NotAllowedError", "AbortError"]);
      }
    }
  }

  /**
   * Apply a quality/audio choice to a live screen share and remember it.
   * @param room Room
   * @param localTrack Screen share publication
   * @param qualityName Chosen quality
   * @param audio Whether the share's audio should be kept
   * @param announce Whether to play the "stream started" sound
   */
  /**
   * Bring the encoder in line with a quality chosen *after* publishing.
   *
   * Publish options are fixed when the track goes up, from the saved quality,
   * while the "always ask" dialog only re-applied capture constraints. The two
   * could therefore disagree: switching quality mid-share left the sender's
   * old `maxBitrate`/`maxFramerate` in place, so the change never actually
   * reached the encoder.
   *
   * Also owns `scaleResolutionDownBy`: capture no longer asks for a
   * resolution (see `toggleScreenshare`/`#recoverScreenShare`), so the
   * capturer is free to hand the encoder whatever the source's actual size
   * is, and this is where that gets scaled down to the chosen quality
   * instead -- on the encoder, where a hardware H.26x makes it nearly free,
   * rather than as a libyuv rescale on Chromium's throttled capture thread.
   * This runs on every call, not just at publish, and is read fresh each
   * time rather than cached, precisely so a mid-share quality change (via
   * `#applyShareChoice`, which re-reads the live track's settings every time
   * it runs) recomputes it against the new target instead of the one the
   * share started with.
   *
   * `#applyShareChoice` is no longer the only caller: the `localTrackPublished`
   * handler in `connect()` also calls this directly, without going through
   * `#applyShareChoice`, to re-apply the last chosen quality after LiveKit
   * republishes the share on a full reconnect -- see that handler for why.
   *
   * The `maxFramerate` half used to be a no-op: every preset ran at 30fps, so
   * this only ever wrote back the value that was already there. That premise
   * is gone now that `high60` exists (see `ScreenShareQualityName`) --
   * switching into or out of it mid-share genuinely changes the encoder's
   * framerate ceiling, which is exactly the mechanism this was kept around
   * for.
   * @param localTrack Screen share publication
   * @param resolution Resolution/framerate the user actually chose
   */
  async #applyEncoderLimits(
    localTrack: LocalTrackPublication,
    resolution: VideoResolution,
  ) {
    const sender = localTrack.videoTrack?.sender;
    if (!sender?.getParameters) return;

    // The capturer's actual output, now that capture no longer requests a
    // resolution -- may be larger (a 4K monitor, or a 21:9 ultrawide) or
    // smaller (a small window) than what was asked for.
    const captured = localTrack.videoTrack?.mediaStreamTrack.getSettings();
    const scaleResolutionDownBy = screenShareScaleFactor(
      captured ?? {},
      resolution,
    );

    console.info(
      `[rtc] screen share encoder limits: captured ${captured?.width ?? "?"}x${captured?.height ?? "?"} -> target ${resolution.width}x${resolution.height} (scaleResolutionDownBy ${scaleResolutionDownBy.toFixed(3)})`,
    );

    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;

      const { maxBitrate, maxFramerate } = screenShareEncoding(resolution);

      let changed = false;

      for (const encoding of params.encodings) {
        if (encoding.maxFramerate !== maxFramerate) {
          encoding.maxFramerate = maxFramerate;
          changed = true;
        }

        if (encoding.scaleResolutionDownBy !== scaleResolutionDownBy) {
          encoding.scaleResolutionDownBy = scaleResolutionDownBy;
          changed = true;
        }

        // Only touch the bitrate when there is a single encoding. Simulcast
        // layers carry deliberately different ceilings and must not all be
        // flattened to the top one; screen shares publish with `simulcast:
        // false` (our case), so there is exactly one.
        if (
          params.encodings.length === 1 &&
          encoding.maxBitrate !== maxBitrate
        ) {
          encoding.maxBitrate = maxBitrate;
          changed = true;
        }
      }

      if (changed) await sender.setParameters(params);
    } catch (err) {
      // Not fatal: the share is up, it is just capped where it was published.
      // The factor is included so a `setParameters` rejection (e.g. a value
      // under 1.0, which is a RangeError) is diagnosable from the log alone.
      console.warn(
        `[rtc] could not update screen share encoder limits (scaleResolutionDownBy ${scaleResolutionDownBy.toFixed(3)})`,
        err,
      );
    }
  }

  async #applyShareChoice(
    room: Room,
    localTrack: LocalTrackPublication,
    qualityName: ScreenShareQualityName,
    audio: boolean,
    announce = true,
  ) {
    const qualities = this.getEnabledScreenShareQualities();
    const quality = qualities[qualityName] || qualities.low!;

    this.#lastShareChoice = { qualityName, audio };

    if (!localTrack.videoTrack) return;

    await localTrack.videoTrack.mediaStreamTrack.applyConstraints({
      // `ideal` as well as `max`: asking only for a ceiling lets the source
      // stay wherever it started rather than being pinned down to it, which
      // matters when `setNextScreenShareFrameRate` only covered the initial
      // `getDisplayMedia` and a mid-share quality change needs to actually
      // move the source's framerate too.
      //
      // Still deliberately no `width`/`height` on the plain-browser path:
      // constraining capture resolution there forces a full-frame libyuv
      // rescale on Chromium's capture thread even when the source was
      // already smaller, and Chromium's capture governor
      // (`capture_period = max(2 x last_capture_duration, 1/target_fps)`)
      // doubles the cost of anything that runs there.
      // `#applyEncoderLimits`'s `scaleResolutionDownBy` controls output
      // resolution on the encoder instead, where it's nearly free with
      // hardware H.26x.
      frameRate: {
        ideal: quality.resolution.frameRate,
        max: quality.resolution.frameRate,
      },
      // On the desktop app only: `applyConstraints` here is not a real
      // track constraint at all -- the injected page patch intercepts it on
      // for-desktop's native generator track, reads `width`/`height` (same
      // as it already does for `frameRate`, see `screenShareEncoding`'s doc
      // comment) and forwards them over IPC to the native Windows capturer's
      // `setTarget()`, which makes the GPU produce the preset resolution
      // directly instead of capturing a fixed 1920x1080 box and leaning on
      // `scaleResolutionDownBy` to shrink it per frame on the encoder queue.
      // None of the browser cost above applies there -- the browser never
      // sees a constraint on the (fake) track -- so this is gated on
      // `isNativeDesktop()` rather than sent unconditionally.
      ...(isNativeDesktop()
        ? {
            width: {
              ideal: quality.resolution.width,
              max: quality.resolution.width,
            },
            height: {
              ideal: quality.resolution.height,
              max: quality.resolution.height,
            },
          }
        : {}),
    });

    localTrack.videoTrack.mediaStreamTrack.contentHint = quality.contentHint;

    await this.#applyEncoderLimits(localTrack, quality.resolution);

    // Only high60 raises the bitrate ceiling without the capture pipeline
    // necessarily producing any more frames to spend it on -- see
    // getEnabledScreenShareQualities and #watchForWeakLink.
    if (qualityName === "high60") {
      this.#watchForWeakLink(
        localTrack,
        screenShareEncoding(quality.resolution).maxBitrate,
      );
    }

    if (!audio) {
      const screenAudioTrack = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShareAudio,
      );
      if (screenAudioTrack?.track) {
        room.localParticipant.unpublishTrack(screenAudioTrack.track);
      }
    }

    if (announce) this.sound.playSound("streamStart");
  }

  /**
   * Public entry point for changing quality/audio on a screen share that is
   * already running, with no stop/start cycle.
   *
   * This is a thin wrapper: `#applyShareChoice` already does the actual work
   * (`applyConstraints({ frameRate })`, `contentHint`, and the live
   * `sender.setParameters` in `#applyEncoderLimits`) and is written to be
   * safely re-run mid-share -- it just had no public entry point before this.
   * `announce = false` because this is not a new share, so there is nothing
   * to play the "stream started" sound for.
   *
   * No-ops if there is no live screen-share publication, so callers (the
   * context menu, the settings modal's callback) do not need to re-check
   * `screenshare()` themselves. Also no-ops while a source change
   * (`changeScreenShareSource`) is in flight: that call's own teardown and
   * republish would otherwise race this one over the same publication.
   * @param qualityName Chosen quality
   * @param audio Whether the share's audio should be kept -- can only
   * unpublish, never add audio to a share that started without it
   */
  async changeScreenShareQuality(
    qualityName: ScreenShareQualityName,
    audio: boolean,
  ) {
    const room = this.room();
    if (!room || this.#recovering) {
      console.warn(
        "[rtc] changeScreenShareQuality: ignored (not connected, or a source change is in progress)",
      );
      return;
    }

    const localTrack = room.localParticipant.getTrackPublication(
      Track.Source.ScreenShare,
    );
    if (!localTrack) {
      console.warn("[rtc] changeScreenShareQuality: no live screen share");
      return;
    }

    await this.#applyShareChoice(room, localTrack, qualityName, audio, false);
  }

  /**
   * Open the same "Screen Share Settings" dialog offered when a share
   * starts, but for one that is already running.
   *
   * `ScreenShareSettings.tsx` needed no behaviour changes to support this,
   * only two additions: it already takes a live `TrackReference` and
   * renders a running preview from it, but it used to seed its initial
   * quality/audio from the *saved default* and always offered "Don't ask me
   * again" -- both right at share start, both wrong here. `#lastShareChoice`
   * -- what this share actually started with -- can disagree with the saved
   * default (a desktop-picker choice made at share start, or an earlier
   * edit), and "Don't ask me again" writes that saved default globally,
   * which a live edit has no business doing as a side effect. `initialXxx`
   * and `liveEdit` below are exactly those two additions.
   *
   * The `audio` flag mirrors `toggleScreenshare`'s own use of this modal --
   * whether there is a `ScreenShareAudio` publication to offer turning off,
   * since turning it *on* after the fact isn't possible (see
   * `changeScreenShareQuality`'s doc comment).
   *
   * No-ops when not sharing (or while a source change is in flight, which
   * would otherwise show a preview of a publication about to be torn down),
   * so the "Change quality" context menu item does not need to guard the
   * call itself.
   */
  openScreenShareQualitySettings() {
    const room = this.room();
    if (!room || this.#recovering) {
      console.warn(
        "[rtc] openScreenShareQualitySettings: ignored (not connected, or a source change is in progress)",
      );
      return;
    }

    const localTrack = room.localParticipant.getTrackPublication(
      Track.Source.ScreenShare,
    );
    if (!localTrack) {
      console.warn(
        "[rtc] openScreenShareQualitySettings: no live screen share",
      );
      return;
    }

    const screenAudioTrack = room.localParticipant.getTrackPublication(
      Track.Source.ScreenShareAudio,
    );

    this.openModal({
      type: "screen_share_settings",
      trackReference: {
        participant: room.localParticipant,
        publication: localTrack,
        source: Track.Source.ScreenShare,
      },
      qualities: this.#screenShareQualityOptions(),
      audio: !!screenAudioTrack,
      initialQualityName: this.#lastShareChoice?.qualityName,
      initialAudio: this.#lastShareChoice?.audio,
      liveEdit: true,
      // Nothing was paused/unpublished to open this dialog (unlike the
      // first-share flow in toggleScreenshare), so dismissing it undoes
      // nothing -- the share just keeps running as it was.
      onCancel: () => {},
      callback: (qualityName, audio) =>
        this.changeScreenShareQuality(qualityName, audio),
    });
  }

  /**
   * Self-healing check: a few seconds after publishing, sample the sender's
   * actual encoder once. If we picked h264/h265 because the probe said it
   * was hardware, but the browser handed us a software encoder anyway (a
   * driver update, a GPU process crash-and-restart onto software, or a
   * probe that was simply wrong), overwrite the cached decision for that
   * resolution with vp9 so the *next* share gets it right.
   *
   * Deliberately does not republish the live share -- swapping codecs
   * mid-share would drop the stream for a moment, which is far more
   * disruptive than one share running on an unexpectedly software encoder.
   * @param localTrack The just-published screen share publication
   * @param decision The codec decision that publish was made with
   */
  #watchForSoftwareFallback(
    localTrack: LocalTrackPublication,
    decision: ReturnType<typeof getScreenShareCodecDecision>,
  ) {
    if (!decision || decision.codec === "vp9") return;

    setTimeout(async () => {
      try {
        const sender = localTrack.videoTrack?.sender;
        if (!sender?.getStats) return;

        const report = await sender.getStats();
        let implementation: string | undefined;
        report.forEach((stat) => {
          if (stat.type === "outbound-rtp" && stat.kind === "video") {
            implementation = stat.encoderImplementation;
          }
        });

        if (implementation && /OpenH264|libvpx|libaom/i.test(implementation)) {
          console.warn(
            `[rtc] picked ${decision.codec} for ${decision.key} but got software encoder "${implementation}" -- forcing vp9 for the next share at this resolution`,
          );
          screenShareCodecDecisions.set(decision.key, {
            ...decision,
            codec: "vp9",
            reason: `${decision.reason}; corrected to vp9 after observing software encoder "${implementation}"`,
          });
        }
      } catch {
        // Best-effort: the share is already up either way.
      }
    }, SOFTWARE_FALLBACK_CHECK_DELAY_MS);
  }

  /**
   * A few seconds after applying a 1080p60 quality choice, check whether the
   * link can actually carry the bitrate ceiling that comes with it.
   *
   * Mirrors {@link Voice.#watchForSoftwareFallback}'s shape: sample
   * `getStats()` once on a delay and act on what it finds. high60 is the only
   * quality this runs for (see the call site in `#applyShareChoice`) because
   * it is the only one whose ceiling can rise with no extra frames to show
   * for it on a non-native capture path -- see getEnabledScreenShareQualities
   * -- which is exactly what makes a marginal uplink worse off for having
   * picked it: more bits chasing the same frame rate means more congestion,
   * not more motion.
   *
   * Surfaced through the existing `error2` modal (same pattern as
   * `#onCameraErr`, a plain `Error` with a human message rather than an API
   * error) and at most once per session -- this is advisory, not a failure,
   * so it should be seen once and then get out of the way rather than
   * reappearing on every share. `ScreenShareStats`'s "Weak link" row uses the
   * same {@link isScreenShareLinkWeak} check to stay visible for as long as
   * the share runs, without repeating the modal.
   * @param localTrack The publication the quality choice was just applied to
   * @param maxBitrate The encoder ceiling `high60` was just given
   */
  #watchForWeakLink(localTrack: LocalTrackPublication, maxBitrate: number) {
    if (weakLinkWarningShown) return;

    setTimeout(async () => {
      try {
        if (weakLinkWarningShown) return;

        const sender = localTrack.videoTrack?.sender;
        if (!sender?.getStats) return;

        const report = await sender.getStats();
        let availableOutgoingBitrate: number | undefined;
        let bandwidthLimitedSeconds: number | undefined;

        report.forEach((stat) => {
          if (stat.type === "candidate-pair" && stat.nominated) {
            availableOutgoingBitrate = stat.availableOutgoingBitrate;
          }
          if (stat.type === "outbound-rtp" && stat.kind === "video") {
            bandwidthLimitedSeconds =
              stat.qualityLimitationDurations?.bandwidth;
          }
        });

        if (
          !isScreenShareLinkWeak(
            maxBitrate,
            availableOutgoingBitrate,
            bandwidthLimitedSeconds,
          )
        ) {
          return;
        }

        weakLinkWarningShown = true;
        console.warn(
          `[rtc] screen share link looks too weak for the 1080p60 bitrate ceiling (${maxBitrate} bps): available outgoing bitrate ${availableOutgoingBitrate ?? "unknown"} bps, ${bandwidthLimitedSeconds ?? 0}s bandwidth-limited`,
        );

        this.openModal({
          type: "error2",
          error: new Error(
            "Your connection looks too weak for 1080p 60FPS screen sharing -- try 1080p 30FPS instead for a smoother stream.",
          ),
        });
      } catch {
        // Best-effort: the share is already up either way.
      }
    }, WEAK_LINK_CHECK_DELAY_MS);
  }

  /**
   * Watch a screen share publication for its capture ending, and for
   * LiveKit's own mute-debounce trying to blank it out from under us.
   *
   * Windows' WGC capturer reports a permanent error when the captured window
   * is destroyed and recreated -- which is what a game does when it switches
   * to fullscreen -- and LiveKit then unpublishes the track. The share is
   * fine, the capture handle is not, so try to pick the window back up.
   *
   * Separately: Chromium mutes a display track whenever the captured window
   * stops producing frames (minimised, backgrounded, occluded), and
   * livekit-client debounces that `mute` event for 5s before calling
   * `pauseUpstream()` -- `replaceTrack(null)` on the sender, plus signalling
   * the publication muted -- which blanks every viewer's tile even though the
   * capture itself is still alive and will resume on its own. There is no
   * supported way to stop LiveKit attaching that debounced handler in the
   * first place (`LocalTrack`'s `mute`/`unmute` listeners are bound private
   * methods, not something `removeEventListener` can target), so this
   * neutralises the effect instead: as soon as the video track reports its
   * upstream paused, immediately `resumeUpstream()` it. That call is a no-op
   * once the sender is already un-paused (see `LocalTrack.resumeUpstream` --
   * it only checks its own `_isUpstreamPaused` flag, never `isMuted`), so
   * doing this unconditionally for every screen share is safe; the viewer
   * keeps the frozen last frame instead of a blank tile until Chromium
   * unmutes the track on its own.
   *
   * Idempotent per publication object -- see
   * {@link #armedShareEndedPublication} for why that matters. Callers do not
   * need to check first; calling this again on the same live publication is
   * a no-op. The upstream-pause listener has its own, separate idempotency
   * guard ({@link #armedScreenShareUpstreamTrack}): `republishAllTracks`
   * reuses the same live `LocalVideoTrack` across a full reconnect's
   * republish, wrapped in a new publication, so guarding on the publication
   * alone would double-arm the track itself.
   */
  #armScreenShareEnded(room: Room, localTrack: LocalTrackPublication) {
    if (this.#armedShareEndedPublication !== localTrack) {
      this.#armedShareEndedPublication = localTrack;

      localTrack.on("ended", () => {
        this.#onScreenShareEnded(room, localTrack);
      });
    }

    const videoTrack = localTrack.videoTrack;
    if (videoTrack && videoTrack !== this.#armedScreenShareUpstreamTrack) {
      this.#armedScreenShareUpstreamTrack = videoTrack;

      videoTrack.on(TrackEvent.UpstreamPaused, () => {
        console.info(
          "[rtc] screen share upstream paused (LiveKit's mute debounce) -- resuming so viewers keep the last frame instead of a blank tile",
        );
        videoTrack.resumeUpstream();
      });
    }
  }

  async #onScreenShareEnded(
    room: Room,
    endedPublication: LocalTrackPublication,
  ) {
    // A manual operation (changeScreenShareSource) or an automatic recovery
    // (#recoverScreenShare) is already handling this share's lifecycle.
    // Falling through to the cleanup below anyway would race whichever one
    // is running -- most visibly, on Windows, for-desktop's native capture
    // path stops the *old* capture the instant a new display-media request
    // opens the picker (see changeScreenShareSource's doc comment), so this
    // can fire for the old publication while its replacement is still being
    // acquired. Bailing here leaves the in-flight operation to do its own
    // cleanup instead of this falling through to toggleScreenshare()'s stop
    // branch underneath it -- which, unlike a real deliberate stop, would
    // wipe #lastShareChoice and #recoveryAttempts out from under it.
    if (this.#recovering) return;

    // Stamp the start of this parking episode here, before the first
    // #recoverScreenShare call below rather than inside
    // #scheduleReacquireRetry -- see #parkedSince's doc comment for why that
    // timing matters (that call alone can block up to REACQUIRE_TIMEOUT_MS).
    // `??=` so a re-entrant call (guarded against above by `#recovering`
    // returning early, but cheap insurance regardless) cannot push this
    // episode's clock forward.
    this.#parkedSince ??= Date.now();

    // LiveKit only unpublishes the video half, and the audio track would keep
    // playing into the call on its own.
    const oldAudioTrack = room.localParticipant.getTrackPublication(
      Track.Source.ScreenShareAudio,
    );
    if (oldAudioTrack?.track) {
      try {
        await room.localParticipant.unpublishTrack(oldAudioTrack.track);
      } catch {
        /* already gone */
      }
    }

    const verdict = await this.#recoverScreenShare(room, endedPublication);
    if (verdict === "recovered") {
      this.#stopReacquireBackoff();
      return;
    }

    // Confirmed destroyed: there is nothing to retry, so end the share for
    // real instead of parking it forever -- this terminal verdict is the
    // whole reason a closed window's share used to sit "reacquiring"
    // indefinitely.
    //
    // `screenshare()` is still checked, same as the "retry" branch below:
    // the user can click stop while recovery was in flight, independently
    // of `#recovering`, which already sets `screenshare()` false and clears
    // the bookkeeping `#endScreenShare` would otherwise redo.
    if (verdict === "gone") {
      if (this.screenshare()) {
        await this.#endScreenShare(room);
        this.#showEndedNotice("gone");
      }
      return;
    }

    // Recovery could not bring the share back up *right now* ("retry"). That
    // is not the same thing as the user stopping -- only a real stop (or a
    // disconnect) should ever call `toggleScreenshare()` from here. Park
    // instead and keep retrying with backoff; see #scheduleReacquireRetry.
    //
    // MAX_PARKED_MS is not tested here: #parkedSince was only just stamped
    // above, so it cannot possibly have elapsed yet on this very first
    // attempt -- the cap only becomes relevant on the retries that
    // #scheduleReacquireRetry below drives.
    if (this.screenshare()) {
      this.#scheduleReacquireRetry(room);
    }
  }

  /**
   * Park a screen share whose capture is down and could not be brought back
   * up on this attempt, and keep retrying {@link #recoverScreenShare} with
   * backoff until it succeeds or the user explicitly stops.
   *
   * This is what keeps a recovery giving up from reading as the user
   * stopping (see {@link #onScreenShareEnded}): `screenshare()`,
   * `#lastShareChoice` and the recovery budget are all left untouched here,
   * so the share stays "on" from the sharer's own perspective -- viewers just
   * keep the frozen last frame -- while {@link screenShareState} flips to
   * `"reacquiring"` for the sharer's own tile to show an inline notice (see
   * `ParticipantTile`).
   * @param room Room to retry the recovery against
   */
  #scheduleReacquireRetry(room: Room) {
    this.#setScreenShareState("reacquiring");
    // #parkedSince is stamped by #onScreenShareEnded, before the first
    // #recoverScreenShare call ever runs -- not here. See its doc comment
    // for why: stamping it only once parking starts (i.e. after that first,
    // potentially up-to-90s-long call already returned) would undercount how
    // long the capture has actually been down.

    const delay =
      REACQUIRE_BACKOFF_MS[
        Math.min(this.#reacquireBackoffStep, REACQUIRE_BACKOFF_MS.length - 1)
      ];
    this.#reacquireBackoffStep++;

    /** Whether {@link MAX_PARKED_MS} has been exceeded, ending the share and
     * showing the neutral "timeout" notice if so. Checked both before and
     * after the {@link #recoverScreenShare} call below: `#recoverScreenShare`
     * can itself run for up to REACQUIRE_TIMEOUT_MS (90s), so checking only
     * after it returns would let one more such call start even when the cap
     * had already elapsed going in -- see MAX_PARKED_MS's doc comment for
     * why that overshoot is still fine, but only within one call's worth. */
    const capExceeded = async () => {
      if (
        this.#parkedSince === undefined ||
        Date.now() - this.#parkedSince <= MAX_PARKED_MS
      ) {
        return false;
      }
      if (this.screenshare()) {
        await this.#endScreenShare(room);
        this.#showEndedNotice("timeout");
      }
      return true;
    };

    clearTimeout(this.#reacquireTimer);
    this.#reacquireTimer = setTimeout(async () => {
      // The user stopped, or disconnected and reconnected to a different
      // room, while this timer was pending.
      if (!this.screenshare() || this.room() !== room) return;

      // Before: an ambiguous ("retry") verdict from a previous round may
      // already have run the parked time past the cap -- don't spend
      // another up-to-90s call finding that out the slow way.
      if (await capExceeded()) return;

      const verdict = await this.#recoverScreenShare(room);
      if (verdict === "recovered") {
        this.#stopReacquireBackoff();
        return;
      }

      if (verdict === "gone") {
        if (this.screenshare()) {
          await this.#endScreenShare(room);
          this.#showEndedNotice("gone");
        }
        return;
      }

      // "retry": bound how long a share may sit parked in the first place --
      // see MAX_PARKED_MS's doc comment. This is the platform-independent
      // net that catches an ambiguous verdict (an older desktop build's bare
      // `false`, or plain web, neither of which can ever produce "gone")
      // that would otherwise retry with backoff forever.
      //
      // After: the call above just ran, so re-check now too -- it may have
      // pushed the parked time past the cap even though the check before it
      // passed.
      if (await capExceeded()) return;

      if (this.screenshare()) {
        this.#scheduleReacquireRetry(room);
      }
    }, delay);
  }

  /**
   * Cancel any pending {@link #scheduleReacquireRetry} timer and reset its
   * backoff. Called on a real user stop, on disconnect, and on a successful
   * recovery -- the three ways a parked share stops being parked.
   */
  #stopReacquireBackoff() {
    clearTimeout(this.#reacquireTimer);
    this.#reacquireTimer = undefined;
    this.#reacquireBackoffStep = 0;
    this.#parkedSince = undefined;
    this.#setScreenShareState("idle");
  }

  /**
   * Tear down a screen share for real -- the shared bookkeeping behind every
   * path that ends a share, whether the user clicked "stop" themselves
   * (`toggleScreenshare`) or a terminal verdict decided for them (`"gone"`
   * from {@link #recoverScreenShare}, or the {@link MAX_PARKED_MS} cap
   * running out on an ambiguous one). Peers are notified implicitly:
   * `setScreenShareEnabled(false)` unpublishes the track and LiveKit
   * propagates `trackUnpublished` to everyone watching.
   *
   * Deliberately does not touch {@link screenShareState}: a deliberate stop
   * has nothing to announce and should land back on `"idle"` (which
   * `#stopReacquireBackoff` below already does), while the terminal paths
   * that call this need to show an "ended" notice afterwards -- see those
   * call sites.
   *
   * Not folded into `disconnect()`'s near-identical inline bookkeeping
   * (~line 1188): that is a separate, pre-existing duplication out of scope
   * for this change.
   */
  async #endScreenShare(room: Room) {
    this.#lastShareChoice = undefined;
    this.#recoveryAttempts = [];
    this.#armedShareEndedPublication = undefined;
    this.#armedScreenShareUpstreamTrack = undefined;
    this.#browserReacquireAttempted = false;
    this.#stopReacquireBackoff();

    await room.localParticipant.setScreenShareEnabled(false);

    this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

    this.sound.playSound("streamEnd");
  }

  /**
   * Flip {@link screenShareState} to an `"ended-"` state for
   * {@link ENDED_NOTICE_MS}, then clear it back to `"idle"` -- the inline
   * notice {@link #endScreenShare}'s terminal callers (a `"gone"` verdict,
   * or the {@link MAX_PARKED_MS} cap) show on the sharer's own tile. Kept
   * separate from `#endScreenShare` itself: a deliberate stop
   * (`toggleScreenshare`) calls that too and must land on `"idle"`, not an
   * `"ended-"` state -- see `#endScreenShare`'s doc comment.
   *
   * @param reason Which terminal path is calling, so the UI states a cause
   * it actually knows rather than guessing: `"gone"` (a confirmed-destroyed
   * window, for-desktop's `"gone"` verdict) knows *why* the share ended and
   * shows the specific wording, while `"timeout"` (the {@link
   * MAX_PARKED_MS} cap giving up on an answer that was never anything more
   * than "not yet") only knows *that* it ended, so its notice must stay
   * deliberately neutral.
   */
  #showEndedNotice(reason: "gone" | "timeout") {
    this.#setScreenShareState(
      reason === "gone" ? "ended-gone" : "ended-timeout",
    );
    clearTimeout(this.#endedNoticeTimer);
    this.#endedNoticeTimer = setTimeout(() => {
      // Only clear if nothing else claimed the state meanwhile (a fresh
      // share, another terminal verdict) -- guards this stale timer against
      // stomping on unrelated state set after it was scheduled.
      if (this.screenShareState().startsWith("ended-")) {
        this.#setScreenShareState("idle");
      }
    }, ENDED_NOTICE_MS);
  }

  /**
   * Try to restart a screen share whose capture died underneath us.
   *
   * With the desktop bridge, the main process can find the window again and
   * answer the next getDisplayMedia without showing the picker -- see the
   * `window.native` branch below. On plain web there is no such bridge, so
   * {@link #recoverScreenShareBrowser} handles the much narrower set of
   * cases that need no picker at all.
   * @param room Room
   * @param endedPublication The publication whose "ended" event triggered
   * this call, if this is that first call. Absent on a backoff retry (see
   * {@link #scheduleReacquireRetry}), since the dead publication is long
   * gone by then -- only {@link #recoverScreenShareBrowser}'s "still live,
   * just muted" check needs it.
   * @returns A terminal verdict: `"recovered"` (share is back up),
   * `"retry"` (not yet -- keep parking with backoff, today's `false`
   * meaning), or `"gone"` (the shared window is confirmed destroyed --
   * callers should end the share for real rather than park it). Only the
   * `window.native` branch can ever produce `"gone"`; both the plain-web
   * fallback ({@link #recoverScreenShareBrowser}) and an older desktop build
   * that still resolves a bare boolean map onto `"recovered"`/`"retry"`
   * only, never `"gone"` -- {@link MAX_PARKED_MS} is what eventually ends a
   * share that never comes back on those paths.
   */
  async #recoverScreenShare(
    room: Room,
    endedPublication?: LocalTrackPublication,
  ): Promise<"recovered" | "retry" | "gone"> {
    const choice = this.#lastShareChoice;
    if (!choice || this.#recovering || !this.screenshare()) return "retry";

    const now = Date.now();
    this.#recoveryAttempts = this.#recoveryAttempts.filter(
      (at) => now - at < RECOVERY_WINDOW_MS,
    );
    if (this.#recoveryAttempts.length >= MAX_RECOVERIES) {
      console.warn(
        "[rtc] screen share keeps dying, giving up on automatic recovery",
      );
      return "retry";
    }

    const reacquire = window.native?.reacquireScreenShare;
    if (typeof reacquire !== "function") {
      return (await this.#recoverScreenShareBrowser(
        room,
        choice,
        endedPublication,
      ))
        ? "recovered"
        : "retry";
    }

    this.#recovering = true;
    try {
      // Main waits (up to a few minutes) for the window to come back; a
      // minimised window cannot be captured, so this can take a while. A
      // window share whose target is confirmed destroyed resolves the
      // terminal "gone" immediately instead of running out that wait -- see
      // for-desktop's screenShare:reacquire handler and
      // isWindowConfirmedGone.
      const verdict = await reacquire();
      if (verdict === "gone") return "gone";
      if (!verdict) return "retry";

      // The entry guard above only checked `screenshare()` before this long
      // wait started -- the user can click stop while it was in flight,
      // which runs independently of `#recovering` and sets `screenshare()`
      // false right away. Bail here rather than republishing a share the
      // user just asked to end.
      if (!this.screenshare()) return "retry";

      // LiveKit unpublishes a track that ended, but it does so asynchronously
      // and we may well get here first. setScreenShareEnabled(true) reuses any
      // publication it finds and merely unmutes it, which would "recover" the
      // share into the dead track we are trying to replace -- so make sure the
      // old one is really gone before capturing again.
      if (room.localParticipant.getTrackPublication(Track.Source.ScreenShare)) {
        try {
          await room.localParticipant.setScreenShareEnabled(false);
        } catch {
          /* already unpublished */
        }
      }

      const recoveredQuality =
        this.getEnabledScreenShareQualities()[choice.qualityName];

      // Computed up front for the same reason as toggleScreenshare: the
      // codec decision needs to be captured for the post-publish check
      // below before anything else can probe a different resolution.
      const publishOptions = await screenSharePublishOptions(
        recoveredQuality?.resolution,
      );
      const codecDecision = getScreenShareCodecDecision();

      // Same "no resolution, thread the framerate separately" shape as
      // toggleScreenshare -- see setNextScreenShareFrameRate's comment.
      setNextScreenShareFrameRate(recoveredQuality?.resolution.frameRate ?? 30);
      let localTrack: LocalTrackPublication | undefined;
      try {
        localTrack = await room.localParticipant.setScreenShareEnabled(
          true,
          {
            audio: SCREEN_SHARE_AUDIO,
          },
          publishOptions,
        );
      } catch (err) {
        // Only an attempt that actually reached setScreenShareEnabled(true)
        // and failed counts against the recovery budget -- a `reacquire()`
        // that never found the window back charged nothing either, above.
        this.#recoveryAttempts.push(now);
        throw err;
      } finally {
        setNextScreenShareFrameRate(undefined);
      }

      if (!localTrack) {
        this.#recoveryAttempts.push(now);
        return "retry";
      }

      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);
      this.#armScreenShareEnded(room, localTrack);
      this.#watchForSoftwareFallback(localTrack, codecDecision);

      // No modal and no start sound: as far as the sharer is concerned this
      // never stopped.
      await this.#applyShareChoice(
        room,
        localTrack,
        choice.qualityName,
        choice.audio,
        false,
      );

      return "recovered";
    } catch (err) {
      console.warn("[rtc] screen share recovery failed", err);
      return "retry";
    } finally {
      this.#recovering = false;
    }
  }

  /**
   * Browser fallback for {@link #recoverScreenShare}: without the desktop
   * bridge there is no way to silently find the captured window again, so
   * this only covers the two cases that need no `getDisplayMedia` picker.
   * @param room Room
   * @param choice The remembered share choice to restore
   * @param endedPublication The publication whose "ended" event triggered
   * this recovery, if this is the first attempt (absent on a backoff retry)
   * @returns Whether the share is back up
   */
  async #recoverScreenShareBrowser(
    room: Room,
    choice: ShareChoice,
    endedPublication: LocalTrackPublication | undefined,
  ): Promise<boolean> {
    const readyState =
      endedPublication?.videoTrack?.mediaStreamTrack.readyState;

    // `readyState === "live"` alone is not enough to call this a success.
    // By the time we get here, #onScreenShareEnded has already
    // unconditionally unpublished the ScreenShareAudio track above, and
    // `ended` fired on the video publication in the first place -- which
    // livekit-client follows by unpublishing the video track too, just
    // asynchronously (see the near-identical race called out where
    // #recoverScreenShare's native branch checks
    // `getTrackPublication(Track.Source.ScreenShare)` before republishing).
    // A plain `getDisplayMedia` track's `readyState` is spec'd to already be
    // "ended" by the time its `ended` event fires, which would make this
    // branch dead in practice -- but that is not provable for every path
    // into this handler (notably for-desktop's page patch synthesises
    // `ended` on a `MediaStreamTrackGenerator`-backed track, a different
    // object lifecycle), so do not trust `readyState` on its own. Confirm
    // the publication itself is still actually live on the local
    // participant -- same `trackSid`, still registered -- before reporting
    // success. Otherwise fall through: the normal re-acquire path (or
    // parking with backoff, if that has already been spent) picks it up,
    // same as any other dead capture.
    const stillPublished =
      readyState === "live" &&
      room.localParticipant.getTrackPublication(Track.Source.ScreenShare)
        ?.trackSid === endedPublication?.trackSid;

    if (stillPublished) {
      // Not actually dead, just muted -- Chromium resumes producing frames
      // on its own once the window is visible again, and
      // #armScreenShareEnded's upstream-pause listener already keeps the
      // viewer from going blank in the meantime. Nothing to do.
      return true;
    }

    if (this.#browserReacquireAttempted) {
      // Already spent the one silent re-acquire this share gets -- a second
      // getDisplayMedia call would pop Chrome's picker again, which is not
      // something to trigger with no user action behind it. Park instead
      // (see #onScreenShareEnded) and keep waiting for the user to stop.
      return false;
    }
    this.#browserReacquireAttempted = true;

    this.#recovering = true;
    try {
      const quality = this.getEnabledScreenShareQualities()[choice.qualityName];
      const publishOptions = await screenSharePublishOptions(
        quality?.resolution,
      );
      const codecDecision = getScreenShareCodecDecision();

      setNextScreenShareFrameRate(quality?.resolution.frameRate ?? 30);
      let localTrack: LocalTrackPublication | undefined;
      try {
        localTrack = await room.localParticipant.setScreenShareEnabled(
          true,
          {
            audio: SCREEN_SHARE_AUDIO,
            // Same picker hints toggleScreenshare's own start branch uses --
            // this attempt pops Chrome's picker too (see the "at most once"
            // comment above), so it should look the same as any other.
            ...browserCaptureOptions({
              screenShareQualityAsk: this.#settings.screenShareQualityAsk,
              screenShareAudio: this.#settings.screenShareAudio,
            }),
          },
          publishOptions,
        );
      } catch (err) {
        this.#recoveryAttempts.push(Date.now());
        throw err;
      } finally {
        setNextScreenShareFrameRate(undefined);
      }

      // The picker was open for a while -- the user could have clicked stop
      // in the meantime, independently of #recovering.
      if (!this.screenshare()) return false;

      if (!localTrack) {
        this.#recoveryAttempts.push(Date.now());
        return false;
      }

      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);
      this.#armScreenShareEnded(room, localTrack);
      this.#watchForSoftwareFallback(localTrack, codecDecision);

      await this.#applyShareChoice(
        room,
        localTrack,
        choice.qualityName,
        choice.audio,
        false,
      );

      return true;
    } catch (err) {
      // NotAllowedError/AbortError here just means the picker was dismissed
      // -- still a real attempt that reached setScreenShareEnabled(true) and
      // failed, so it counts against the budget same as any other failure.
      console.warn("[rtc] browser screen share recovery failed", err);
      return false;
    } finally {
      this.#recovering = false;
    }
  }

  /**
   * Change which window/screen is being shared, mid-share.
   *
   * There is no swap-source API on top of WebRTC/`getDisplayMedia` -- the
   * source is fixed for the life of the capture -- so this is still a
   * stop/start cycle under the hood, but ordered *acquire, then swap*:
   * request the replacement capture first, and only tear down the running
   * share once that succeeds. This is deliberately not the same order as
   * `#recoverScreenShare` (which tears down first, because the old capture
   * is already dead by the time it runs). Acquiring first buys two things a
   * teardown-first ordering cannot:
   *
   * - **Cancel-safety.** `setScreenShareEnabled(true)` merely unmutes an
   *   existing publication rather than asking `getDisplayMedia` again (see
   *   `LocalParticipant.setTrackEnabled` in livekit-client), so a
   *   teardown-first ordering has to tear down before it can even ask for a
   *   replacement -- and a cancelled or failed pick then leaves nothing
   *   running. Acquiring via `createScreenTracks` first (the same
   *   `LocalParticipant` method `setScreenShareEnabled(true)` calls
   *   internally) means a cancelled pick leaves the running share untouched.
   * - **Activation.** `getDisplayMedia` needs to run inside the same
   *   transient-activation window as the click that triggered this. A
   *   teardown first -- `setScreenShareEnabled(false)` can mean a full SDP
   *   renegotiation round trip (`unpublishTrack` -> `engine.negotiate()`),
   *   or waiting out an in-progress republish (`setTrackEnabled` opens with
   *   `await this.republishPromise`) -- risks that window lapsing before the
   *   replacement is even requested.
   *
   * This does NOT close the viewer-visible gap, though: on Windows,
   * for-desktop's native capture path stops the *old* capture the instant a
   * new display-media request arrives -- before the user has even picked
   * anything (see `for-desktop/src/native/window.ts`'s `stopScreenCapture()`
   * call on request) -- so the old share still ends early there regardless
   * of the ordering here. Closing that needs a for-desktop change and is out
   * of scope for this PR; acquiring first still wins on cancel-safety and
   * activation, which is what it is for.
   *
   * Deliberately does not go through `toggleScreenshare()`: its stop branch
   * clears `#lastShareChoice` and `#recoveryAttempts`, and this needs to
   * read `#lastShareChoice` for the republish below. Reusing it, rather
   * than the saved default quality `toggleScreenshare` starts a *fresh*
   * share with, is what keeps a quality change made earlier in this same
   * share from being silently reverted by switching sources afterwards.
   * `announce = false` for the same reason as recovery: from the sharer's
   * perspective this never stopped, so no stream-start sound either.
   *
   * Viewers do see a brief unpublish/republish once teardown happens --
   * unavoidable, and exactly what an automatic recovery already looks like
   * today, which is what the tile's `FOCUS_GRACE_MS` pin-retention already
   * tolerates.
   *
   * Reuses the `#recovering` flag rather than a separate one: this and
   * `#recoverScreenShare` are both "tear down and republish the same share"
   * operations on the same publication, and letting both run at once would
   * have them race over it. It is also what makes `#onScreenShareEnded`
   * ignore the old publication's "ended" firing mid-acquire (see its own
   * doc comment). The flag is cleared as soon as the acquire/teardown/
   * publish sequence resolves, before arming the new publication's own
   * "ended" listener or applying the saved quality to it, so a death of the
   * new capture during that tail is handled as a normal recovery rather
   * than silently ignored by this method still holding the flag.
   */
  async changeScreenShareSource() {
    const room = this.room();
    if (!room || !this.screenshare() || this.#recovering) {
      console.warn(
        "[rtc] changeScreenShareSource: ignored (not sharing, or a source change is already in progress)",
      );
      return;
    }

    // Nothing to preserve quality/audio from -- should not happen while
    // screenshare() is true, but this is a manual, user-triggered action
    // rather than a best-effort recovery, so bail rather than guess.
    const choice = this.#lastShareChoice;
    if (!choice) {
      console.warn(
        "[rtc] changeScreenShareSource: no remembered share choice to reuse",
      );
      return;
    }

    this.#recovering = true;

    // Set by the desktop picker's onCancel below. Only meaningful while
    // acquiring (see the catch): a dismissed picker there means nothing was
    // ever touched, as opposed to a genuine failure.
    let cancelled = false;
    // Whether the running share has actually been torn down yet. Only once
    // this flips does a failure mean "share ended", rather than "nothing
    // happened" -- acquiring runs first and touches nothing.
    let torndown = false;

    let localTrack: LocalTrackPublication | undefined;
    let codecDecision: ReturnType<typeof getScreenShareCodecDecision>;
    let screenPickerQualityName: ScreenShareQualityName | undefined;
    let screenPickerAudio: boolean | undefined;

    try {
      // Same desktop-picker dance as toggleScreenshare's start branch:
      // registered before acquiring, since acquiring is what triggers it. On
      // plain web this is skipped and createScreenTracks below falls through
      // to the browser's own getDisplayMedia picker instead.
      if (window.native && window.native.onceScreenPicker) {
        window.native.onceScreenPicker((sources) => {
          this.openModal({
            type: "screen_share_picker",
            onCancel: () => {
              cancelled = true;
              window.native.screenPickerCallback(-1, false);
            },
            callback: (idx, qualityName, audio) => {
              window.native.screenPickerCallback(idx, audio);
              screenPickerQualityName = qualityName;
              screenPickerAudio = audio;
            },
            sources,
            qualities: this.#screenShareQualityOptions(),
          });
        });
      }

      const qualities = this.getEnabledScreenShareQualities();
      const startingQuality = qualities[choice.qualityName] ?? qualities.low!;

      // Acquire the replacement FIRST -- see the doc comment above for why
      // this has to come before touching the running share at all.
      let newTracks: LocalTrack[];
      setNextScreenShareFrameRate(startingQuality.resolution.frameRate ?? 30);
      try {
        newTracks = await room.localParticipant.createScreenTracks({
          audio: SCREEN_SHARE_AUDIO,
          // Browser-only (returns `{}` on desktop): see toggleScreenshare's
          // matching call and screenShareSurface.ts.
          ...browserCaptureOptions({
            screenShareQualityAsk: this.#settings.screenShareQualityAsk,
            screenShareAudio: this.#settings.screenShareAudio,
          }),
        });
      } finally {
        setNextScreenShareFrameRate(undefined);
      }

      // Only now touch the running share. It may already be half gone
      // regardless of anything we do here -- see the doc comment's note
      // about for-desktop's native path -- so this is best-effort cleanup of
      // the old publication, not a precondition for the acquire above.
      torndown = true;
      if (room.localParticipant.getTrackPublication(Track.Source.ScreenShare)) {
        try {
          await room.localParticipant.setScreenShareEnabled(false);
        } catch {
          /* already unpublished */
        }
      }

      const finalQualityName = screenPickerQualityName ?? choice.qualityName;
      const finalQuality = qualities[finalQualityName] ?? startingQuality;

      // Same "capture the codec decision before publishOptions before
      // anything else can probe a different resolution" shape as
      // toggleScreenshare/#recoverScreenShare.
      const publishOptions = await screenSharePublishOptions(
        finalQuality.resolution,
      );
      codecDecision = getScreenShareCodecDecision();

      // Mirrors LocalParticipant.setTrackEnabled's own screen-share publish
      // loop: publish every acquired track (video, and audio if requested
      // and granted) with the same options, and take the first result as the
      // video publication -- createScreenTracks always returns [video,
      // audio?] in that order, and Promise.all preserves input order in its
      // results, exactly the assumption setTrackEnabled itself makes.
      try {
        const publishedTracks = await Promise.all(
          newTracks.map((track) =>
            room.localParticipant.publishTrack(track, publishOptions),
          ),
        );
        localTrack = publishedTracks[0];
      } catch (e) {
        newTracks.forEach((track) => track.stop());
        throw e;
      }
    } catch (e) {
      if (cancelled) {
        // Not a failure -- the user backed out of the picker. Logged at
        // info rather than warn so a routine "never mind" does not read
        // like something went wrong.
        console.info("[rtc] changeScreenShareSource: picker cancelled", {
          torndown,
        });
      } else {
        // Same exclusion as toggleScreenshare's catch: a dismissed picker on
        // plain web rejects with NotAllowedError/AbortError, and the desktop
        // picker's cancel path rejects with something else again (handled
        // just above) -- neither is worth an error modal.
        this.onErr(e, ["NotAllowedError", "AbortError"]);
        console.warn("[rtc] changeScreenShareSource failed", { torndown }, e);
      }
    } finally {
      this.#recovering = false;
    }

    if (!localTrack) {
      if (torndown) {
        // Committed (the old capture is gone) but nothing replaced it --
        // match toggleScreenshare's own deliberate-stop bookkeeping in full
        // (see that method's stop branch) rather than leaving a stale
        // choice, recovery budget, armed listeners, or pending reacquire
        // timer around, or no audible sign that the share actually ended.
        this.#lastShareChoice = undefined;
        this.#recoveryAttempts = [];
        this.#armedShareEndedPublication = undefined;
        this.#armedScreenShareUpstreamTrack = undefined;
        this.#browserReacquireAttempted = false;
        this.#stopReacquireBackoff();
        this.sound.playSound("streamEnd");
      }
      // Otherwise: acquiring failed or was cancelled before anything was
      // touched, so the running share is exactly as it was -- nothing left
      // to reconcile.
      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);
      return;
    }

    this.#setScreenshare(room.localParticipant.isScreenShareEnabled);
    this.#armScreenShareEnded(room, localTrack);
    this.#watchForSoftwareFallback(localTrack, codecDecision);

    // A freshly picked window starts with a clean slate: the previous
    // source's recovery budget has nothing to do with how healthy this new
    // one is, and inheriting it could refuse to recover a perfectly fine
    // window because a *different* one died twice a minute ago. Same
    // reasoning for the silent-reacquire budget: a source the user just
    // picked by hand has not spent its one browser-side re-acquire yet.
    this.#recoveryAttempts = [];
    this.#browserReacquireAttempted = false;

    const screenAudioTrack = room.localParticipant.getTrackPublication(
      Track.Source.ScreenShareAudio,
    );

    // Same classification as toggleScreenshare's start branch -- a source
    // change lands on whatever surface the browser's picker was pointed at
    // exactly like the initial share does. This is what closes the
    // one-menu-item leak: "change source" -> Entire Screen -> tick Chrome's
    // system-audio box -- without it, that path re-applied the previous
    // share's audio choice to a completely different surface with no
    // classification and not even the console.info. `risk === "none"` on
    // desktop unconditionally -- see classifyCapturedSurface's doc comment.
    const { displaySurface, risk: surfaceRisk } = classifyCapturedSurface(
      localTrack.videoTrack?.mediaStreamTrack,
      !!screenAudioTrack,
    );

    if (surfaceRisk === "leak") {
      // Forcing the same interactive dialog toggleScreenshare uses, but
      // with different cancel semantics: by this point `torndown` is
      // already `true`, so there is no previous capture left to fall back
      // to. "Cancel" here therefore means what it means for any other
      // deliberate stop -- end the share -- rather than inventing a
      // "revert to the window that no longer exists" this dialog has no
      // way to deliver. (A "caution" classification is left to log only,
      // same as the initial-share branch above: forcing this dialog on
      // every merely-provisional case would make "change source" as
      // interruptive as starting a share from scratch, for a risk level
      // that may turn out to be nothing -- see the open question in
      // screenShareSurface.ts.)
      //
      // Audio paused first, both awaited via allSettled -- see the matching
      // comment on the initial-share branch above for why.
      await Promise.allSettled([
        screenAudioTrack?.pauseUpstream(),
        localTrack.pauseUpstream(),
      ]);

      await new Promise<void>((resolve) => {
        this.openModal({
          type: "screen_share_settings",
          trackReference: {
            participant: room.localParticipant,
            publication: localTrack,
            source: Track.Source.ScreenShare,
          },
          qualities: this.#screenShareQualityOptions(),
          audio: !!screenAudioTrack,
          initialQualityName: screenPickerQualityName ?? choice.qualityName,
          initialAudio: screenPickerAudio ?? choice.audio,
          liveEdit: true,
          surfaceRisk,
          displaySurface,
          onCancel: async () => {
            await room.localParticipant.setScreenShareEnabled(false);
            this.#setScreenshare(room.localParticipant.isScreenShareEnabled);
            // Same deliberate-stop bookkeeping as the torndown/no-replacement
            // branch above and toggleScreenshare's own stop branch -- this is
            // the user backing out of the leak-risk dialog entirely, ending
            // the share for real, not a source swap.
            this.#lastShareChoice = undefined;
            this.#recoveryAttempts = [];
            this.#armedShareEndedPublication = undefined;
            this.#armedScreenShareUpstreamTrack = undefined;
            this.#browserReacquireAttempted = false;
            this.#stopReacquireBackoff();
            this.sound.playSound("streamEnd");
            resolve();
          },
          callback: async (qualityName, audio) => {
            localTrack.resumeUpstream();
            if (audio) {
              screenAudioTrack?.resumeUpstream();
            }
            try {
              await this.#applyShareChoice(
                room,
                localTrack,
                qualityName,
                audio,
                false,
              );
            } finally {
              resolve();
            }
          },
        });
      });
      return;
    }

    try {
      await this.#applyShareChoice(
        room,
        localTrack,
        screenPickerQualityName ?? choice.qualityName,
        screenPickerAudio ?? choice.audio,
        false,
      );
    } catch (e) {
      // The share itself is up either way -- #applyEncoderLimits inside
      // #applyShareChoice already treats itself as best-effort, so this only
      // catches the narrower applyConstraints() call at its start, which
      // isn't wrapped there. Not fatal: worst case the replacement stays at
      // its capture defaults instead of the chosen quality.
      console.warn(
        "[rtc] changeScreenShareSource: failed to apply saved quality to the replacement",
        e,
      );
    }
  }

  toggleFullscreen(fullscreen: boolean = !this.fullscreen()) {
    this.#setFullscreen(fullscreen);
  }

  trackId(t: TrackReferenceOrPlaceholder) {
    return `${t.source}_${t.participant.sid}`;
  }

  /**
   * Focus (or unfocus) a track -- and, with it, decide whether the strip of
   * everyone else stays on screen.
   *
   * Focus now owns `showBar` rather than leaving it as its own independent
   * default: focusing a tile means "show me just this", so entering focus
   * always hides the strip, even if the user had pulled it back into view
   * during a *previous* focus. Leaving focus (including the no-argument call
   * the focus-grace timeout in `VoiceCallCardActiveRoom.tsx` makes once a
   * pinned stream has been gone too long) restores it, since that is when
   * the grid the strip belongs to reappears. `toggleShowBar` -- the chevron
   * -- is untouched: it still lets someone reveal the strip while staying
   * focused, this only sets the strip's state at the moment focus itself
   * changes.
   *
   * `next` is resolved once and used to drive both signals, instead of
   * setting focus and then reading `this.focusId()` back afterwards --
   * reading a signal a second time right after this same call changed it is
   * exactly how the two could end up disagreeing.
   */
  toggleFocus(t?: TrackReferenceOrPlaceholder) {
    const id = t ? this.trackId(t) : undefined;
    const next =
      this.focusId() === id || this.vidTracks().length < 2 ? undefined : id;
    this.#setFocus(next);
    this.#setShowBar(next === undefined);
  }

  isFocus(t: TrackReferenceOrPlaceholder) {
    return this.trackId(t) === this.focusId();
  }

  focusTrack() {
    const id = this.focusId();
    return id
      ? this.vidTracks().find((t) => this.trackId(t) === id)
      : undefined;
  }

  toggleShowBar() {
    this.#setShowBar((s) => !s);
  }

  getConnectedUser(userId: string) {
    return this.room()?.getParticipantByIdentity(userId);
  }

  showCard(channel: Channel) {
    return (
      channel.isVoice &&
      (this.channel()?.id === channel.id ||
        channel.type === "TextChannel" ||
        !!channel.voiceParticipants.size)
    );
  }

  getMicrophoneTrack(): LocalTrackPublication | undefined {
    const room = this.room();
    if (!room) return undefined;
    return getMicPublication(room.localParticipant) as
      | LocalTrackPublication
      | undefined;
  }

  /**
   * Whether our real microphone is published and unmuted.
   *
   * localParticipant.isMicrophoneEnabled cannot be used: it looks at the
   * first microphone-source publication, which may be the soundboard track.
   */
  #isMicEnabled(room: Room): boolean {
    const pub = getMicPublication(room.localParticipant);
    return !!pub && !pub.isMuted;
  }

  /**
   * Soundboard-aware setMicrophoneEnabled.
   */
  async #setMicEnabled(
    room: Room,
    enabled: boolean,
  ): Promise<LocalTrackPublication | undefined> {
    const participant = room.localParticipant;
    const pub = getMicPublication(participant) as
      | LocalTrackPublication
      | undefined;

    if (pub) {
      if (enabled) await pub.unmute();
      else await pub.mute();
      return pub;
    }

    if (!enabled) return undefined;

    // Without a soundboard track LiveKit's own logic is exactly what we want.
    if (!hasSoundboardPublication(participant)) {
      return participant.setMicrophoneEnabled(true);
    }

    // With one, setMicrophoneEnabled would find the soundboard track first and
    // "unmute" that instead of capturing a microphone, so do it by hand.
    const [track] = await participant.createTracks({ audio: true });
    if (!track) return undefined;
    return participant.publishTrack(track, {
      source: Track.Source.Microphone,
    });
  }

  /**
   * Meter our own microphone so our tile lights up as fast as everyone else's.
   *
   * Re-arms when the track restarts, which is how the voice settings effect
   * applies new constraints -- the old MediaStreamTrack is dead by then and
   * would read as permanent silence.
   */
  #meterLocalMicrophone(room: Room, pub: LocalTrackPublication) {
    const track = pub.audioTrack;
    if (!track) return;

    const identity = room.localParticipant.identity;

    const arm = () => {
      this.#localSpeakingMeter?.();
      this.#localSpeakingMeter = registerSpeakingMeter(
        identity,
        track.mediaStreamTrack,
      );
    };

    arm();
    track.on(TrackEvent.Restarted, arm);
  }

  /**
   * Play a soundboard sound for everyone in the call
   */
  async playSoundboard(sound: SoundboardSound) {
    try {
      const soundboard = this.soundboard();
      if (!soundboard) throw "invalid state";
      await soundboard.play(sound);
    } catch (e) {
      this.onErr(e);
    }
  }

  /**
   * Stop every soundboard sound we are playing
   */
  stopSoundboard() {
    this.soundboard()?.stopAll();
  }

  /**
   * Publish the soundboard track ahead of time so the first sound is instant
   */
  prepareSoundboard() {
    if (!this.speakingPermission) return;
    this.soundboard()
      ?.ensurePublished()
      .catch((e) => this.onErr(e));
  }

  get listenPermission() {
    return !!this.channel()?.havePermission("Listen");
  }

  get speakingPermission() {
    return !!this.channel()?.havePermission("Speak");
  }

  /**
   * Show the generic error modal for an unexpected failure.
   *
   * `ignoreNames` lets one specific call site (the screen-share picker, see
   * `toggleScreenshare`) suppress cancel-shaped `DOMException`s without
   * doing that for every other caller. It used to be a blanket exclusion
   * for `NotAllowedError`/`AbortError` on every call to this method, which
   * meant `toggleCamera` -- sharing this same handler -- silently ate a
   * denied camera permission (`NotAllowedError` is exactly what that
   * produces) with no error shown at all.
   * @param e Whatever was caught
   * @param ignoreNames Error `.name` values to swallow instead of showing a modal
   */
  private onErr(e: unknown, ignoreNames: string[] = []) {
    const name = (e as Error)?.name;
    if (name && ignoreNames.includes(name)) return;
    this.openModal({ type: "error2", error: e });
  }
}

const voiceContext = createContext<Voice>(null as unknown as Voice);

/**
 * Mount global voice context and room audio manager
 */
export function VoiceContext(props: { children: JSX.Element }) {
  const state = useState();
  const modals = useModals();
  const sound = useSound();
  const device = useDevice();
  // VoiceContext is mounted inside SnackbarProvider (see `src/index.tsx`),
  // so this is safe -- see the "Make it perceptible" work item on Bug 5 for
  // why Voice, a plain class with no JSX of its own, needs this at all.
  const snackbar = useSnackbar();
  const voice = new Voice(state.voice, modals, sound, device, snackbar);

  return (
    <voiceContext.Provider value={voice}>
      <RoomContext.Provider value={voice.room}>
        <VoiceCallCardContext>{props.children}</VoiceCallCardContext>
        <InRoom>
          <RoomAudioManager />
        </InRoom>
      </RoomContext.Provider>
    </voiceContext.Provider>
  );
}

export const useVoice = () => useContext(voiceContext);
