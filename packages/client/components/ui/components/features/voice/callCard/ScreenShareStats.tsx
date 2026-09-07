import { createSignal, onCleanup, Show } from "solid-js";

import type { TrackReference } from "solid-livekit-components";

import { isLocal } from "@livekit/components-core";
import { isScreenShareLinkWeak } from "@revolt/rtc";
import { Key } from "@solid-primitives/keyed";
import { type TrackPublication, Track } from "livekit-client";
import { styled } from "styled-system/jsx";

/**
 * Statistics for a screen share.
 *
 * For a share you are watching, this reads inbound-rtp off the receiver, so it
 * reports what actually arrived rather than what was requested. For your own
 * share it reads outbound-rtp and media-source off the sender instead, which
 * is the only way to tell the two halves of a framerate problem apart: what
 * the capturer produced versus what the encoder managed to send, and why it
 * was held back. The copy button produces a plain text block suitable for
 * pasting into a bug report.
 */

type Row = { label: string; value: string };

const NA = "--";

function formatBitrate(bitsPerSecond: number) {
  if (!bitsPerSecond) return NA;
  if (bitsPerSecond >= 1e6) return `${(bitsPerSecond / 1e6).toFixed(2)} Mbps`;
  return `${Math.round(bitsPerSecond / 1e3)} kbps`;
}

/**
 * The codec stat for an outbound/inbound-rtp's `codecId`, falling back to an
 * actual opus entry when the resolved one is RED.
 *
 * With `red: true` negotiated (see `screenSharePublishOptions`, rtc/state.tsx)
 * Chromium's RTP stream `codecId` can point at the `audio/red` codec stat --
 * whose `sdpFmtpLine` is the RED payload map (e.g. `111/111`), not opus's
 * `minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1`. That is expected once
 * RED is on, not an anomaly: the "Audio codec"/"Audio params" rows exist to
 * confirm `forceStereo`/`dtx` actually reached the wire, and a RED-only view
 * can't show either. So when the resolved codec is RED, look for any codec
 * stat in the same report that is genuinely opus instead. (Whether Chromium
 * actually resolves `codecId` to RED here could not be verified from source
 * -- this fallback keeps the row correct either way, RED-pointed or not.)
 */
function resolveAudioCodec(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  codecs: Map<string, any>,
  codecId: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const primary = codecId ? codecs.get(codecId) : undefined;
  if (!primary?.mimeType?.toLowerCase().endsWith("/red")) return primary;

  for (const stat of codecs.values()) {
    if (stat.mimeType?.toLowerCase().endsWith("opus")) return stat;
  }
  return primary;
}

