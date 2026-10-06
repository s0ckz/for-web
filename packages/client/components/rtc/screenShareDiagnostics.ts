import { observeResolutionChange } from "./screenShareResolution.ts";

/** Local diagnostics only: no addresses, participant IDs, or media content. */
export interface SenderDiagnosticStat {
  id: string;
  type: string;
  timestamp: number;
  kind?: string;
  mediaType?: string;
  mediaSourceId?: string;
  codecId?: string;
  frames?: number;
  framesEncoded?: number;
  framesSent?: number;
  bytesSent?: number;
  totalEncodeTime?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  qualityLimitationReason?: string;
  qualityLimitationDurations?: Record<string, number>;
  mimeType?: string;
  selectedCandidatePairId?: string;
  availableOutgoingBitrate?: number;
  currentRoundTripTime?: number;
  nominated?: boolean;
  state?: string;
  transportId?: string;
  active?: boolean;
  ssrc?: number;
  packetsSent?: number;
  retransmittedBytesSent?: number;
  totalPacketSendDelay?: number;
  targetBitrate?: number;
  qpSum?: number;
  qualityLimitationResolutionChanges?: number;
  nackCount?: number;
  pliCount?: number;
  firCount?: number;
  remoteId?: string;
  packetsLost?: number;
  fractionLost?: number;
  roundTripTime?: number;
}

function delta(current?: number, previous?: number): number | null {
  return Number.isFinite(current) &&
    Number.isFinite(previous) &&
    current! >= previous!
    ? current! - previous!
    : null;
}

function rate(value: number | null, seconds: number | null): number | null {
  return value !== null && seconds !== null && seconds > 0
    ? Math.round((value / seconds) * 10) / 10
    : null;
}

function baseline(
  stat: SenderDiagnosticStat,
  previous: Map<string, SenderDiagnosticStat>,
) {
  const before = previous.get(stat.id);
  if (
    !before ||
    stat.type !== before.type ||
    (stat.kind ?? stat.mediaType) !== (before.kind ?? before.mediaType) ||
    stat.timestamp <= before.timestamp ||
    stat.ssrc !== before.ssrc ||
    stat.codecId !== before.codecId ||
    stat.mediaSourceId !== before.mediaSourceId ||
    stat.transportId !== before.transportId ||
    ["framesEncoded", "framesSent", "bytesSent", "packetsSent"].some((key) => {
      const current = stat[key as keyof SenderDiagnosticStat];
      const old = before[key as keyof SenderDiagnosticStat];
      return (
        typeof current === "number" && typeof old === "number" && current < old
      );
    })
  )
    return undefined;
  return before;
}

function bitsPerSecond(
  current: number | undefined,
  previous: number | undefined,
  seconds: number | null,
) {
  const bytes = delta(current, previous);
  return bytes !== null && seconds !== null && seconds > 0
    ? Math.round((bytes * 8) / seconds)
    : null;
}

