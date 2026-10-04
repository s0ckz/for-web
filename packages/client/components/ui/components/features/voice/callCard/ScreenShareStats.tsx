import {
  Accessor,
  createEffect,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";

import type { TrackReference } from "solid-livekit-components";

import { useLingui } from "@lingui/solid/macro";
import { isLocal } from "@livekit/components-core";
import {
  screenShareBandwidthConfiguration,
  ScreenShareBandwidthObserver,
} from "@revolt/rtc/screenShareBandwidth";
import {
  pollScreenShareStats,
  selectedCandidatePair,
  StatsCounters,
  VideoPresentation,
} from "@revolt/rtc/screenShareTelemetry";
import { Key } from "@solid-primitives/keyed";
import { type TrackPublication, Track } from "livekit-client";
import { styled } from "styled-system/jsx";

import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Statistics for a screen share.
 *
 * For a share you are watching, this reads inbound-rtp off the receiver, so it
 * separates received/decoded rates from video-element compositor presentation. For your own
 * share it reads outbound-rtp and media-source counters off the sender, which
 * is the only way to tell the two halves of a framerate problem apart: what
 * the capturer produced versus what the encoder managed to send, and why it
 * was held back. The copy button produces a plain text block suitable for
 * pasting into a bug report.
 */

type Row = { label: string; value: string };

const NA = "--";

function formatBitrate(bitsPerSecond: number | undefined) {
  if (bitsPerSecond === undefined || !Number.isFinite(bitsPerSecond)) return NA;
  if (bitsPerSecond >= 1e6) return `${(bitsPerSecond / 1e6).toFixed(2)} Mbps`;
  return `${Math.round(bitsPerSecond / 1e3)} kbps`;
}

function formatFps(fps: number | undefined) {
  return fps !== undefined && Number.isFinite(fps)
    ? `${fps.toFixed(1)} fps`
    : NA;
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

/**
 * Live summary of the local sender's own encode, for the compact badge
 * `ParticipantTile.tsx` shows on the sharer's own tile -- derived from the
 * same sample as the "Encoder"/"Send rate"/"Limited by" rows below rather
 * than a second `getStats()` read.
 */
type OwnSummary = {
  /** Chromium's own hardware-vs-software verdict for this encode, when it reports one. */
  hardware?: boolean;
  /** Most recent send rate, already rounded. */
  fps?: number;
  /** `RTCOutboundRtpStreamStats.qualityLimitationReason`, verbatim ("none" included). */
  limitedBy?: string;
  /**
   * Cumulative frames actually sent, straight off `outbound-rtp`. Lets
   * `ScreenShareBadge` tell "genuinely nothing sent yet" (`0`) apart from
   * "sending, `fps` just hasn't been computed for this tick yet" -- `fps`
   * alone can't do that, since it's `undefined` on the very first sample
   * even once frames are flowing.
   */
  framesSent?: number;
};

/**
 * One sampler shared between the full "stats for nerds" panel and the
 * sharer's own-tile badge, so a self-share is only ever polled by
 * `getStats()` once a second, not once per consumer.
 *
 * Everything that used to be local state inside the `ScreenShareStats`
 * component now lives in this factory instead, so `ParticipantTile.tsx` can
 * create one instance for the sharer's own tile -- outliving the panel being
 * opened/closed -- and hand it to `ScreenShareStats` (via the `sample`
 * prop) and `ScreenShareBadge` alike. Every other caller (watching someone
 * else's share) still has `ScreenShareStats` create its own, exactly as
 * before.
 * @param trackRef The screen-share track to sample
 * @returns The sampled rows, whether this is your own share, and the badge's summary
 */
export function createScreenShareSample(
  trackRef: Accessor<TrackReference>,
  videoElement?: Accessor<HTMLVideoElement | undefined>,
) {
  const [rows, setRows] = createSignal<Row[]>([]);
  const [ownSummary, setOwnSummary] = createSignal<OwnSummary | undefined>();

  const videoCounters = new StatsCounters();
  const audioCounters = new StatsCounters();
  const bandwidth = new ScreenShareBandwidthObserver();
  const presentation = new VideoPresentation();
  let videoStreamId: string | undefined;
  let audioStreamId: string | undefined;
  const reset = () => {
    videoCounters.reset();
    audioCounters.reset();
    bandwidth.reset();
    videoStreamId = undefined;
    audioStreamId = undefined;
    presentation.reset();
    setRows([]);
    setOwnSummary(undefined);
  };

  const sending = () => isLocal(trackRef().participant);

  /**
   * Video rows for your own share: what the capturer produced, what the
   * encoder actually sent, and what held it back. Audio is sampled and
   * combined separately in `sample()` so a video-side "nothing to report"
   * never hides whether audio is still flowing.
   */
  const sampleOutboundVideo = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    track: any,
    isCurrent: () => boolean,
  ): Promise<{ rows: Row[]; summary?: OwnSummary }> => {
    const sender: RTCRtpSender | undefined = track?.sender;

    if (!sender?.getStats) {
      videoCounters.reset();
      bandwidth.reset();
      return { rows: [{ label: "Status", value: "not publishing" }] };
    }

    let report: RTCStatsReport;
    try {
      report = await sender.getStats();
      if (!isCurrent()) return { rows: [] };
    } catch {
      if (isCurrent()) {
        videoCounters.reset();
        bandwidth.reset();
      }
      return { rows: [{ label: "Status", value: "stats unavailable" }] };
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let outbound: any = null;
    let source: any = null;
    let remoteInbound: any = null;
    let candidatePair: any = null;
    const codecs = new Map<string, any>();
    /* eslint-enable @typescript-eslint/no-explicit-any */

    let rates = videoCounters.read(report.values(), sender);
    let outboundAdvancing = false;
    report.forEach((stat) => {
      if (stat.type === "codec") codecs.set(stat.id, stat);
      if (stat.type === "outbound-rtp" && stat.kind === "video") {
        // A sender does not know which layer each viewer is watching.
        // Describe the largest active stream and label its bitrate accordingly.
        const advancing = (rates.rate(stat, "framesSent") ?? 0) > 0;
        if (
          stat.active !== false &&
          (!outbound ||
            (advancing && !outboundAdvancing) ||
            (advancing === outboundAdvancing &&
              (stat.frameWidth ?? 0) > (outbound.frameWidth ?? 0)))
        ) {
          outbound = stat;
          outboundAdvancing = advancing;
        }
      }
    });

    if (!outbound) {
      videoCounters.reset();
      bandwidth.reset();
      return { rows: [{ label: "Status", value: "no video being sent" }] };
    }

    if (videoStreamId !== outbound.id) {
      videoCounters.reset();
      rates = videoCounters.read(report.values(), sender);
    }
    videoStreamId = outbound.id;
    const sources = Array.from(report.values()).filter(
      (stat) =>
        stat.type === "media-source" &&
        stat.kind === "video" &&
        (!stat.trackIdentifier ||
          stat.trackIdentifier === track?.mediaStreamTrack?.id),
    );
    source = outbound.mediaSourceId
      ? report.get(outbound.mediaSourceId)
      : sources.length === 1
        ? sources[0]
        : undefined;
    remoteInbound = outbound.remoteId
      ? report.get(outbound.remoteId)
      : Array.from(report.values()).find(
          (stat) =>
            stat.type === "remote-inbound-rtp" && stat.localId === outbound.id,
        );
    candidatePair = selectedCandidatePair(report, outbound);
    const byteRate = rates.rate(outbound, "bytesSent");
    const bitrate = byteRate === undefined ? undefined : byteRate * 8;
    const fps = rates.rate(outbound, "framesSent");
    const encodedFps = rates.rate(outbound, "framesEncoded");
    const sourceFps = source ? rates.rate(source, "frames") : undefined;
    const framesSent: number | undefined = outbound.framesSent;

    // Mean time the encoder spent per frame, over just this sample window
    // (not the cumulative average since the share started) -- against the
    // budget one frame has at the current framerate.
    const encodeSeconds = rates.delta(outbound, "totalEncodeTime");
    const framesEncodedDelta = rates.delta(outbound, "framesEncoded");
    const qpDelta = rates.delta(outbound, "qpSum");
    const meanQp =
      qpDelta !== undefined &&
      framesEncodedDelta !== undefined &&
      framesEncodedDelta > 0
        ? qpDelta / framesEncodedDelta
        : undefined;
    const sendDelay = rates.delta(outbound, "totalPacketSendDelay");
    const packetsSentDelta = rates.delta(outbound, "packetsSent");
    const meanSendDelayMs =
      sendDelay !== undefined &&
      packetsSentDelta !== undefined &&
      packetsSentDelta > 0
        ? (sendDelay * 1000) / packetsSentDelta
        : undefined;
    const retransmittedByteRate = rates.rate(
      outbound,
      "retransmittedBytesSent",
    );
    let encodeTimeMs: number | undefined;
    if (
      encodeSeconds !== undefined &&
      framesEncodedDelta !== undefined &&
      framesEncodedDelta > 0
    ) {
      encodeTimeMs = (encodeSeconds / framesEncodedDelta) * 1000;
    }

    // Different pipeline stages can straddle sample windows. This gap is
    // diagnostic evidence of backlog/omission, not an exact dropped-frame count.
    const sourceEncodeGap =
      sourceFps !== undefined && encodedFps !== undefined
        ? Math.max(0, sourceFps - encodedFps)
        : undefined;

    const codec = codecs.get(outbound.codecId);

    // The budget line for "Encode time" needs the framerate we asked for,
    // not `fps` (the measured send rate) -- when the encoder stalls, the
    // measured rate drops, which *grows* the budget and makes a stalled
    // encoder look healthier the worse it gets. `sender.getParameters()` is
    // the encoder's actual ceiling; `getConstraints()` (max, then ideal) is
    // what capture was asked for if the sender has no encodings yet.
    // Deliberately never `getSettings().frameRate` here -- that is measured
    // too, and would reintroduce the same circularity.
    let parameters: RTCRtpSendParameters | undefined;
    try {
      parameters = sender.getParameters();
    } catch {
      /* stopped sender */
    }
    const targetFrameRate: number | undefined = (() => {
      const maxFramerate = parameters?.encodings?.[0]?.maxFramerate;
      if (maxFramerate) return maxFramerate;

      const frameRateConstraint =
        track?.mediaStreamTrack?.getConstraints?.().frameRate;
      if (typeof frameRateConstraint === "number") return frameRateConstraint;
      return frameRateConstraint?.max ?? frameRateConstraint?.ideal;
    })();

    const recentBandwidth = bandwidth.read(
      [...report.values()].filter(
        (stat) => stat.type !== "outbound-rtp" || stat.id === outbound.id,
      ),
      sender,
      screenShareBandwidthConfiguration(parameters?.encodings),
      !document.hidden,
    );

    // Where the time went while quality was limited -- `cpu` here means the
    // encoder could not keep up; `bandwidth` is the browser's media allocation
    // verdict, not proof that the user's internet connection is too slow.
    const durations = outbound.qualityLimitationDurations ?? {};
    const limitBreakdown = ["cpu", "bandwidth", "other"]
      .filter((k) => (durations[k] ?? 0) > 0.1)
      .map((k) => `${k} ${(durations[k] as number).toFixed(1)}s`)
      .join(", ");

    // Chromium's own hardware-vs-software verdict for this encode, when the
    // browser reports it -- more reliable than guessing from
    // `encoderImplementation`'s free-text name, which varies by platform and
    // codec and was never meant to be parsed.
    const hardware: boolean | undefined =
      typeof outbound.powerEfficientEncoder === "boolean"
        ? outbound.powerEfficientEncoder
        : undefined;

    return {
      rows: [
        {
          label: "Capture",
          value: source?.width ? `${source.width}x${source.height}` : NA,
        },
        {
          label: "Capture rate",
          value: formatFps(sourceFps),
        },
        {
          label: "Largest sending stream",
          value: outbound.frameWidth
            ? `${outbound.frameWidth}x${outbound.frameHeight}`
            : NA,
        },
        { label: "Sent FPS", value: formatFps(fps) },
        { label: "Encoded FPS", value: formatFps(encodedFps) },
        {
          label: "Browser encode estimate",
          value: formatFps(outbound.framesPerSecond),
        },
        {
          label: "Stream SSRC",
          value: outbound.ssrc === undefined ? NA : String(outbound.ssrc),
        },
        { label: "Stream bitrate", value: formatBitrate(bitrate) },
        {
          label: "Bitrate ceiling",
          value: formatBitrate(parameters?.encodings?.[0]?.maxBitrate),
        },
        {
          label: "Encoder target bitrate",
          value: formatBitrate(outbound.targetBitrate),
        },
        {
          label: "Retransmission bitrate",
          value: formatBitrate(
            retransmittedByteRate === undefined
              ? undefined
              : retransmittedByteRate * 8,
          ),
        },
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
        { label: "Mean QP (codec-specific)", value: meanQp?.toFixed(1) ?? NA },
        {
          label: "Packet send delay",
          value:
            meanSendDelayMs === undefined
              ? NA
              : `${meanSendDelayMs.toFixed(1)} ms`,
        },
        {
          label: "Degradation preference",
          value: parameters?.degradationPreference ?? NA,
        },
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
        {
          label: "Limited for (lifetime)",
          value: outbound.qualityLimitationDurations
            ? limitBreakdown || "never"
            : NA,
        },
        {
          label: "Resolution changes (lifetime)",
          value:
            outbound.qualityLimitationResolutionChanges !== undefined
              ? `${outbound.qualityLimitationResolutionChanges}`
              : NA,
        },
        {
          label: "Resolution changes (recent)",
          value: String(
            rates.delta(outbound, "qualityLimitationResolutionChanges") ?? NA,
          ),
        },
        {
          label: "Frames sent",
          value: `${framesSent ?? NA} sent / ${outbound.framesEncoded ?? NA} encoded (lifetime)`,
        },
        {
          label: "Source/encode gap",
          value:
            sourceEncodeGap !== undefined
              ? `${sourceEncodeGap.toFixed(1)} fps`
              : NA,
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
          label: "Transport bandwidth estimate",
          value: formatBitrate(candidatePair?.availableOutgoingBitrate),
        },
        {
          label: "Bandwidth limited (recent)",
          value:
            recentBandwidth.limitedSeconds !== undefined
              ? `${recentBandwidth.limitedSeconds.toFixed(1)}s / ${recentBandwidth.intervalSeconds!.toFixed(1)}s`
              : NA,
        },
        {
          label: "NACK / PLI (recent)",
          value: `${rates.delta(outbound, "nackCount") ?? NA} / ${rates.delta(outbound, "pliCount") ?? NA}`,
        },
      ],
      summary: {
        hardware,
        fps: fps !== undefined ? Math.round(fps) : undefined,
        limitedBy: outbound.qualityLimitationReason,
        framesSent,
      },
    };
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
    isCurrent: () => boolean,
  ): Promise<Row[]> => {
    if (!pub) {
      audioCounters.reset();
      return [{ label: "Audio", value: "not shared" }];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sender: RTCRtpSender | undefined = (pub.track as any)?.sender;

    if (!sender?.getStats) {
      audioCounters.reset();
      return [{ label: "Audio", value: "not publishing" }];
    }

    let report: RTCStatsReport;
    // `getParameters()` shares the try/catch with `getStats()` -- per spec it
    // throws `InvalidStateError` on a stopped/stopping transceiver, and this
    // stopped sender reports unavailable data without retaining old rates.
    let maxBitrate: number | undefined;
    try {
      report = await sender.getStats();
      if (!isCurrent()) return [];
      maxBitrate = sender.getParameters().encodings?.[0]?.maxBitrate;
    } catch {
      if (isCurrent()) audioCounters.reset();
      return [{ label: "Audio", value: "stats unavailable" }];
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let outbound: any = null;
    let remoteInbound: any = null;
    const codecs = new Map<string, any>();
    /* eslint-enable @typescript-eslint/no-explicit-any */

    report.forEach((stat) => {
      if (stat.type === "codec") codecs.set(stat.id, stat);
      if (stat.type === "remote-inbound-rtp" && stat.kind === "audio")
        remoteInbound = stat;
      if (stat.type === "outbound-rtp" && stat.kind === "audio") {
        outbound = stat;
      }
    });

    if (!outbound) {
      // Publication and sender exist, but the RTP stats haven't shown up in
      // a report yet -- normal for the first tick or two after publishing.
      audioCounters.reset();
      return [{ label: "Audio", value: "stats pending" }];
    }

    remoteInbound = outbound.remoteId
      ? report.get(outbound.remoteId)
      : Array.from(report.values()).find(
          (stat) =>
            stat.type === "remote-inbound-rtp" && stat.localId === outbound.id,
        );
    if (audioStreamId !== outbound.id) audioCounters.reset();
    audioStreamId = outbound.id;
    const rates = audioCounters.read(report.values(), sender);
    const byteRate = rates.rate(outbound, "bytesSent");
    const bitrate = byteRate === undefined ? undefined : byteRate * 8;

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
  const sampleInboundVideo = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    track: any,
    isCurrent: () => boolean,
  ): Promise<Row[]> => {
    const receiver: RTCRtpReceiver | undefined = track?.receiver;

    if (!receiver?.getStats) {
      videoCounters.reset();
      return [{ label: "Status", value: "no receiver (not subscribed?)" }];
    }

    let report: RTCStatsReport;
    try {
      report = await receiver.getStats();
      if (!isCurrent()) return [];
    } catch {
      if (isCurrent()) videoCounters.reset();
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
    });
    let rates = videoCounters.read(report.values(), receiver);
    let inboundAdvancing = false;
    report.forEach((stat) => {
      if (stat.type !== "inbound-rtp" || stat.kind !== "video") return;
      if (
        /\/(rtx|red|ulpfec|flexfec)/i.test(
          codecs.get(stat.codecId)?.mimeType ?? "",
        )
      )
        return;
      const advancing = (rates.rate(stat, "framesDecoded") ?? 0) > 0;
      if (
        !inbound ||
        (advancing && !inboundAdvancing) ||
        (advancing === inboundAdvancing &&
          (stat.frameWidth ?? 0) > (inbound.frameWidth ?? 0))
      ) {
        inbound = stat;
        inboundAdvancing = advancing;
      }
    });

    if (!inbound) {
      videoCounters.reset();
      return [{ label: "Status", value: "no video being received" }];
    }

    if (videoStreamId !== inbound.id) {
      videoCounters.reset();
      rates = videoCounters.read(report.values(), receiver);
    }
    videoStreamId = inbound.id;
    candidatePair = selectedCandidatePair(report, inbound);
    const byteRate = rates.rate(inbound, "bytesReceived");
    const bitrate = byteRate === undefined ? undefined : byteRate * 8;
    const receivedFps = rates.rate(inbound, "framesReceived");
    const decodedFps = rates.rate(inbound, "framesDecoded");
    const renderedFps = rates.rate(inbound, "framesRendered");
    const displayed = presentation.sample();

    const codec = codecs.get(inbound.codecId);
    const received = inbound.packetsReceived ?? 0;
    const lost = inbound.packetsLost ?? 0;
    const lossPct =
      received + lost > 0 ? ((lost / (received + lost)) * 100).toFixed(2) : "0";

    const jitterBufferMs =
      inbound.jitterBufferDelay !== undefined &&
      inbound.jitterBufferEmittedCount > 0
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
      { label: "Presented FPS (compositor)", value: formatFps(displayed.fps) },
      {
        label: "Time since presentation",
        value:
          displayed.sinceLastFrameMs === undefined
            ? NA
            : `${Math.round(displayed.sinceLastFrameMs)} ms`,
      },
      { label: "Received FPS", value: formatFps(receivedFps) },
      { label: "Decoded FPS", value: formatFps(decodedFps) },
      { label: "Rendered FPS (RTC)", value: formatFps(renderedFps) },
      {
        label: "Browser decode estimate",
        value: formatFps(inbound.framesPerSecond),
      },
      {
        label: "Stream SSRC",
        value: inbound.ssrc === undefined ? NA : String(inbound.ssrc),
      },
      { label: "Bitrate", value: formatBitrate(bitrate) },
      {
        label: "Codec",
        value: codec?.mimeType ? codec.mimeType.replace("video/", "") : NA,
      },
      { label: "Decoder", value: inbound.decoderImplementation ?? NA },
      { label: "Packets lost", value: `${lost} (${lossPct}%)` },
      {
        label: "Frames dropped (lifetime)",
        value: `${inbound.framesDropped ?? NA}`,
      },
      {
        label: "Freezes (lifetime)",
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
        label: "Jitter buffer (lifetime avg)",
        value: jitterBufferMs !== undefined ? `${jitterBufferMs} ms` : NA,
      },
      {
        label: "Round trip",
        value:
          candidatePair?.currentRoundTripTime !== undefined
            ? `${Math.round(candidatePair.currentRoundTripTime * 1000)} ms`
            : NA,
      },
      {
        label: "Link capacity",
        value: formatBitrate(candidatePair?.availableIncomingBitrate),
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
    isCurrent: () => boolean,
  ): Promise<Row[]> => {
    if (!pub) {
      audioCounters.reset();
      return [{ label: "Audio", value: "not shared" }];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receiver: RTCRtpReceiver | undefined = (pub.track as any)?.receiver;

    if (!receiver?.getStats) {
      audioCounters.reset();
      return [{ label: "Audio", value: "not subscribed" }];
    }

    let report: RTCStatsReport;
    try {
      report = await receiver.getStats();
      if (!isCurrent()) return [];
    } catch {
      if (isCurrent()) audioCounters.reset();
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
      audioCounters.reset();
      return [{ label: "Audio", value: "stats pending" }];
    }

    if (audioStreamId !== inbound.id) audioCounters.reset();
    audioStreamId = inbound.id;
    const rates = audioCounters.read(report.values(), receiver);
    const byteRate = rates.rate(inbound, "bytesReceived");
    const bitrate = byteRate === undefined ? undefined : byteRate * 8;
    const insertedDelta = rates.delta(
      inbound,
      "insertedSamplesForDeceleration",
    );
    const removedDelta = rates.delta(inbound, "removedSamplesForAcceleration");

    const codec = resolveAudioCodec(codecs, inbound.codecId);
    const received = inbound.packetsReceived ?? 0;
    const lost = inbound.packetsLost ?? 0;
    const lossPct =
      received + lost > 0 ? ((lost / (received + lost)) * 100).toFixed(2) : "0";

    const jitterBufferMs =
      inbound.jitterBufferDelay !== undefined &&
      inbound.jitterBufferEmittedCount > 0
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
        label: "Audio jitter buffer (lifetime avg)",
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

  // Identity includes the sender/receiver and native MediaStreamTrack because a
  // publication object can survive a replacement. Visibility invalidates too.
  const identity = () => {
    const ref = trackRef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const video = ref.publication?.track as any;
    const audioPub = ref.participant.getTrackPublication(
      Track.Source.ScreenShareAudio,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const audio = audioPub?.track as any;
    return [
      ref.participant,
      ref.publication,
      video,
      video?.mediaStreamTrack,
      video?.sender,
      video?.receiver,
      audioPub,
      audio,
      audio?.sender,
      audio?.receiver,
    ];
  };
  let previousIdentity: unknown[] = [];
  const sample = async (valid: () => boolean) => {
    const currentIdentity = identity();
    if (currentIdentity.some((item, index) => item !== previousIdentity[index]))
      reset();
    previousIdentity = currentIdentity;
    const isCurrent = () =>
      valid() &&
      identity().every((item, index) => item === currentIdentity[index]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const track = trackRef().publication?.track as any;
    const element = videoElement?.();
    presentation.bind(
      !sending() && element?.isConnected ? element : undefined,
      track?.mediaStreamTrack,
    );
    const audioPub = trackRef().participant.getTrackPublication(
      Track.Source.ScreenShareAudio,
    );
    try {
      if (sending()) {
        const [video, audioRows] = await Promise.all([
          sampleOutboundVideo(track, isCurrent),
          sampleOutboundAudio(audioPub, isCurrent),
        ]);
        if (!isCurrent()) return;
        setRows([...video.rows, ...audioRows]);
        setOwnSummary(video.summary);
      } else {
        const [videoRows, audioRows] = await Promise.all([
          sampleInboundVideo(track, isCurrent),
          sampleInboundAudio(audioPub, isCurrent),
        ]);
        if (!isCurrent()) return;
        setRows([...videoRows, ...audioRows]);
        setOwnSummary(undefined);
      }
    } catch {
      if (isCurrent()) {
        reset();
        setRows([{ label: "Status", value: "stats unavailable" }]);
      }
    }
  };
  const poller = pollScreenShareStats(sample, reset, document);
  createEffect(() => {
    identity();
    videoElement?.();
    poller.invalidate();
  });
  onCleanup(() => poller.stop());

  return { rows, sending, ownSummary };
}

/** A running sampler created by {@link createScreenShareSample}. */
export type ScreenShareSample = ReturnType<typeof createScreenShareSample>;

export function ScreenShareStats(props: {
  trackRef: TrackReference;
  username: string;
  onClose?: () => void;
  videoElement?: Accessor<HTMLVideoElement | undefined>;
  /**
   * An already-running sample to read instead of starting a new
   * `getStats()` poll on the same sender.
   *
   * Used for the sharer's own tile: `ParticipantTile.tsx` starts exactly one
   * `createScreenShareSample` there (so its compact badge keeps reading live
   * numbers whether or not this panel is open) and passes it in here rather
   * than letting this panel poll the same sender a second time. Every other
   * caller (watching someone else's share) leaves this unset, and the panel
   * samples for itself exactly as before.
   */
  sample?: ScreenShareSample;
}) {
  const [copied, setCopied] = createSignal(false);

  // A deliberate one-time read, not the staleness-prone pattern
  // eslint-plugin-solid's reactivity rule usually flags this shape for:
  // `props.sample` is a `ScreenShareSample` (an already-running sampler) or
  // `undefined`, set once by the parent and never swapped out afterwards --
  // there is no later value this could go stale against. Reading it inside
  // a tracked scope instead would just recompute the same decision on every
  // dependency change for no benefit, and `createScreenShareSample` itself
  // must run at most once (it starts an interval and registers its own
  // `onCleanup`), so it cannot live behind a re-run-many-times accessor.
  const owned =
    // eslint-disable-next-line solid/reactivity
    props.sample ??
    createScreenShareSample(
      () => props.trackRef,
      () => props.videoElement?.(),
    );
  const rows = owned.rows;
  const sending = owned.sending;

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
        <Title>stats for nerds{sending() ? " -- your share" : ""}</Title>
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

/**
 * How long an own share is allowed to report zero frames sent before
 * {@link ScreenShareBadge} stops calling that "starting…" and calls it
 * "not sending" instead. Long enough that the ordinary negotiate-then-encode
 * delay never trips it, short enough that a genuinely dead share (the
 * Windows "hw? · 0 fps" bug this badge exists to catch) doesn't sit on a
 * neutral-looking state for long.
 */
const NOT_SENDING_GRACE_MS = 5000;

/**
 * Compact hardware/fps/limitation badge for the sharer's own tile.
 *
 * Reads the same {@link ScreenShareSample} the full panel above renders into
 * rows from -- see `createScreenShareSample`'s doc comment for why this
 * takes a running sample rather than a `trackRef` and sampling itself. Stays
 * empty (renders nothing) until the first successful outbound sample lands,
 * and again whenever the sender briefly has nothing to report (e.g. a
 * source change in flight).
 *
 * Neither `hardware` nor `fps` means anything before the encoder has
 * actually done something: `powerEfficientEncoder` is unset until the first
 * frame is encoded (and stays unset forever on Chromium builds that never
 * expose it at all), and a bare `fps` reading can't be told apart from "not
 * measured yet" the way `framesSent` can. Showing either early used to print
 * the literal, undiagnostic "hw? · 0 fps" -- so instead this renders one
 * neutral "starting…" state until at least one of them becomes meaningful.
 * If `framesSent` is still `0` after {@link NOT_SENDING_GRACE_MS}, that
 * flips to an explicit, visually distinct "not sending" state rather than
 * staying "starting…" forever -- a share that never sends a frame is exactly
 * the failure this badge exists to surface, so it must not go quiet about it.
 */
export function ScreenShareBadge(props: { sample: ScreenShareSample }) {
  const { t } = useLingui();

  // Whether the grace period above has elapsed for the *current* share
  // attempt without a frame being sent yet.
  const [graceElapsed, setGraceElapsed] = createSignal(false);

  // Non-reactive bookkeeping for the timer, same style as the plain `let`
  // counters `createScreenShareSample` above keeps between samples -- there
  // is nothing here another consumer needs to read reactively.
  let armed = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  // Arms (and re-arms) the grace timer once per share attempt.
  // `ownSummary()` is `undefined` between shares and whenever a sample fails
  // (see `createScreenShareSample`), so a transition from absent to present
  // is "a new share attempt started" -- exactly the point a previously
  // failed share must stop being able to leave this stuck on "not sending".
  // Deliberately a plain effect with no return value: returning the cleanup
  // closure directly from `createEffect` would make Solid treat it as this
  // effect's previous *value*, not a disposer -- the timer is torn down via
  // `onCleanup` below instead.
  createEffect(() => {
    if (!props.sample.ownSummary()) {
      armed = false;
      setGraceElapsed(false);
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      return;
    }

    if (armed) return;
    armed = true;
    graceTimer = setTimeout(() => setGraceElapsed(true), NOT_SENDING_GRACE_MS);
  });

  onCleanup(() => {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  });

  return (
    <Show when={props.sample.ownSummary()}>
      {(summary) => {
        const hardwareKnown = () => typeof summary().hardware === "boolean";
        const fpsKnown = () => (summary().framesSent ?? 0) > 0;
        // Only an error once nothing has ever been sent *and* the grace
        // period has run out -- the moment a frame lands, `fpsKnown()` wins
        // this race for good, regardless of what the timer is doing.
        const notSending = () => !fpsKnown() && graceElapsed();

        // Whether `summary().fps` is an actual number to print, as opposed
        // to `fpsKnown()` above (whether frames have been *sent* at all).
        // These sound like the same question but aren't: `framesSent` is a
        // cumulative counter that can already be positive on the very first
        // sample, while `fps` stays `undefined` until either Chromium has
        // populated `outbound.framesPerSecond` or a second sample lets
        // `sampleOutboundVideo` derive a rate from the delta -- neither of
        // which has necessarily happened yet on that first sample. Printing
        // the fps segment off `fpsKnown()` alone is exactly how this badge
        // used to render the literal "undefined fps". `fpsKnown()` itself
        // must stay framesSent-based, though: it's also what defeats
        // `notSending` above, and gating that on a computed rate instead
        // would flip a share into the error state on any single sample that
        // failed to compute one, not just a genuinely dead share.
        const fpsValueKnown = () => typeof summary().fps === "number";

        return (
          <Show
            when={!notSending()}
            fallback={
              <Badge error>
                <Symbol size={14}>error</Symbol>
                <span>{t`not sending`}</span>
              </Badge>
            }
          >
            <Badge>
              <Show
                // Gate on `fpsValueKnown()`, not `fpsKnown()`: this decides
                // whether the segments below have anything printable to show,
                // and `fpsKnown()` (`framesSent > 0`) can be true before
                // `summary().fps` has a value (see `fpsValueKnown` above).
                // Gating on `fpsKnown()` here let that state through with
                // hardware still unknown too, rendering a bare icon with no
                // text at all -- unlike `notSending`, which must stay on
                // `fpsKnown()` so a single failed-rate sample can't flip a
                // genuinely sending share into the error badge.
                when={hardwareKnown() || fpsValueKnown()}
                fallback={
                  <>
                    <Symbol size={14}>hourglass_top</Symbol>
                    <span>{t`starting…`}</span>
                  </>
                }
              >
                <Symbol size={14}>
                  {/*
                   * `bolt` asserts hardware encoding, so it must not be the
                   * fallback for "unknown" -- `hardware` is `undefined`
                   * whenever Chromium hasn't reported `powerEfficientEncoder`
                   * yet, which on some builds is permanent, not just a
                   * startup transient (see the doc comment above). `videocam`
                   * reads as plain "encoding" with no hw/sw claim either way.
                   */}
                  {summary().hardware === true
                    ? "bolt"
                    : summary().hardware === false
                      ? "memory"
                      : "videocam"}
                </Symbol>
                <Show when={hardwareKnown()}>
                  <span>{summary().hardware ? "hw" : "sw"}</span>
                </Show>
                {/*
                 * Each dot separates two segments that are *both* actually
                 * rendering -- guard it on the segment before it having
                 * rendered, not just the one after, so a segment that got
                 * skipped (e.g. `fps` when only `framesSent`, not the rate
                 * itself, is known yet) never leaves a leading dot in front
                 * of whatever renders next.
                 */}
                <Show when={hardwareKnown() && fpsValueKnown()}>
                  <BadgeDot />
                </Show>
                <Show when={fpsValueKnown()}>
                  <span>{`${summary().fps} fps`}</span>
                </Show>
                <Show
                  when={
                    (hardwareKnown() || fpsValueKnown()) &&
                    summary().limitedBy &&
                    summary().limitedBy !== "none"
                  }
                >
                  <BadgeDot />
                  <span>{summary().limitedBy}</span>
                </Show>
              </Show>
            </Badge>
          </Show>
        );
      }}
    </Show>
  );
}

/*
 * `Panel` used to be laid out purely as a grid item -- `gridArea: "1/1"` +
 * `alignSelf/justifySelf: "start"` -- sharing the tile's single implicit
 * grid cell with every other overlay (`Controls`, `NotWatching`, the `tile`
 * focus variant, ...). That works fine for placement, but it makes
 * `maxHeight: "calc(100% - ...)"` (needed so the panel can never exceed the
 * tile, see below) resolve against *that grid cell's* size, not the tile's --
 * and per the grid item content-sizing rules, a cell holding only
 * `align-self: start` items (items that do not stretch to the cell's full
 * size) is track-sized to the *content* those items want, not to the
 * container. That is circular for a `max-height` meant to cap that same
 * content: the percentage basis becomes indefinite before the cap can ever
 * apply, and a `%`/`calc()` max-height against an indefinite basis resolves
 * to `none` per spec -- i.e. exactly the "silently does nothing" failure
 * mode this file's plan warned about. Some engines paper over this for the
 * *stretched* items in the same cell (hence `Controls` etc. working), but
 * nothing here should depend on that for an item that explicitly opts out
 * of stretching.
 *
 * `position: absolute` sidesteps the whole question: an absolutely
 * positioned box's percentage height resolves against its containing
 * block's own (used) height, which is well-defined regardless of how that
 * ancestor's children are laid out -- and `tile`'s cva base now sets
 * `position: relative` (`ParticipantTile.tsx`) specifically so this panel's
 * containing block is the tile itself, in both the normal case (tile height
 * is definite via `aspect-ratio` + width) and the focused case (`tile`'s own
 * `focus: true` variant sets `position: absolute` with an inline `height`
 * from `getHeight()` -- still a definite height on the *same* element this
 * panel is now positioned against). `top`/`left` replace the old
 * `margin: var(--gap-md)` + grid alignment for placement; `maxWidth` is
 * unchanged, since the horizontal case was never the problem.
 */
const Panel = styled("div", {
  base: {
    position: "absolute",
    top: "var(--gap-md)",
    left: "var(--gap-md)",
    zIndex: 10,

    // Belt-and-braces for the `calc(100% - ...)` maxHeight below: without
    // `border-box`, `padding` would be added on top of the capped height
    // instead of being carved out of it, letting the panel grow past the
    // cap by exactly its own padding.
    boxSizing: "border-box",
    padding: "var(--gap-md)",

    // Flex column so `Header` (fixed-size) and `Grid` (the rows, scrolling)
    // stack and only the latter grows/scrolls -- see `Grid` below for why
    // the scrollbar lives there rather than here, on `Panel`.
    display: "flex",
    flexDirection: "column",

    maxWidth: "min(320px, 90%)",
    // The actual "too tall for its tile" fix: caps the panel at the tile's
    // height minus a `--gap-md` margin on both the top (the panel's own
    // `top` offset above) and bottom, so it can never grow past the tile
    // regardless of how many rows the sampler emits (~25 outbound / ~21
    // inbound -- see this file's top doc comment). `Grid` below is what
    // actually overflows and scrolls; this only ever caps the ceiling.
    maxHeight: "calc(100% - 2 * var(--gap-md))",
    // Every sibling overlay sharing this same grid cell (`Controls`,
    // `NotWatching`, the `tile` focus variant) declares this explicitly
    // rather than relying on the tile happening to be hit-testable --
    // closing that same latent gap here rather than leaving this panel as
    // the one overlay that only works by accident.
    pointerEvents: "auto",

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

/**
 * No `position: sticky` here, deliberately. The obvious way to keep
 * `copy`/`close` reachable while the rows scroll is a sticky header with an
 * opaque background masking whatever passes underneath it -- and that was
 * tried first, but it does not actually work against this panel's
 * translucent design: `Panel`'s own background is `#000000cc` (80% alpha),
 * so matching it on the sticky header still lets 20% of scrolled-under row
 * text show through as visible ghosting, and the header ends up compositing
 * to a visibly different (darker) shade than the rest of the panel. Patching
 * the alpha upward just trades one visible artifact for another (a
 * header/body seam), and an opaque header would abandon the panel's
 * translucent look outright.
 *
 * The actual fix is to remove the need for a mask at all: `Panel` is a flex
 * column, `Header` here is a fixed-size flex item (`flexShrink: 0`), and
 * only `Grid` below -- the rows -- scrolls. Content that never shares
 * `Header`'s box in the first place can't show through it, at any scroll
 * offset, with no background/alpha/margin tricks required.
 */
const Header = styled("div", {
  base: {
    flexShrink: 0,

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

/**
 * The "stats for nerds" title. `min-width: 0` overrides a flex item's
 * default `min-width: auto`, which would otherwise floor this span's width
 * at its own content size and let that content keep shoving `Buttons`
 * sideways no matter how little room `Header` has -- only with the floor
 * removed can `overflow: hidden` + `text-overflow: ellipsis` actually clip
 * the text instead of losing the fight for space against `copy`/`close`.
 * This was the most plausible "can't close it" path: `justify-content:
 * space-between` with no shrink control on either side let the uppercase
 * title push `close` right off the panel's edge on a narrow tile.
 */
const Title = styled("span", {
  base: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

/** `flexShrink: 0` is `Title`'s other half: `copy`/`close` must never be the
 * side that gives, or a long title could still squeeze them illegibly small
 * instead of eliding itself. */
const Buttons = styled("div", {
  base: { display: "flex", gap: "var(--gap-sm)", flexShrink: 0 },
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

    // This is where `Panel`'s old `overflowY`/`overscrollBehavior` moved to
    // (see `Header`'s doc comment for why): the rows are the only thing
    // that should ever scroll under `Header`, so the scrollbar belongs on
    // this element, not on `Panel` itself.
    overflowY: "auto",
    // Stops an over-scroll at the top/bottom of this scroll area from
    // "chaining" into scrolling the page/tile behind it -- this panel
    // floats over content the user very likely does not want to nudge while
    // reading stats.
    overscrollBehavior: "contain",
    // A flex item's (`Panel`'s child) default `min-height: auto` sizes it
    // to fit its content, which for a scroll container means "big enough
    // that nothing needs to scroll" -- exactly defeating the point of
    // `overflowY: auto` above. Zeroing it lets `Grid` actually shrink below
    // its content height and hand the excess to the scrollbar. Grid layout
    // itself (the `auto 1fr` columns) is unaffected: a flex/grid item's
    // min-size axis and its own internal `display: grid` formatting are
    // independent, so this only changes how much vertical space `Grid` is
    // willing to be squeezed into, not how its two columns lay out.
    minHeight: 0,
  },
});

const Label = styled("div", { base: { opacity: 0.6, whiteSpace: "nowrap" } });

const Value = styled("div", {
  base: {
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    // Codec rows (`sdpFmtpLine`, see e.g. the outbound/inbound sample
    // builders above) can be long enough to run past `Panel`'s 320px cap
    // with nowhere to break -- `anywhere` allows a break at any character
    // once there is no better (word/hyphen) opportunity, wrapping the value
    // inside the panel instead of overflowing its edge.
    overflowWrap: "anywhere",
  },
});

const Badge = styled("div", {
  base: {
    gridArea: "1/1",
    alignSelf: "end",
    justifySelf: "start",
    margin: "var(--gap-md)",
    zIndex: 8,

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
    padding: "var(--gap-xs) var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    background: "#000000aa",
    color: "#fff",
    fontSize: "0.7rem",
    fontVariantNumeric: "tabular-nums",

    pointerEvents: "none",
  },
  variants: {
    // The "not sending" state (see `ScreenShareBadge`) is a genuine error,
    // not a neutral status like the rest of the badge -- deliberately given
    // the app's regular error color rather than another shade of the badge's
    // own near-black backdrop, so it reads as broken at a glance.
    error: {
      true: {
        background: "var(--md-sys-color-error)",
        color: "var(--md-sys-color-on-error)",
      },
    },
  },
});

const BadgeDot = styled("div", {
  base: {
    width: "3px",
    height: "3px",
    borderRadius: "50%",
    background: "#fff8",
  },
});
