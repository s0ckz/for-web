import {
  type SenderDiagnosticStat,
  summarizeSenderDiagnostics,
} from "./screenShareDiagnostics.ts";

/** Private per-track numeric snapshot; no pixels, addresses or participant IDs. */
export interface CaptureFlowSnapshot {
  sessionId: number;
  configurationVersion: number;
  path: string;
  sampledAtMs: number;
  renderer: Record<string, number>;
  native: {
    sampledAtMs: number;
    native: Record<string, number | null>;
    delivery: Record<string, number | boolean>;
  } | null;
  timings: Record<string, { count: number; totalMs: number; maxMs: number }>;
}

/** Older desktop builds and Chromium tracks have no native diagnostic hook. */
type DiagnosticTrack = MediaStreamTrack & {
  getCaptureDiagnostics?: () => Promise<CaptureFlowSnapshot | null>;
};

const NATIVE_COUNTERS = [
  "incomingFrames",
  "emittedFrames",
  "jsDeliveredFrames",
];
const DELIVERY_COUNTERS = ["posted", "acknowledged", "coalesced", "failures"];
const RENDERER_COUNTERS = [
  "received",
  "constructed",
  "accepted",
  "written",
  "backpressure",
  "writeFailures",
  "canvasDrawn",
  "drawFailures",
];
const TIMINGS = ["arrivalGap", "captureTimestampGap", "construction", "write"];
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const rounded = (value: number) => Math.round(value * 100) / 100;

/** Missing/reset counters stay unknown; each stage uses its own sample clock. */
function counterWindow(
  current: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  at: number | undefined,
  beforeAt: number | undefined,
  keys: string[],
) {
  const seconds =
    finite(at) && finite(beforeAt) && at > beforeAt
      ? (at - beforeAt) / 1000
      : null;
  const deltas = Object.fromEntries(
    keys.map((key) => {
      const value = current?.[key],
        before = previous?.[key];
      return [
        key,
        seconds !== null && finite(value) && finite(before) && value >= before
          ? value - before
          : null,
      ];
    }),
  );
  return {
    atMs: at ?? null,
    intervalSeconds: seconds,
    deltas,
    rates: Object.fromEntries(
      Object.entries(deltas).map(([key, value]) => [
        key,
        value !== null && seconds !== null ? rounded(value / seconds) : null,
      ]),
    ),
  };
}

/** Correlate bounded aggregate windows without pretending their clocks are identical. */
export function summarizeCaptureFlow(
  current: CaptureFlowSnapshot | null,
  previous: CaptureFlowSnapshot | null,
) {
  if (!current) return null;
  if (
    current.sessionId !== previous?.sessionId ||
    current.configurationVersion !== previous?.configurationVersion
  )
    previous = null;
  return {
    sessionId: current.sessionId,
    configurationVersion: current.configurationVersion,
    path: current.path,
    renderer: counterWindow(
      current.renderer,
      previous?.renderer,
      current.sampledAtMs,
      previous?.sampledAtMs,
      RENDERER_COUNTERS,
    ),
    native: current.native
      ? counterWindow(
          current.native.native,
          previous?.native?.native,
          current.native.sampledAtMs,
          previous?.native?.sampledAtMs,
          NATIVE_COUNTERS,
        )
      : null,
    delivery: current.native
      ? counterWindow(
          current.native.delivery,
          previous?.native?.delivery,
          current.native.sampledAtMs,
          previous?.native?.sampledAtMs,
          DELIVERY_COUNTERS,
        )
      : null,
    timings: Object.fromEntries(
      TIMINGS.map((name) => {
        const now = current.timings[name],
          before = previous?.timings[name];
        const count =
          now && before && now.count >= before.count
            ? now.count - before.count
            : null;
        const total =
          now && before && now.totalMs >= before.totalMs
            ? now.totalMs - before.totalMs
            : null;
        return [
          name,
          {
            count,
            meanMs: count && total !== null ? rounded(total / count) : null,
            maxSinceFirstTraceMs: finite(now?.maxMs)
              ? rounded(now.maxMs)
              : null,
          },
        ];
      }),
    ),
  };
}