/** Keep a baseline per RTP stream; never subtract across a sender/reset. */
export function summarizeSenderDiagnostics(
  stats: SenderDiagnosticStat[],
  previous: Map<string, SenderDiagnosticStat>,
) {
  const byId = new Map(stats.map((stat) => [stat.id, stat]));
  const video = stats
    .filter(
      (stat) =>
        stat.type === "outbound-rtp" &&
        (stat.kind ?? stat.mediaType) === "video" &&
        stat.active !== false,
    )
    .sort(
      (a, b) =>
        Number(
          (delta(b.framesSent, baseline(b, previous)?.framesSent) ?? 0) > 0,
        ) -
          Number(
            (delta(a.framesSent, baseline(a, previous)?.framesSent) ?? 0) > 0,
          ) || (b.frameWidth ?? 0) - (a.frameWidth ?? 0),
    )[0];
  const transports = stats.filter((stat) => stat.type === "transport");
  const transport = video?.transportId
    ? byId.get(video.transportId)
    : transports.length === 1
      ? transports[0]
      : undefined;
  const selectedPairId = transport?.selectedCandidatePairId;
  const nominated = stats.filter(
    (stat) =>
      stat.type === "candidate-pair" &&
      stat.nominated &&
      stat.state === "succeeded",
  );
  const pair = selectedPairId
    ? byId.get(selectedPairId)
    : nominated.length === 1
      ? nominated[0]
      : undefined;
  const streams = stats
    .filter(
      (stat) =>
        stat.type === "outbound-rtp" &&
        (stat.kind ?? stat.mediaType) === "video",
    )
    .map((stat) => {
      const before = baseline(stat, previous);
      const elapsed = delta(stat.timestamp, before?.timestamp);
      const seconds = elapsed !== null && elapsed > 0 ? elapsed / 1000 : null;
      const framesEncoded = delta(stat.framesEncoded, before?.framesEncoded);
      const encodeTime = delta(stat.totalEncodeTime, before?.totalEncodeTime);
      const qp = delta(stat.qpSum, before?.qpSum);
      const packets = delta(stat.packetsSent, before?.packetsSent);
      const sendDelay = delta(
        stat.totalPacketSendDelay,
        before?.totalPacketSendDelay,
      );
      const referencedRemote = stat.remoteId
        ? byId.get(stat.remoteId)
        : undefined;
      const remote =
        referencedRemote?.type === "remote-inbound-rtp"
          ? referencedRemote
          : undefined;
      const oldRemote =
        before?.remoteId === remote?.id && remote
          ? previous.get(remote.id)
          : undefined;
      const remoteElapsed =
        remote &&
        oldRemote &&
        oldRemote.type === remote.type &&
        remote.ssrc === oldRemote.ssrc &&
        remote.codecId === oldRemote.codecId
          ? delta(remote.timestamp, oldRemote.timestamp)
          : null;
      const remoteSeconds =
        remoteElapsed !== null && remoteElapsed > 0
          ? remoteElapsed / 1000
          : null;
      // Receiver reports may correct loss downwards after late packets arrive.
      const lost =
        remoteSeconds !== null &&
        remoteSeconds > 0 &&
        Number.isFinite(remote?.packetsLost) &&
        Number.isFinite(oldRemote?.packetsLost)
          ? remote!.packetsLost! - oldRemote!.packetsLost!
          : null;
      const source = stat.mediaSourceId
        ? byId.get(stat.mediaSourceId)
        : undefined;
      const previousSource = source ? previous.get(source.id) : undefined;
      const sourceElapsed = source
        ? delta(source.timestamp, previousSource?.timestamp)
        : null;
      const limitedFor: Record<string, number | null> = {};
      const resolutionObservation = observeResolutionChange(stat, before);
      for (const key of ["cpu", "bandwidth", "none", "other"]) {
        limitedFor[key] = delta(
          stat.qualityLimitationDurations?.[key],
          before?.qualityLimitationDurations?.[key],
        );
      }
      return {
        intervalSeconds: seconds,
        encodedFps: rate(framesEncoded, seconds),
        sentFps: rate(delta(stat.framesSent, before?.framesSent), seconds),
        sourceFps: rate(
          delta(source?.frames, previousSource?.frames),
          sourceElapsed !== null ? sourceElapsed / 1000 : null,
        ),
        reportedFps: stat.framesPerSecond ?? null,
        bitrateBps: bitsPerSecond(stat.bytesSent, before?.bytesSent, seconds),
        targetBitrateBps: stat.targetBitrate ?? null,
        retransmissionBitrateBps: bitsPerSecond(
          stat.retransmittedBytesSent,
          before?.retransmittedBytesSent,
          seconds,
        ),
        meanPacketSendDelayMs:
          sendDelay !== null && packets !== null && packets > 0
            ? Math.round(((sendDelay * 1000) / packets) * 100) / 100
            : null,
        meanQp:
          qp !== null && framesEncoded !== null && framesEncoded > 0
            ? Math.round((qp / framesEncoded) * 100) / 100
            : null,
        resolutionChanges: delta(
          stat.qualityLimitationResolutionChanges,
          before?.qualityLimitationResolutionChanges,
        ),
        observedResolutionChanges: resolutionObservation?.changes ?? null,
        resolutionTransition: resolutionObservation?.changes
          ? resolutionObservation
          : null,
        feedback: {
          nack: delta(stat.nackCount, before?.nackCount),
          pli: delta(stat.pliCount, before?.pliCount),
          fir: delta(stat.firCount, before?.firCount),
        },
        receiverReport:
          remote?.type === "remote-inbound-rtp"
            ? {
                intervalSeconds: remoteSeconds,
                packetsLostDelta: lost,
                reportedFractionLost: remote.fractionLost ?? null,
                roundTripTimeMs:
                  remote.roundTripTime !== undefined
                    ? remote.roundTripTime * 1000
                    : null,
              }
            : null,
        meanEncodeMs:
          encodeTime !== null && framesEncoded !== null && framesEncoded > 0
            ? Math.round(((encodeTime * 1000) / framesEncoded) * 100) / 100
            : null,
        resolution: [stat.frameWidth ?? null, stat.frameHeight ?? null],
        codec: stat.codecId ? (byId.get(stat.codecId)?.mimeType ?? null) : null,
        encoder: stat.encoderImplementation?.slice(0, 120) ?? null,
        powerEfficientEncoder: stat.powerEfficientEncoder ?? null,
        limitedBy: stat.qualityLimitationReason ?? null,
        limitedSeconds: limitedFor,
      };
    });
  return {
    streams,
    availableOutgoingBitrate: pair?.availableOutgoingBitrate ?? null,
    roundTripTimeMs:
      pair?.currentRoundTripTime !== undefined
        ? pair.currentRoundTripTime * 1000
        : null,
  };
}

