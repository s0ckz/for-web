import {
  Accessor,
  batch,
  createContext,
  createEffect,
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
  LocalTrackPublication,
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
import { VoiceCallCardContext } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";

import { Device, useDevice } from "@revolt/common";
import { InRoom } from "./components/InRoom";
import { RoomAudioManager } from "./components/RoomAudioManager";
import { setNextScreenShareFrameRate } from "./screenShareCapture";
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
 * The ceiling is keyed on resolution, not framerate -- both presets run at
 * 30fps (see {@link ScreenShareQualityName}), so a framerate key would have
 * given 720p and 1080p the same budget, which defeats the point of offering
 * a "lighter" preset at all.
 * @param resolution Target resolution, or undefined to use the 720p ceiling
 * @returns Publish options
 */
function screenShareEncoding(resolution: VideoResolution | undefined) {
  return {
    // 1080p needs roughly twice the pixels of 720p, so it gets roughly twice
    // the bitrate ceiling. This is a ceiling, not a target -- a hardware
    // H.26x encoder settles well under it, so the extra headroom just leaves
    // it room to breathe rather than forcing it there.
    maxBitrate: resolution && resolution.height > 720 ? 8_000_000 : 4_000_000,
    maxFramerate: resolution?.frameRate ?? 30,
    priority: "high" as const,
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
 * SCREEN_SHARE_CODEC_PROBE_TIMEOUT_MS} timeout (`Promise.all` inside a
 * single race, so the wall-clock cost is one probe's worth, not four) --
 * a slow first `encodingInfo` call on a cold GPU process must not stall the
 * share starting. If `mediaCapabilities.encodingInfo` is missing, any probe
 * rejects, or the timeout fires, this returns "vp9" for *this* call only
 * and writes nothing to the cache, so the next attempt retries from
 * scratch.
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

  const promise = (async (): Promise<VideoCodec> => {
    // Typed as non-optional in lib.dom.d.ts, but not every Chromium build
    // actually implements `encodingInfo` -- check before using it rather
    // than trust the type.
    const mediaCapabilities: MediaCapabilities | undefined =
      navigator.mediaCapabilities;

    if (
      typeof RTCRtpSender === "undefined" ||
      !mediaCapabilities?.encodingInfo
    ) {
      // Same reasoning as the timeout path below: record it so a stale
      // `cbpHardware` from an earlier share cannot leak into the backup
      // codec choice, but do not cache it.
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

    let probes: CodecProbe[] | undefined;
    try {
      probes = await Promise.race([
        Promise.all([
          probe(H265_CONTENT_TYPE),
          probe(H264_CBP_CONTENT_TYPE),
          probe(H264_MAIN_CONTENT_TYPE),
          probe(H264_HIGH_CONTENT_TYPE),
        ]),
        new Promise<undefined>((resolve) =>
          setTimeout(
            () => resolve(undefined),
            SCREEN_SHARE_CODEC_PROBE_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch {
      probes = undefined;
    }

    if (!probes) {
      console.info(
        `[rtc] screen share codec probe for ${key} timed out or failed, using vp9 for this share only`,
      );
      // Record it as the last decision without caching it. Skipping this
      // would leave `lastScreenShareCodecDecision` pointing at some earlier
      // share's result, and `screenSharePublishOptions` reads `cbpHardware`
      // off it -- so a stale `true` would pick an h264 backup codec on the
      // strength of a probe that never ran for this configuration.
      lastScreenShareCodecDecision = {
        key,
        codec: "vp9",
        reason: "probe timed out or failed; not cached, will retry next share",
        probes: [],
        cbpHardware: false,
        at: Date.now(),
      };
      return "vp9";
    }

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
  })();

  screenShareCodecInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    screenShareCodecInFlight.delete(key);
  }
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
  };
}

/** How long to wait after publishing before sampling for a software encoder. */
const SOFTWARE_FALLBACK_CHECK_DELAY_MS = 5_000;

/** At most this many automatic share recoveries ... */
const MAX_RECOVERIES = 3;

/** ... within this window, so a permanently broken capture cannot loop */
const RECOVERY_WINDOW_MS = 60_000;

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
  private screenShareTracks: Set<string>;
  private voiceProcessor?: VoiceProcessor;
  #localSpeakingMeter?: () => void;

  /** What the last successful share was started with, for recovery */
  #lastShareChoice?: { qualityName: ScreenShareQualityName; audio: boolean };
  #recoveryAttempts: number[] = [];
  #recovering = false;

  constructor(
    voiceSettings: VoiceSettings,
    modals: ModalController,
    sound: SoundController,
    device: Device,
  ) {
    this.#settings = voiceSettings;
    this.sound = sound;
    this.device = device;

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

    this.vidTracks = useTracks(
      [
        { source: Track.Source.Camera, withPlaceholder: true },
        { source: Track.Source.ScreenShare, withPlaceholder: false },
      ],
      { room, onlySubscribed: false },
    );

    batch(() => {
      this.#setRoom(room);
      this.#setChannel(channel);
      this.#setState("CONNECTING");
      this.#setVideo(false);
      this.#setScreenshare(false);
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

    room.addListener("disconnected", () => this.#setState("DISCONNECTED"));

    room.addListener("localTrackPublished", (pub) => {
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

      room.removeAllListeners();
      room.disconnect();

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
   */
  #screenShareQuality(): ScreenShareQualityName {
    const saved = this.#settings.screenShareQuality;
    // Only offer back a quality this instance actually enables, so a saved
    // "high" does not survive the video limit being lowered.
    return saved && this.getEnabledScreenShareQualities()[saved]
      ? saved
      : "low";
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
   * Warm the codec probe for the currently configured quality without
   * anyone waiting on it, so the first real `toggleScreenshare` call finds
   * an already-cached decision instead of eating the probe's latency.
   */
  #primeScreenShareCodec() {
    const quality =
      this.getEnabledScreenShareQualities()[this.#screenShareQuality()];
    void screenShareCodec(quality?.resolution);
  }

  async toggleScreenshare() {
    const room = this.room();
    if (!room) throw "invalid state";

    if (this.screenshare()) {
      // Deliberately stopping means there is nothing left to recover.
      this.#lastShareChoice = undefined;
      this.#recoveryAttempts = [];

      await room.localParticipant.setScreenShareEnabled(false);

      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

      this.sound.playSound("streamEnd");
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
            },
            publishOptions,
          );
        } finally {
          setNextScreenShareFrameRate(undefined);
        }

        const screenAudioTrack = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio,
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
          } else if (this.#settings.screenShareQualityAsk) {
            // No longer gated on there being more than one quality to choose
            // from: even with a single preset (an instance whose
            // video_resolution limit sits below 1080p) this dialog is still
            // the only place to toggle share audio at share time and to set
            // "Don't ask me again" -- losing it there would silently remove
            // both. Form2.ButtonGroup renders fine with one pre-selected
            // button.
            localTrack.pauseUpstream();
            screenAudioTrack?.pauseUpstream();
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
   * time rather than cached, precisely so a mid-share quality change (this
   * is only ever called from `#applyShareChoice`, which re-reads the live
   * track's settings every time it runs) recomputes it against the new
   * target instead of the one the share started with.
   *
   * The `maxFramerate` half is currently a no-op: both presets run at 30fps
   * (see `ScreenShareQualityName`), so this only ever writes the value that
   * was already there. Kept anyway -- it is three lines and it is the
   * mechanism that would make a mid-share framerate change take effect if a
   * differing-framerate preset is ever reintroduced.
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
      // Deliberately no `width`/`height` here any more: constraining capture
      // resolution forced a full-frame libyuv rescale on Chromium's capture
      // thread even when the source was already smaller, and Chromium's
      // capture governor (`capture_period = max(2 x last_capture_duration,
      // 1/target_fps)`) doubles the cost of anything that runs there.
      // `#applyEncoderLimits`'s `scaleResolutionDownBy` controls output
      // resolution on the encoder instead, where it's nearly free with
      // hardware H.26x.
      frameRate: {
        ideal: quality.resolution.frameRate,
        max: quality.resolution.frameRate,
      },
    });

    localTrack.videoTrack.mediaStreamTrack.contentHint = quality.contentHint;

    await this.#applyEncoderLimits(localTrack, quality.resolution);

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
   * Watch a screen share publication for its capture ending.
   *
   * Windows' WGC capturer reports a permanent error when the captured window
   * is destroyed and recreated -- which is what a game does when it switches
   * to fullscreen -- and LiveKit then unpublishes the track. The share is
   * fine, the capture handle is not, so try to pick the window back up.
   */
  #armScreenShareEnded(room: Room, localTrack: LocalTrackPublication) {
    localTrack.on("ended", () => {
      this.#onScreenShareEnded(room);
    });
  }

  async #onScreenShareEnded(room: Room) {
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

    if (await this.#recoverScreenShare(room)) return;

    // No bridge, nothing to recover, or recovery failed: stop as before.
    this.toggleScreenshare();
  }

  /**
   * Try to restart a screen share whose capture died underneath us.
   *
   * Needs the desktop bridge: only the main process can find the window again
   * and answer the next getDisplayMedia without showing the picker. On plain
   * web this always returns false and the share simply ends.
   * @param room Room
   * @returns Whether the share is back up
   */
  async #recoverScreenShare(room: Room): Promise<boolean> {
    const reacquire = window.native?.reacquireScreenShare;
    if (typeof reacquire !== "function") return false;

    const choice = this.#lastShareChoice;
    if (!choice || this.#recovering || !this.screenshare()) return false;

    const now = Date.now();
    this.#recoveryAttempts = this.#recoveryAttempts.filter(
      (at) => now - at < RECOVERY_WINDOW_MS,
    );
    if (this.#recoveryAttempts.length >= MAX_RECOVERIES) {
      console.warn("[rtc] screen share keeps dying, giving up on recovery");
      return false;
    }
    this.#recoveryAttempts.push(now);

    this.#recovering = true;
    try {
      // Main waits (up to a few minutes) for the window to come back; a
      // minimised window cannot be captured, so this can take a while.
      if (!(await reacquire())) return false;

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
      } finally {
        setNextScreenShareFrameRate(undefined);
      }

      if (!localTrack) return false;

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

      return true;
    } catch (err) {
      console.warn("[rtc] screen share recovery failed", err);
      return false;
    } finally {
      this.#recovering = false;
    }
  }

  toggleFullscreen(fullscreen: boolean = !this.fullscreen()) {
    this.#setFullscreen(fullscreen);
  }

  trackId(t: TrackReferenceOrPlaceholder) {
    return `${t.source}_${t.participant.sid}`;
  }

  toggleFocus(t?: TrackReferenceOrPlaceholder) {
    const id = t ? this.trackId(t) : undefined;
    this.#setFocus(
      this.focusId() === id || this.vidTracks().length < 2 ? undefined : id,
    );
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
  const voice = new Voice(state.voice, modals, sound, device);

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