export function ScreenShareStats(props: {
  trackRef: TrackReference;
  username: string;
  onClose?: () => void;
}) {
  const [rows, setRows] = createSignal<Row[]>([]);
  const [copied, setCopied] = createSignal(false);

  // Cumulative counters, so we can turn them into rates.
  let lastBytes = 0;
  let lastAt = 0;
  let lastFramesDecoded = 0;
  let lastFramesSent = 0;
  let lastTotalEncodeTime = 0;
  let lastFramesEncoded = 0;

  // Audio has its own sender/receiver, separate from the video ones above,
  // so it needs its own byte counter and its own timestamp to derive a rate
  // from -- reusing `lastAt` here would mix an audio delta with whatever
  // interval the video half happened to measure.
  let lastAudioBytes = 0;
  let lastAudioAt = 0;
  let lastInsertedSamplesForDeceleration = 0;
  let lastRemovedSamplesForAcceleration = 0;

  const sending = () => isLocal(props.trackRef.participant);

  /**
   * Video rows for your own share: what the capturer produced, what the
   * encoder actually sent, and what held it back. Audio is sampled and
   * combined separately in `sample()` so a video-side "nothing to report"
   * never hides whether audio is still flowing.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sampleOutboundVideo = async (track: any): Promise<Row[]> => {
    const sender: RTCRtpSender | undefined = track?.sender;

    if (!sender?.getStats) {
      return [{ label: "Status", value: "not publishing" }];
    }

    let report: RTCStatsReport;
    try {
      report = await sender.getStats();
    } catch {
      return [{ label: "Status", value: "stats unavailable" }];
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let outbound: any = null;
    let source: any = null;
    let remoteInbound: any = null;
    let candidatePair: any = null;
    const codecs = new Map<string, any>();
    let bytes = 0;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    report.forEach((stat) => {
      if (stat.type === "codec") codecs.set(stat.id, stat);
      if (stat.type === "media-source" && stat.kind === "video") source = stat;
      if (stat.type === "remote-inbound-rtp" && stat.kind === "video")
        remoteInbound = stat;
      if (stat.type === "candidate-pair" && stat.nominated)
        candidatePair = stat;
      if (stat.type === "outbound-rtp" && stat.kind === "video") {
        bytes += stat.bytesSent ?? 0;
        // Simulcast or a backup codec means several outbound streams; report
        // the largest, which is the one people are actually watching.
        if (!outbound || (stat.frameWidth ?? 0) > (outbound.frameWidth ?? 0)) {
          outbound = stat;
        }
      }
    });

    if (!outbound) {
      return [{ label: "Status", value: "no video being sent" }];
    }

    const now = performance.now();
    let bitrate = 0;
    if (lastAt) {
      const seconds = (now - lastAt) / 1000;
      if (seconds > 0) bitrate = ((bytes - lastBytes) * 8) / seconds;
    }

    let fps: number | undefined = outbound.framesPerSecond;
    const framesSent = outbound.framesSent ?? 0;
    if (fps === undefined && lastAt) {
      const seconds = (now - lastAt) / 1000;
      if (seconds > 0) fps = (framesSent - lastFramesSent) / seconds;
    }

    // Mean time the encoder spent per frame, over just this sample window
    // (not the cumulative average since the share started) -- against the
    // budget one frame has at the current framerate.
    const totalEncodeTime = outbound.totalEncodeTime ?? 0;
    const framesEncoded = outbound.framesEncoded ?? 0;
    const framesEncodedDelta = framesEncoded - lastFramesEncoded;
    let encodeTimeMs: number | undefined;
    if (lastAt && framesEncodedDelta > 0) {
      encodeTimeMs =
        ((totalEncodeTime - lastTotalEncodeTime) / framesEncodedDelta) * 1000;
    }

    lastBytes = bytes;
    lastAt = now;
    lastFramesSent = framesSent;
    lastTotalEncodeTime = totalEncodeTime;
    lastFramesEncoded = framesEncoded;

    const codec = codecs.get(outbound.codecId);

    // The budget line for "Encode time" needs the framerate we asked for,
    // not `fps` (the measured send rate) -- when the encoder stalls, the
    // measured rate drops, which *grows* the budget and makes a stalled
    // encoder look healthier the worse it gets. `sender.getParameters()` is
    // the encoder's actual ceiling; `getConstraints()` (max, then ideal) is
    // what capture was asked for if the sender has no encodings yet.
    // Deliberately never `getSettings().frameRate` here -- that is measured
    // too, and would reintroduce the same circularity.
    const targetFrameRate: number | undefined = (() => {
      const maxFramerate = sender.getParameters().encodings?.[0]?.maxFramerate;
      if (maxFramerate) return maxFramerate;

      const frameRateConstraint =
        track?.mediaStreamTrack?.getConstraints?.().frameRate;
      if (typeof frameRateConstraint === "number") return frameRateConstraint;
      return frameRateConstraint?.max ?? frameRateConstraint?.ideal;
    })();

    // The encoder's actual bitrate ceiling in force, for the "Weak link" row
    // below -- read the same way as targetFrameRate above, straight off the
    // sender's own parameters rather than re-derived from the quality name.
    const maxBitrate: number | undefined =
      sender.getParameters().encodings?.[0]?.maxBitrate;

    // Where the time went while quality was limited -- `cpu` here means the
    // encoder could not keep up, `bandwidth` means the network could not.
    const durations = outbound.qualityLimitationDurations ?? {};
    const limitBreakdown = ["cpu", "bandwidth", "other"]
      .filter((k) => (durations[k] ?? 0) > 0.1)
      .map((k) => `${k} ${(durations[k] as number).toFixed(1)}s`)
      .join(", ");

    return [
      {
        label: "Capture",
        value: source?.width ? `${source.width}x${source.height}` : NA,
      },
      {
        label: "Capture rate",
        value:
          source?.framesPerSecond !== undefined
            ? `${Math.round(source.framesPerSecond)} fps`
            : NA,
      },
      {
        label: "Sending",
        value: outbound.frameWidth
          ? `${outbound.frameWidth}x${outbound.frameHeight}`
          : NA,
      },
      { label: "Send rate", value: fps ? `${Math.round(fps)} fps` : NA },
      { label: "Bitrate", value: formatBitrate(bitrate) },
      {
        label: "Codec",
        value: codec?.mimeType ? codec.mimeType.replace("video/", "") : NA,
      },
      // Lets the CBP assumption behind the h264 hardware probe (see
      // screenShareCodec in rtc/state.tsx) be checked empirically: this is
      // the profile actually negotiated with the SFU, not just the one we
      // asked for.
      { label: "Codec params", value: codec?.sdpFmtpLine ?? NA },
      { label: "Encoder", value: outbound.encoderImplementation ?? NA },
      {
        label: "Encode time",
        value:
          encodeTimeMs !== undefined
            ? targetFrameRate
              ? `${encodeTimeMs.toFixed(1)} ms / ${(1000 / targetFrameRate).toFixed(1)} ms`
              : `${encodeTimeMs.toFixed(1)} ms`
            : NA,
      },
      { label: "Scalability", value: outbound.scalabilityMode ?? NA },
      {
        label: "Limited by",
        value: outbound.qualityLimitationReason ?? NA,
      },
      { label: "Limited for", value: limitBreakdown || "never" },
      {
        label: "Frames sent",
        value: `${framesSent} of ${outbound.framesEncoded ?? 0} encoded`,
      },
      {
        label: "Packets lost",
        value:
          remoteInbound?.packetsLost !== undefined
            ? `${remoteInbound.packetsLost}`
            : NA,
      },
      {
        label: "Round trip",
        value:
          remoteInbound?.roundTripTime !== undefined
            ? `${Math.round(remoteInbound.roundTripTime * 1000)} ms`
            : NA,
      },
      {
        label: "Link capacity",
        value: candidatePair?.availableOutgoingBitrate
          ? formatBitrate(candidatePair.availableOutgoingBitrate)
          : NA,
      },
      {
        // Same check as the one-time weak-link warning in rtc/state.tsx
        // (see isScreenShareLinkWeak), kept visible here for as long as the
        // share runs rather than shown once and then gone. Reads only stats
        // already sampled above -- the bitrate ceiling from the sender's own
        // parameters (the actual ceiling in force, not just what the current
        // ScreenShareQualityName implies), "Link capacity", and the
        // bandwidth-limited share of "Limited for".
        label: "Weak link",
        value: maxBitrate
          ? isScreenShareLinkWeak(
              maxBitrate,
              candidatePair?.availableOutgoingBitrate,
              durations.bandwidth,
            )
            ? "yes"
            : "no"
          : NA,
      },
      {
        label: "NACK / PLI",
        value: `${outbound.nackCount ?? 0} / ${outbound.pliCount ?? 0}`,
      },
    ];
  };

  /**
   * Audio rows for a share you are sending: bitrate off the audio
   * outbound-rtp, the encoder's actual ceiling from `getParameters()` (so the
   * preset set in `screenSharePublishOptions`, rtc/state.tsx, can be
   * confirmed to have really reached the sender rather than trusting the
   * publish call was accepted as asked), the negotiated codec/params, and
   * loss + RTT off the matching remote-inbound-rtp -- the same fields the
   * video rows above already pull from their own remote-inbound-rtp.
   *
   * "not shared" only means there is no `ScreenShareAudio` publication at
   * all. A publication with no live sender, or one that hasn't produced an
   * outbound-rtp stat yet, gets its own label -- otherwise there is no way
   * to tell "not sending audio" apart from "sending, stats just not in yet".
   */
  const sampleOutboundAudio = async (
    pub: TrackPublication | undefined,
  ): Promise<Row[]> => {
    if (!pub) {
      return [{ label: "Audio", value: "not shared" }];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sender: RTCRtpSender | undefined = (pub.track as any)?.sender;

    if (!sender?.getStats) {
      lastAudioBytes = 0;
      lastAudioAt = 0;
      return [{ label: "Audio", value: "not publishing" }];
    }

    let report: RTCStatsReport;
    // `getParameters()` shares the try/catch with `getStats()` -- per spec it
    // throws `InvalidStateError` on a stopped/stopping transceiver, and this
    // whole function runs bare off a `setInterval` tick with no `.catch`, so
    // an uncaught throw here becomes an unhandled rejection that leaves the
    // panel stuck on stale numbers instead of reporting the teardown.
    let maxBitrate: number | undefined;
    try {
      report = await sender.getStats();
      maxBitrate = sender.getParameters().encodings?.[0]?.maxBitrate;
    } catch {
      lastAudioBytes = 0;
      lastAudioAt = 0;
      return [{ label: "Audio", value: "stats unavailable" }];
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let outbound: any = null;
    let remoteInbound: any = null;
    const codecs = new Map<string, any>();
    /* eslint-enable @typescript-eslint/no-explicit-any */
    let bytes = 0;

    report.forEach((stat) => {
      if (stat.type === "codec") codecs.set(stat.id, stat);
      if (stat.type === "remote-inbound-rtp" && stat.kind === "audio")
        remoteInbound = stat;
      if (stat.type === "outbound-rtp" && stat.kind === "audio") {
        bytes += stat.bytesSent ?? 0;
        outbound = stat;
      }
    });

    if (!outbound) {
      // Publication and sender exist, but the RTP stats haven't shown up in
      // a report yet -- normal for the first tick or two after publishing.
      lastAudioBytes = 0;
      lastAudioAt = 0;
      return [{ label: "Audio", value: "stats pending" }];
    }

    const now = performance.now();
    let bitrate = 0;
    if (lastAudioAt) {
      const seconds = (now - lastAudioAt) / 1000;
      if (seconds > 0) bitrate = ((bytes - lastAudioBytes) * 8) / seconds;
    }
    lastAudioBytes = bytes;
    lastAudioAt = now;

    const codec = resolveAudioCodec(codecs, outbound.codecId);

    return [
      // `bytesSent` includes RED's redundant copies on top of the opus
      // payload, so this reads roughly double the encoder's own target --
      // 64 kbps stereo + RED lands near 128 kbps here. Labelled so "did the
      // preset land?" isn't answered by comparing this straight against
      // "Audio max bitrate" below and concluding it didn't.
      { label: "Audio bitrate (incl. RED)", value: formatBitrate(bitrate) },
      {
        label: "Audio max bitrate",
        value: maxBitrate ? formatBitrate(maxBitrate) : NA,
      },
      {
        label: "Audio codec",
        value: codec?.mimeType
          ? `${codec.mimeType.replace("audio/", "")}${
              codec.channels ? ` ${codec.channels}ch` : ""
            }`
          : NA,
      },
      { label: "Audio params", value: codec?.sdpFmtpLine ?? NA },
      {
        label: "Audio packets lost",
        value:
          remoteInbound?.packetsLost !== undefined
            ? `${remoteInbound.packetsLost}`
            : NA,
      },
      {
        label: "Audio round trip",
        value:
          remoteInbound?.roundTripTime !== undefined
            ? `${Math.round(remoteInbound.roundTripTime * 1000)} ms`
            : NA,
      },
    ];
  };

  /**
   * Video rows for a share you are watching: what actually arrived, decoded
   * off the receiver. Audio is sampled and combined separately in `sample()`
   * so a video-side "nothing to report" never hides whether audio is still
   * flowing -- that is exactly the question a dead video track raises.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sampleInboundVideo = async (track: any): Promise<Row[]> => {
    const receiver: RTCRtpReceiver | undefined = track?.receiver;

    if (!receiver?.getStats) {
      return [{ label: "Status", value: "no receiver (not subscribed?)" }];
    }

    let report: RTCStatsReport;
    try {
      report = await receiver.getStats();
    } catch {
      return [{ label: "Status", value: "stats unavailable" }];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let inbound: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const codecs = new Map<string, any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let candidatePair: any = null;

    report.forEach((stat) => {
      if (stat.type === "codec") codecs.set(stat.id, stat);
      if (stat.type === "inbound-rtp" && stat.kind === "video") inbound = stat;
      if (stat.type === "candidate-pair" && stat.nominated)
        candidatePair = stat;
    });

    if (!inbound) {
      return [{ label: "Status", value: "no video being received" }];
    }

    const now = performance.now();
    const bytes = inbound.bytesReceived ?? 0;
    let bitrate = 0;
    if (lastAt) {
      const seconds = (now - lastAt) / 1000;
      if (seconds > 0) bitrate = ((bytes - lastBytes) * 8) / seconds;
    }

    // The browser only reports framesPerSecond once it has a stable estimate,
    // so derive it from the decode counter as a fallback.
    let fps: number | undefined = inbound.framesPerSecond;
    const framesDecoded = inbound.framesDecoded ?? 0;
    if (fps === undefined && lastAt) {
      const seconds = (now - lastAt) / 1000;
      if (seconds > 0) fps = (framesDecoded - lastFramesDecoded) / seconds;
    }

    lastBytes = bytes;
    lastAt = now;
    lastFramesDecoded = framesDecoded;

    const codec = codecs.get(inbound.codecId);
    const received = inbound.packetsReceived ?? 0;
    const lost = inbound.packetsLost ?? 0;
    const lossPct =
      received + lost > 0 ? ((lost / (received + lost)) * 100).toFixed(2) : "0";

    const jitterBufferMs =
      inbound.jitterBufferDelay && inbound.jitterBufferEmittedCount
        ? Math.round(
            (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) *
              1000,
          )
        : undefined;

    return [
      {
        label: "Resolution",
        value: inbound.frameWidth
          ? `${inbound.frameWidth}x${inbound.frameHeight}`
          : NA,
      },
      { label: "Frame rate", value: fps ? `${Math.round(fps)} fps` : NA },
      { label: "Bitrate", value: formatBitrate(bitrate) },
      {
        label: "Codec",
        value: codec?.mimeType ? codec.mimeType.replace("video/", "") : NA,
      },
      { label: "Decoder", value: inbound.decoderImplementation ?? NA },
      { label: "Packets lost", value: `${lost} (${lossPct}%)` },
      {
        label: "Frames dropped",
        value: `${inbound.framesDropped ?? 0} of ${framesDecoded}`,
      },
      {
        label: "Freezes",
        value:
          inbound.freezeCount !== undefined
            ? `${inbound.freezeCount} (${(
                inbound.totalFreezesDuration ?? 0
              ).toFixed(1)}s)`
            : NA,
      },
      {
        label: "Jitter",
        value:
          inbound.jitter !== undefined
            ? `${Math.round(inbound.jitter * 1000)} ms`
            : NA,
      },
      {
        label: "Jitter buffer",
        value: jitterBufferMs !== undefined ? `${jitterBufferMs} ms` : NA,
      },
      {
        label: "Round trip",
        value: candidatePair?.currentRoundTripTime
          ? `${Math.round(candidatePair.currentRoundTripTime * 1000)} ms`
          : NA,
      },
      {
        label: "Link capacity",
        value: candidatePair?.availableIncomingBitrate
          ? formatBitrate(candidatePair.availableIncomingBitrate)
          : NA,
      },
      {
        label: "NACK / PLI",
        value: `${inbound.nackCount ?? 0} / ${inbound.pliCount ?? 0}`,
      },
    ];
  };

  /**
   * Audio rows for a share you are watching: the codec/params as actually
   * negotiated (so the `forceStereo`/`dtx`/`red` choices in
   * `screenSharePublishOptions`, rtc/state.tsx, can be confirmed on the wire
   * rather than assumed from what was asked for), received bitrate, loss,
   * jitter and jitter buffer delay (the last derived the same way as the
   * video rows above), and the concealment/resync counters that tell what
   * kind of degradation is happening rather than just that it is.
   *
   * The concealment row is the one this fix is meant to move: DTX gates
   * transmission off on purpose and the decoder fills the gap with silence,
   * so `silentConcealedSamples / concealedSamples` sits near 1 for that
   * cause. Packet-loss concealment instead reconstructs audio that really
   * existed, so its ratio is small. A high value here after `dtx: false`
   * would mean DTX is somehow still active.
   *
   * "not shared" only means there is no `ScreenShareAudio` publication at
   * all -- the sharer isn't sending audio. A publication that exists but has
   * no subscribed track, or one whose stats haven't shown up yet, gets its
   * own label: otherwise a viewer can't tell "the sharer isn't sharing
   * audio" from "I haven't subscribed yet" or "just subscribed, no stats
   * yet", three different states this row used to collapse into one.
   */
  const sampleInboundAudio = async (
    pub: TrackPublication | undefined,
  ): Promise<Row[]> => {
    if (!pub) {
      return [{ label: "Audio", value: "not shared" }];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receiver: RTCRtpReceiver | undefined = (pub.track as any)?.receiver;

    if (!receiver?.getStats) {
      lastAudioBytes = 0;
      lastAudioAt = 0;
      lastInsertedSamplesForDeceleration = 0;
      lastRemovedSamplesForAcceleration = 0;
      return [{ label: "Audio", value: "not subscribed" }];
    }

    let report: RTCStatsReport;
    try {
      report = await receiver.getStats();
    } catch {
      lastAudioBytes = 0;
      lastAudioAt = 0;
      lastInsertedSamplesForDeceleration = 0;
      lastRemovedSamplesForAcceleration = 0;
      return [{ label: "Audio", value: "stats unavailable" }];
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let inbound: any = null;
    const codecs = new Map<string, any>();
    /* eslint-enable @typescript-eslint/no-explicit-any */

    report.forEach((stat) => {
      if (stat.type === "codec") codecs.set(stat.id, stat);
      if (stat.type === "inbound-rtp" && stat.kind === "audio") inbound = stat;
    });

    if (!inbound) {
      // Subscribed, but no inbound-rtp stat in this report yet -- normal
      // right after subscribing, before the first RTP has been counted.
      lastAudioBytes = 0;
      lastAudioAt = 0;
      lastInsertedSamplesForDeceleration = 0;
      lastRemovedSamplesForAcceleration = 0;
      return [{ label: "Audio", value: "stats pending" }];
    }

    const now = performance.now();
    const bytes = inbound.bytesReceived ?? 0;
    let bitrate = 0;
    if (lastAudioAt) {
      const seconds = (now - lastAudioAt) / 1000;
      if (seconds > 0) bitrate = ((bytes - lastAudioBytes) * 8) / seconds;
    }

    // NetEq's adaptive-playout counters -- how many samples it has had to
    // insert (stretching audio to ride out a jitter spike) or drop (catching
    // back up once the spike passes) since the last tick. Cumulative counts
    // would just grow for the life of the share; the delta is what says
    // whether resync is happening *right now*. Kept as `undefined` (rather
    // than defaulting to 0) whenever the underlying field is absent, so a
    // browser that doesn't report these counters shows `--` instead of a
    // resync rate that looks like a real, healthy zero.
    const insertedForDeceleration: number | undefined =
      inbound.insertedSamplesForDeceleration;
    const removedForAcceleration: number | undefined =
      inbound.removedSamplesForAcceleration;
    const insertedDelta =
      lastAudioAt && insertedForDeceleration !== undefined
        ? insertedForDeceleration - lastInsertedSamplesForDeceleration
        : undefined;
    const removedDelta =
      lastAudioAt && removedForAcceleration !== undefined
        ? removedForAcceleration - lastRemovedSamplesForAcceleration
        : undefined;

    lastAudioBytes = bytes;
    lastAudioAt = now;
    lastInsertedSamplesForDeceleration =
      insertedForDeceleration ?? lastInsertedSamplesForDeceleration;
    lastRemovedSamplesForAcceleration =
      removedForAcceleration ?? lastRemovedSamplesForAcceleration;

    const codec = resolveAudioCodec(codecs, inbound.codecId);
    const received = inbound.packetsReceived ?? 0;
    const lost = inbound.packetsLost ?? 0;
    const lossPct =
      received + lost > 0 ? ((lost / (received + lost)) * 100).toFixed(2) : "0";

    const jitterBufferMs =
      inbound.jitterBufferDelay && inbound.jitterBufferEmittedCount
        ? Math.round(
            (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) *
              1000,
          )
        : undefined;

    // totalSamplesDuration is in seconds; multiplying by the codec's own
    // clock rate turns it into the sample count that should have arrived,
    // which concealedSamples can be measured against as a share of the
    // whole stream rather than a raw, ever-growing counter. `codec` (and so
    // `clockRate`) can fail to resolve -- e.g. the codec stat isn't in this
    // report yet -- and that must not collapse to the same "0%" a share with
    // genuinely zero concealment would show. Every field below that can be
    // legitimately absent is threaded through as `undefined`, not `0`, all
    // the way to display, so a missing value renders as `--` rather than
    // silently reading as "all clear" -- the one thing this row must never
    // do, since it's the row this whole PR exists to read.
    const concealmentEvents: number | undefined = inbound.concealmentEvents;
    const concealedSamples: number | undefined = inbound.concealedSamples;
    const silentConcealedSamples: number | undefined =
      inbound.silentConcealedSamples;

    const sampleRate: number | undefined = codec?.clockRate;
    const totalSamplesExpected =
      sampleRate !== undefined
        ? (inbound.totalSamplesDuration ?? 0) * sampleRate
        : undefined;

    const concealedPct =
      totalSamplesExpected === undefined || concealedSamples === undefined
        ? NA
        : totalSamplesExpected > 0
          ? `${((concealedSamples / totalSamplesExpected) * 100).toFixed(2)}%`
          : "0.00%";

    const silentSharePct =
      concealedSamples === undefined || silentConcealedSamples === undefined
        ? NA
        : concealedSamples > 0
          ? `${((silentConcealedSamples / concealedSamples) * 100).toFixed(0)}%`
          : "0%";

    return [
      {
        label: "Audio codec",
        value: codec?.mimeType
          ? `${codec.mimeType.replace("audio/", "")}${
              codec.channels ? ` ${codec.channels}ch` : ""
            }`
          : NA,
      },
      { label: "Audio params", value: codec?.sdpFmtpLine ?? NA },
      // See the outbound row's comment -- `bytesReceived` counts RED's
      // redundant copies too, so this also reads roughly double the opus
      // target.
      { label: "Audio bitrate (incl. RED)", value: formatBitrate(bitrate) },
      { label: "Audio packets lost", value: `${lost} (${lossPct}%)` },
      {
        label: "Audio jitter",
        value:
          inbound.jitter !== undefined
            ? `${Math.round(inbound.jitter * 1000)} ms`
            : NA,
      },
      {
        label: "Audio jitter buffer",
        value: jitterBufferMs !== undefined ? `${jitterBufferMs} ms` : NA,
      },
      {
        label: "Audio concealment",
        value: `${
          concealmentEvents !== undefined ? concealmentEvents : NA
        } events, ${concealedPct} concealed, ${silentSharePct} silent`,
      },
      {
        label: "Audio resync",
        value:
          insertedDelta !== undefined && removedDelta !== undefined
            ? `+${insertedDelta} / -${removedDelta} samples`
            : NA,
      },
    ];
  };

  const sample = async () => {
    // The panel keeps sampling on a 1s timer for as long as it is mounted,
    // regardless of tab visibility -- `getStats()` on a hidden tab is pure
    // waste, nobody is reading these numbers. This is about the *sampling*
    // work only, not the underlying media subscription: unlike the sampling
    // loop, the tracks themselves must keep decoding while hidden (no
    // adaptiveStream/visibility-based pausing -- see ParticipantTile.tsx),
    // so this early return must never be reused for anything beyond stats.
    if (document.hidden) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const track = props.trackRef.publication?.track as any;
    const audioPub = props.trackRef.participant.getTrackPublication(
      Track.Source.ScreenShareAudio,
    );

    // Audio is sampled alongside video, never gated behind it: every video
    // early-return above ("no video being sent", "no receiver", ...) used to
    // call setRows and return before the audio rows were ever computed, which
    // is exactly backwards -- "video is dead, is audio still flowing?" is a
    // question this panel needs to answer precisely when video has nothing
    // to say.
    // Nothing below may throw out of here. This runs bare off a `setInterval`
    // tick and from the unawaited call under it, so an escaping rejection is
    // unhandled -- and since the two halves are gathered with `Promise.all`,
    // one throw would take the other half's rows down with it. The realistic
    // thrower is `getParameters()` on a stopped/stopping transceiver (per
    // spec, InvalidStateError) -- still called outside the try in
    // `sampleOutboundVideo` -- i.e. the panel being open while a share is
    // torn down, which the change-source flow does routinely. Holding the
    // previous rows for one tick and recovering on the next is the right
    // failure mode for a 1 s diagnostic; going permanently stale is not.
    try {
      const [videoRows, audioRows] = sending()
        ? await Promise.all([
            sampleOutboundVideo(track),
            sampleOutboundAudio(audioPub),
          ])
        : await Promise.all([
            sampleInboundVideo(track),
            sampleInboundAudio(audioPub),
          ]);

      setRows([...videoRows, ...audioRows]);
    } catch {
      // Leave the last good rows in place; the next tick re-samples.
    }
  };

  sample();
  const timer = setInterval(sample, 1000);
  onCleanup(() => clearInterval(timer));

  const copy = async () => {
    const body = rows()
      .map((r) => `${r.label.padEnd(18)} ${r.value}`)
      .join("\n");
    const text = [
      `screen share stats -- ${props.username}`,
      `direction ${sending() ? "outbound (sender)" : "inbound (viewer)"}`,
      `captured ${new Date().toISOString()}`,
      `user agent ${navigator.userAgent}`,
      "",
      body,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <Panel onClick={(e) => e.stopPropagation()}>
      <Header>
        <span>stats for nerds{sending() ? " -- your share" : ""}</span>
        <Buttons>
          <Action onClick={copy}>{copied() ? "copied" : "copy"}</Action>
          <Show when={props.onClose}>
            <Action onClick={() => props.onClose?.()}>close</Action>
          </Show>
        </Buttons>
      </Header>
      <Grid>
        {/*
         * Keyed by label rather than plain `<For>`: `sample()` replaces the
         * whole `rows` array with brand-new row objects every tick, so a
         * plain `<For>` (which reconciles by reference) would tear down and
         * rebuild every `<Label>`/`<Value>` pair once a second even though
         * almost none of them actually changed. `<Key>` diffs by `label`
         * instead, so only rows whose *value* actually changed re-render.
         */}
        <Key each={rows()} by="label">
          {(row) => (
            <>
              <Label>{row().label}</Label>
              <Value>{row().value}</Value>
            </>
          )}
        </Key>
      </Grid>
    </Panel>
  );
}

const Panel = styled("div", {
  base: {
    gridArea: "1/1",
    alignSelf: "start",
    justifySelf: "start",
    margin: "var(--gap-md)",
    padding: "var(--gap-md)",
    zIndex: 10,

    maxWidth: "min(320px, 90%)",
    borderRadius: "var(--borderRadius-md)",
    background: "#000000cc",
    color: "#fff",
    backdropFilter: "blur(4px)",

    fontFamily: "var(--fonts-monospace, monospace)",
    fontSize: "11px",
    lineHeight: 1.5,
    cursor: "default",
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",
    marginBottom: "var(--gap-sm)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    opacity: 0.7,
  },
});

const Buttons = styled("div", {
  base: { display: "flex", gap: "var(--gap-sm)" },
});

const Action = styled("button", {
  base: {
    all: "unset",
    cursor: "pointer",
    padding: "0 4px",
    borderRadius: "3px",
    border: "1px solid #fff4",
    fontSize: "10px",
    textTransform: "uppercase",
    _hover: { background: "#fff2" },
  },
});

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "var(--gap-md)",
  },
});

const Label = styled("div", { base: { opacity: 0.6, whiteSpace: "nowrap" } });

const Value = styled("div", {
  base: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
});