/** Poll without overlap, independent of the stats UI, and cancel in-flight work. */
export function startSenderDiagnostics(
  getSender: () => RTCRtpSender | undefined,
  log: (summary: Record<string, unknown>) => void,
  intervalMs = 10_000,
  onSample?: (report: RTCStatsReport, sender: RTCRtpSender) => void,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = new Map<string, SenderDiagnosticStat>();
  let previousSender: RTCRtpSender | undefined;
  const sample = async () => {
    try {
      const sender = getSender();
      if (!sender) {
        previous.clear();
        previousSender = undefined;
        log({ status: "sender-unavailable" });
      } else {
        if (sender !== previousSender) previous.clear();
        previousSender = sender;
        const report = await sender.getStats();
        if (stopped) return;
        if (getSender() !== sender) {
          previous.clear();
          return;
        }
        const stats: SenderDiagnosticStat[] = [];
        report.forEach((stat) => stats.push(stat));
        const settings = sender.track?.getSettings();
        const parameters = sender.getParameters();
        onSample?.(report, sender);
        log({
          ...summarizeSenderDiagnostics(stats, previous),
          capture: {
            width: settings?.width ?? null,
            height: settings?.height ?? null,
            requestedFps: settings?.frameRate ?? null,
            contentHint: sender.track?.contentHint ?? null,
          },
          degradationPreference: parameters.degradationPreference ?? null,
          limits: parameters.encodings?.map((encoding) => ({
            maxBitrate: encoding.maxBitrate ?? null,
            maxFramerate: encoding.maxFramerate ?? null,
            scaleResolutionDownBy: encoding.scaleResolutionDownBy ?? null,
            active: encoding.active ?? null,
          })),
        });
        previous = new Map(
          stats.map((stat) => [
            stat.id,
            {
              ...stat,
              qualityLimitationDurations: stat.qualityLimitationDurations && {
                ...stat.qualityLimitationDurations,
              },
            },
          ]),
        );
      }
    } catch {
      previous.clear();
      if (!stopped) log({ status: "stats-unavailable" });
    } finally {
      if (!stopped) timer = setTimeout(() => void sample(), intervalMs);
    }
  };
  void sample();
  return () => {
    stopped = true;
    clearTimeout(timer);
    previous.clear();
  };
}
