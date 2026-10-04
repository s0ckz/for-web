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
        Number((delta(b.framesSent, previous.get(b.id)?.framesSent) ?? 0) > 0) -
          Number(
            (delta(a.framesSent, previous.get(a.id)?.framesSent) ?? 0) > 0,
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
      const before = previous.get(stat.id);
      const elapsed = delta(stat.timestamp, before?.timestamp);
      const seconds = elapsed !== null && elapsed > 0 ? elapsed / 1000 : null;
      const framesEncoded = delta(stat.framesEncoded, before?.framesEncoded);
      const encodeTime = delta(stat.totalEncodeTime, before?.totalEncodeTime);
      const source = stat.mediaSourceId
        ? byId.get(stat.mediaSourceId)
        : undefined;
      const previousSource = source ? previous.get(source.id) : undefined;
      const sourceElapsed = source
        ? delta(source.timestamp, previousSource?.timestamp)
        : null;
      const limitedFor: Record<string, number | null> = {};
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
        bitrateBps:
          rate(delta(stat.bytesSent, before?.bytesSent), seconds) === null
            ? null
            : Math.round(
                ((stat.bytesSent! - before!.bytesSent!) * 8) / seconds!,
              ),
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
          },
          limits: parameters.encodings?.map((encoding) => ({
            maxBitrate: encoding.maxBitrate ?? null,
            maxFramerate: encoding.maxFramerate ?? null,
            scaleResolutionDownBy: encoding.scaleResolutionDownBy ?? null,
            active: encoding.active ?? null,
          })),
        });
        previous = new Map(stats.map((stat) => [stat.id, stat]));
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
