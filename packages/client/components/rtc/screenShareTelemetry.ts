/** Rates from matching RTCStats timestamps, never from a requested FPS. */
type CounterStat = { id: string; timestamp: number; [field: string]: unknown };

export class StatsCounters {
  private owner: unknown;
  private previous = new Map<string, CounterStat>();

  reset() {
    this.owner = undefined;
    this.previous.clear();
  }

  read(stats: Iterable<CounterStat>, owner: unknown) {
    if (owner !== this.owner) this.reset();
    this.owner = owner;
    const previous = this.previous;
    this.previous = new Map(
      Array.from(stats, (stat) => [stat.id, { ...stat }]),
    );
    const seconds = (stat: CounterStat) => {
      const before = previous.get(stat.id);
      if (
        !before ||
        [
          "type",
          "kind",
          "ssrc",
          "codecId",
          "trackIdentifier",
          "mediaSourceId",
          "transportId",
        ].some((key) => before[key] !== stat[key])
      )
        return undefined;
      const elapsed = before && (stat.timestamp - before.timestamp) / 1000;
      return elapsed && elapsed > 0 && Number.isFinite(elapsed)
        ? elapsed
        : undefined;
    };
    const delta = (stat: CounterStat, field: string) => {
      const before = previous.get(stat.id)?.[field];
      const value = stat[field];
      if (
        seconds(stat) === undefined ||
        typeof before !== "number" ||
        !Number.isFinite(before) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < before
      )
        return undefined;
      return value - before;
    };
    return {
      delta,
      rate: (stat: CounterStat, field: string) => {
        const change = delta(stat, field);
        const elapsed = seconds(stat);
        return change !== undefined && elapsed !== undefined
          ? change / elapsed
          : undefined;
      },
    };
  }
}

/** Follow the RTP stream's transport instead of the last nominated pair. */
export function selectedCandidatePair(
  report: RTCStatsReport,
  stream: { transportId?: string },
) {
  const transport = stream.transportId && report.get(stream.transportId);
  if (transport?.selectedCandidatePairId)
    return report.get(transport.selectedCandidatePairId);
  const candidates = Array.from(report.values()).filter(
    (stat) =>
      stat.type === "candidate-pair" &&
      stat.nominated &&
      stat.state === "succeeded",
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Counts frames submitted to this video element's compositor, not physical scanout or motion. */
export class VideoPresentation {
  private video?: HTMLVideoElement;
  private track?: MediaStreamTrack;
  private callback?: number;
  private frames?: number;
  private previous?: { frames: number; at: number };
  private lastPresentedAt?: number;
  private generation = 0;
  private now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  reset() {
    this.generation++;
    if (this.callback !== undefined)
      this.video?.cancelVideoFrameCallback?.(this.callback);
    this.video = undefined;
    this.track = undefined;
    this.callback = undefined;
    this.frames = undefined;
    this.previous = undefined;
    this.lastPresentedAt = undefined;
  }

  bind(
    video: HTMLVideoElement | undefined,
    track: MediaStreamTrack | undefined,
  ) {
    if (video === this.video && track === this.track) return;
    this.reset();
    if (!video?.requestVideoFrameCallback || !track) return;
    this.video = video;
    this.track = track;
    const generation = this.generation;
    const next = () => {
      this.callback = video.requestVideoFrameCallback((_now, metadata) => {
        if (generation !== this.generation) return;
        // Metadata includes skipped callbacks when the main thread was busy.
        this.frames = metadata.presentedFrames;
        this.lastPresentedAt = this.now();
        next();
      });
    };
    next();
  }

  sample() {
    const at = this.now();
    const previous = this.previous;
    const frames = this.frames;
    this.previous = frames === undefined ? undefined : { frames, at };
    return {
      fps:
        previous &&
        frames !== undefined &&
        frames >= previous.frames &&
        at > previous.at
          ? ((frames - previous.frames) * 1000) / (at - previous.at)
          : undefined,
      sinceLastFrameMs:
        this.lastPresentedAt === undefined
          ? undefined
          : at - this.lastPresentedAt,
    };
  }
}

/** One in-flight read. Invalidated reads cannot publish or update baselines. */
export function pollScreenShareStats(
  sample: (isCurrent: () => boolean) => Promise<void>,
  reset: () => void,
  visibility: Pick<
    Document,
    "hidden" | "addEventListener" | "removeEventListener"
  >,
) {
  let generation = 0;
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number) => {
    if (!stopped && !visibility.hidden) timer = setTimeout(run, delay);
  };
  const run = async () => {
    timer = undefined;
    if (stopped || visibility.hidden || busy) return;
    busy = true;
    const epoch = generation;
    try {
      await sample(
        () => !stopped && !visibility.hidden && generation === epoch,
      );
    } catch {
      if (!stopped && generation === epoch) reset();
    } finally {
      busy = false;
      schedule(generation === epoch ? 1000 : 0);
    }
  };
  const invalidate = () => {
    generation++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    reset();
    if (!busy) schedule(0);
  };
  visibility.addEventListener("visibilitychange", invalidate);
  schedule(0);
  return {
    invalidate,
    stop() {
      stopped = true;
      invalidate();
      visibility.removeEventListener("visibilitychange", invalidate);
    },
  };
}