/** A 90-second local trace; one read in flight, with a hard deadline even if reads hang. */
export function startScreenShareFlowTrace(options: {
  getSender: () => RTCRtpSender | undefined;
  experiment: { traceSeconds?: number; codec: string; maxBitrate?: number };
  log: (record: Record<string, unknown>) => void;
  clock?: {
    now: () => number;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
}) {
  if (options.experiment.traceSeconds !== 90) return () => {};
  const clock = options.clock ?? {
    now: () => performance.now(),
    setTimeout,
    clearTimeout,
  };
  const startedAt = clock.now();
  let stopped = false,
    samples = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = new Map<string, SenderDiagnosticStat>();
  let previousCapture: CaptureFlowSnapshot | null = null;
  let previousKey: string | undefined;
  let owner: RTCRtpSender | undefined;
  let ownerTrack: DiagnosticTrack | null | undefined;
  const emit = (record: Record<string, unknown>) => {
    try {
      options.log({
        schema: 1,
        elapsedMs: rounded(clock.now() - startedAt),
        ...record,
      });
    } catch {
      /* diagnostic failures cannot affect media */
    }
  };
  const finish = (reason: string) => {
    if (stopped) return;
    stopped = true;
    clock.clearTimeout(timer);
    clock.clearTimeout(deadline);
    previous.clear();
    previousCapture = null;
    emit({ event: "end", reason, samples });
  };
  const deadline = clock.setTimeout(() => finish("completed"), 90_000);
  emit({
    event: "start",
    durationSeconds: 90,
    intervalMs: 1000,
    experiment: {
      codec: options.experiment.codec,
      maxBitrate: options.experiment.maxBitrate ?? null,
    },
  });
  const sample = async () => {
    if (stopped) return;
    const readStarted = clock.now();
    try {
      const sender = options.getSender();
      const track = sender?.track as DiagnosticTrack | null | undefined;
      if (!sender || !track || track.readyState === "ended") {
        finish("sender-ended");
        return;
      }
      if (owner && (sender !== owner || track !== ownerTrack)) {
        finish("sender-replaced");
        return;
      }
      owner = sender;
      ownerTrack = track;
      const [report, capture] = await Promise.all([
        Promise.resolve().then(() => sender.getStats()),
        Promise.resolve()
          .then(() => track.getCaptureDiagnostics?.() ?? null)
          .catch(() => null),
      ]);
      if (stopped) return;
      if (options.getSender() !== sender || sender.track !== track) {
        finish("sender-replaced");
        return;
      }
      const settings = track?.getSettings();
      const limits = sender.getParameters().encodings?.map((value) => ({
        maxBitrate: value.maxBitrate ?? null,
        maxFramerate: value.maxFramerate ?? null,
        scaleResolutionDownBy: value.scaleResolutionDownBy ?? null,
        active: value.active ?? null,
      }));
      const key = JSON.stringify([
        capture?.sessionId,
        capture?.configurationVersion,
        settings?.width,
        settings?.height,
        settings?.frameRate,
        limits,
      ]);
      if (key !== previousKey) {
        previous.clear();
        previousCapture = null;
      }
      previousKey = key;
      const stats = Array.from(report.values()) as SenderDiagnosticStat[];
      emit({
        event: "sample",
        sample: ++samples,
        readSpanMs: rounded(clock.now() - readStarted),
        capture: summarizeCaptureFlow(capture, previousCapture),
        sender: summarizeSenderDiagnostics(stats, previous),
        rtcSampleAtMs: stats
          .filter(
            (stat) =>
              stat.type === "outbound-rtp" &&
              (stat.kind ?? stat.mediaType) === "video",
          )
          .map((stat) => stat.timestamp),
        requested: {
          width: settings?.width ?? null,
          height: settings?.height ?? null,
          fps: settings?.frameRate ?? null,
        },
        limits,
      });
      previousCapture = capture;
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
    } catch {
      if (!stopped) {
        previous.clear();
        previousCapture = null;
        emit({ event: "unavailable" });
      }
    } finally {
      if (!stopped) timer = clock.setTimeout(() => void sample(), 1000);
    }
  };
  void sample();
  return () => finish("stopped");
}
