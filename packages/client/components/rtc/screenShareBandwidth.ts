/** Stream-local evidence; transport BWE and bitrate ceilings are not requirements. */
type BandwidthStat = {
  id: string;
  type: string;
  timestamp: number;
  kind?: string;
  mediaType?: string;
  ssrc?: number;
  codecId?: string;
  mediaSourceId?: string;
  transportId?: string;
  selectedCandidatePairId?: string;
  active?: boolean;
  frameWidth?: number;
  framesSent?: number;
  qualityLimitationReason?: string;
  qualityLimitationDurations?: Record<string, number>;
};

export type ScreenShareBandwidthSample = {
  intervalSeconds?: number;
  limitedSeconds?: number;
  sustained: boolean;
};

const SETTLING_MS = 20_000;
const SUSTAINED_SECONDS = 20;
const MAX_SAMPLE_GAP_MS = 15_000;

/** Actual encoder configuration, so a quality/scale change starts a fresh window. */
export function screenShareBandwidthConfiguration(
  encodings: readonly RTCRtpEncodingParameters[] | undefined,
) {
  return JSON.stringify(
    encodings?.map(
      ({ rid, active, maxBitrate, maxFramerate, scaleResolutionDownBy }) => ({
        rid,
        active,
        maxBitrate,
        maxFramerate,
        scaleResolutionDownBy,
      }),
    ),
  );
}

/**
 * Reuse existing stats reads. Ignore startup and require at least two consecutive
 * intervals covering 20 seconds, each >=50% newly bandwidth limited and still
 * limited now. Missing/reset counters are unknown, never lifetime evidence.
 */
export class ScreenShareBandwidthObserver {
  private owner: unknown;
  private configuration?: string;
  private previous = new Map<string, BandwidthStat>();
  private streamKey?: string;
  private startedAt?: number;
  private sampledAt?: number;
  private pressureSeconds = 0;
  private pressureSamples = 0;
  private now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  reset() {
    this.owner = undefined;
    this.configuration = undefined;
    this.previous.clear();
    this.streamKey = undefined;
    this.startedAt = undefined;
    this.sampledAt = undefined;
    this.pressureSeconds = 0;
    this.pressureSamples = 0;
  }

  read(
    stats: Iterable<BandwidthStat>,
    owner: unknown,
    configuration: string | undefined,
    visible = true,
  ): ScreenShareBandwidthSample {
    const at = this.now();
    if (
      !visible ||
      owner !== this.owner ||
      configuration !== this.configuration ||
      (this.sampledAt !== undefined &&
        (at < this.sampledAt || at - this.sampledAt > MAX_SAMPLE_GAP_MS))
    )
      this.reset();
    if (!visible) return { sustained: false };
    this.owner = owner;
    this.configuration = configuration;
    const before = this.previous;
    const values = Array.from(stats);
    this.previous = new Map(
      values.map((stat) => [
        stat.id,
        {
          ...stat,
          qualityLimitationDurations: stat.qualityLimitationDurations && {
            ...stat.qualityLimitationDurations,
          },
        },
      ]),
    );
    const advancing = (stat: BandwidthStat) =>
      stat.framesSent !== undefined &&
      stat.framesSent > (before.get(stat.id)?.framesSent ?? stat.framesSent);
    const stream = values
      .filter(
        (stat) =>
          stat.type === "outbound-rtp" &&
          (stat.kind ?? stat.mediaType) === "video" &&
          stat.active !== false,
      )
      .sort(
        (a, b) =>
          Number(advancing(b)) - Number(advancing(a)) ||
          (b.frameWidth ?? 0) - (a.frameWidth ?? 0),
      )[0];
    if (!stream) {
      this.reset();
      return { sustained: false };
    }
    const pairId = values.find(
      (stat) => stat.id === stream.transportId,
    )?.selectedCandidatePairId;
    const key = JSON.stringify([
      stream.id,
      stream.ssrc,
      stream.codecId,
      stream.mediaSourceId,
      stream.transportId,
      pairId,
    ]);
    const old = before.get(stream.id);
    const elapsed = old && (stream.timestamp - old.timestamp) / 1000;
    const current = stream.qualityLimitationDurations?.bandwidth;
    const previous = old?.qualityLimitationDurations?.bandwidth;
    const change =
      current !== undefined && previous !== undefined
        ? current - previous
        : undefined;
    const valid =
      elapsed !== undefined &&
      Number.isFinite(elapsed) &&
      elapsed > 0 &&
      elapsed * 1000 <= MAX_SAMPLE_GAP_MS &&
      current! >= 0 &&
      previous! >= 0 &&
      change !== undefined &&
      Number.isFinite(change) &&
      change >= 0 &&
      change <= elapsed + 0.05;
    const intervalStart = this.sampledAt;
    this.sampledAt = at;
    if (
      key !== this.streamKey ||
      !valid ||
      (stream.framesSent !== undefined &&
        old?.framesSent !== undefined &&
        stream.framesSent < old.framesSent)
    ) {
      this.streamKey = key;
      this.startedAt = at;
      this.pressureSeconds = 0;
      this.pressureSamples = 0;
      return { sustained: false };
    }
    const limitedSeconds = Math.min(change!, elapsed!);
    const pressure =
      stream.qualityLimitationReason === "bandwidth" &&
      advancing(stream) &&
      limitedSeconds / elapsed! >= 0.5 &&
      intervalStart !== undefined &&
      intervalStart - this.startedAt! >= SETTLING_MS;
    this.pressureSeconds = pressure ? this.pressureSeconds + elapsed! : 0;
    this.pressureSamples = pressure ? this.pressureSamples + 1 : 0;
    return {
      intervalSeconds: elapsed,
      limitedSeconds,
      sustained:
        this.pressureSamples >= 2 && this.pressureSeconds >= SUSTAINED_SECONDS,
    };
  }
}
