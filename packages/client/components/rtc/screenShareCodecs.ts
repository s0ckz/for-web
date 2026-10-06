import type { ScreenShareExperiment } from "./screenShareExperiments";

/** Codec capability hints and runtime recovery, independent of capture/RTC ownership. */
export type ScreenShareCodec = "h264" | "h265" | "vp9";
export type CodecProbe = {
  contentType: string;
  supported: boolean;
  powerEfficient: boolean;
  error?: "probe-rejected";
};
export type CodecRequest = {
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
};
export type ScreenShareCodecDecision = {
  key: string;
  revision: number;
  codec: ScreenShareCodec;
  reason: string;
  probes: CodecProbe[];
  cbpHardware: boolean;
  at: number;
  retryAt: number | null;
  h265Allowed: boolean;
  bitrate: number;
  requestedCodec: "auto" | "h264" | "h265";
  viewerSupport?: H265ViewerSupport;
  experiment?: ScreenShareExperiment;
};

export type H265ViewerSupport = {
  total: number;
  supported: number;
  unsupported: number;
  unknown: number;
  allowed: boolean;
};

export const H265_RECEIVE_ATTRIBUTE = "stoat:h265-receive";
// Only the constrained-baseline H.264 hint is actionable. LiveKit selects a
// codec, not a profile; Main/High hardware support cannot prove CBP encoding.
export const CODEC_CONTENT_TYPES = [
  "video/H265",
  "video/H264;profile-level-id=42e01f;packetization-mode=1",
  "video/H264;profile-level-id=4d001f;packetization-mode=1",
  "video/H264;profile-level-id=640c1f;packetization-mode=1",
] as const;
export const CODEC_SOFTWARE_COOLDOWN_MS = 120_000;
const CAPABILITY_TTL_MS = 300_000;

/** Recovery uses HEVC Main, not a Main10-only decoder or another RTP mode. */
export function supportsH265Receive(
  codecs: readonly { mimeType: string; sdpFmtpLine?: string }[] | undefined,
) {
  return !!codecs?.some((codec) => {
    if (codec.mimeType.toLowerCase() !== "video/h265") return false;
    const parameters = new Map(
      (codec.sdpFmtpLine ?? "").split(";").map((part) => {
        const [key, value] = part.trim().split("=");
        return [key, value] as const;
      }),
    );
    // RFC 7798 defaults: Main profile, profile space 0, single RTP stream.
    return (
      (!parameters.has("profile-id") || parameters.get("profile-id") === "1") &&
      (parameters.get("profile-space") ?? "0") === "0" &&
      (parameters.get("tx-mode") ?? "SRST") === "SRST"
    );
  });
}

/** Anonymous counts include every remote participant, even those not watching. */
export function h265ViewerSupport(
  attributes: Iterable<Readonly<Record<string, string>>>,
): H265ViewerSupport {
  let total = 0;
  let supported = 0;
  let unsupported = 0;
  let unknown = 0;
  for (const value of attributes) {
    ++total;
    if (value[H265_RECEIVE_ATTRIBUTE] === "1") ++supported;
    else if (value[H265_RECEIVE_ATTRIBUTE] === "0") ++unsupported;
    else ++unknown;
  }
  return {
    total,
    supported,
    unsupported,
    unknown,
    allowed: total > 0 && supported === total,
  };
}

/** Unknown/older clients keep recovery on the broadly compatible fallback. */
export function viewersAllowH265(
  attributes: Iterable<Readonly<Record<string, string>>>,
) {
  return h265ViewerSupport(attributes).allowed;
}

export function codecKey(request: {
  width: number;
  height: number;
  frameRate?: number;
}) {
  return `${request.width}x${request.height}@${request.frameRate ?? 30}`;
}

type Capability = {
  revision: number;
  probes: CodecProbe[];
  negotiable: Set<string>;
  expiresAt: number;
};
type Slot = {
  revision: number;
  capability?: Capability;
  pending?: { at: number; promise: Promise<Capability | undefined> };
  blocked: Partial<Record<ScreenShareCodec, number>>;
};

/** Share starts return their own snapshot; background warming cannot swap it. */
export class ScreenShareCodecSelector {
  private slots = new Map<string, Slot>();
  private blockedByPreset = new Map<string, Slot["blocked"]>();
  private dependencies: {
    probe: (contentType: string, request: CodecRequest) => Promise<CodecProbe>;
    negotiable: () => string[];
    now?: () => number;
    timeoutMs?: number;
  };

  constructor(dependencies: ScreenShareCodecSelector["dependencies"]) {
    this.dependencies = dependencies;
  }

  private now() {
    return (this.dependencies.now ?? Date.now)();
  }

  async select(
    request: CodecRequest,
    allowH265: () => boolean = () => false,
    preference: "auto" | "h264" | "h265" = "auto",
  ): Promise<ScreenShareCodecDecision> {
    const key = codecKey(request);
    // A capability probe describes its bitrate as well as resolution/cadence.
    const cacheKey = `${key}:${request.bitrate}`;
    let slot = this.slots.get(cacheKey);
    if (!slot) {
      const blocked = this.blockedByPreset.get(key) ?? {};
      this.blockedByPreset.set(key, blocked);
      slot = { revision: 0, blocked };
      this.slots.set(cacheKey, slot);
    }
    const current = slot;
    const now = this.now();
    const cooldownExpired = Object.values(current.blocked).some(
      (until) => until !== undefined && until <= now,
    );
    for (const codec of ["h264", "h265"] as const) {
      if ((current.blocked[codec] ?? Infinity) <= now)
        delete current.blocked[codec];
    }
    // A retry after software evidence must re-probe, not reuse the old hint.
    if (cooldownExpired) current.capability = undefined;
    let capability = current.capability;
    if (!capability || capability.expiresAt <= now) {
      const timeoutMs = this.dependencies.timeoutMs ?? 1_500;
      // A hung probe must not be reused for the entire page lifetime.
      if (!current.pending || current.pending.at + timeoutMs * 2 <= now) {
        const revision = ++current.revision;
        let negotiable: Set<string>;
        try {
          negotiable = new Set(
            this.dependencies.negotiable().map((mime) => mime.toLowerCase()),
          );
        } catch {
          negotiable = new Set();
        }
        const promise = Promise.all(
          CODEC_CONTENT_TYPES.map(async (contentType): Promise<CodecProbe> => {
            try {
              return await this.dependencies.probe(contentType, request);
            } catch {
              return {
                contentType,
                supported: false,
                powerEfficient: false,
                error: "probe-rejected",
              };
            }
          }),
        ).then((probes) => {
          if (current.revision !== revision) return undefined;
          const value = {
            revision,
            probes,
            negotiable,
            expiresAt: Math.min(
              this.now() + CAPABILITY_TTL_MS,
              ...Object.values(current.blocked).filter(
                (until): until is number => !!until && until > this.now(),
              ),
            ),
          };
          // A rejected codec can be transient; don't cache the batch indefinitely.
          if (!probes.some((probe) => probe.error)) current.capability = value;
          if (current.pending?.promise === promise) current.pending = undefined;
          return value;
        });
        current.pending = { at: now, promise };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      capability = await Promise.race([
        current.pending.promise,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    }
    const h265Allowed = allowH265();
    const at = this.now();
    const blocked = (codec: ScreenShareCodec) =>
      (current.blocked[codec] ?? 0) > at;
    const probes = capability?.probes ?? [];
    const hardwareHint = (index: number) =>
      !!probes[index]?.supported && !!probes[index]?.powerEfficient;
    const cbpHardware =
      !!capability?.negotiable.has("video/h264") &&
      hardwareHint(1) &&
      !blocked("h264");
    const h265Hardware =
      !!capability?.negotiable.has("video/h265") &&
      hardwareHint(0) &&
      !blocked("h265");
    const automatic = cbpHardware
      ? "h264"
      : h265Hardware && h265Allowed
        ? "h265"
        : "vp9";
    const preferredEligible =
      preference === "h264"
        ? cbpHardware
        : preference === "h265" && h265Hardware && h265Allowed;
    const codec =
      preferredEligible && preference !== "auto" ? preference : automatic;
    const retryAt = Math.min(
      ...Object.values(current.blocked).filter(
        (until): until is number => !!until && until > at,
      ),
    );
    const reason = !capability
      ? "probe timed out or superseded; compatible fallback for this share"
      : codec === "h264"
        ? "H.264 constrained-baseline hardware capability reported; runtime verification pending"
        : codec === "h265"
          ? "H.265 hardware capability reported; current viewers advertise H.265 reception"
          : h265Hardware && !h265Allowed
            ? "H.264 unavailable or cooling down; H.265 held for unknown/incompatible viewers"
            : "no eligible H.26x hardware candidate; compatible VP9 fallback";
    return {
      key,
      revision: capability?.revision ?? current.revision,
      codec,
      reason:
        preference === "auto"
          ? reason
          : `test preference ${preference} ${preferredEligible ? "eligible" : "unavailable; automatic fallback"}; ${reason}`,
      probes,
      cbpHardware,
      at,
      retryAt: Number.isFinite(retryAt) ? retryAt : null,
      h265Allowed,
      bitrate: request.bitrate,
      requestedCodec: preference,
    };
  }

  /** Call only for active primary-codec software evidence from the owning publication. */
  recordSoftware(decision: ScreenShareCodecDecision) {
    const slot = this.slots.get(`${decision.key}:${decision.bitrate}`);
    if (
      !slot ||
      slot.revision !== decision.revision ||
      decision.codec === "vp9"
    )
      return undefined;
    const retryAt = this.now() + CODEC_SOFTWARE_COOLDOWN_MS;
    slot.blocked[decision.codec] = retryAt;
    // Changing a test ceiling must not bypass software evidence for this preset.
    for (const [key, affected] of this.slots) {
      if (!key.startsWith(`${decision.key}:`)) continue;
      ++affected.revision;
      affected.pending = undefined;
      if (affected.capability) {
        affected.capability.revision = affected.revision;
        affected.capability.expiresAt = Math.min(
          affected.capability.expiresAt,
          retryAt,
        );
      }
    }
    return retryAt;
  }
}

export type EncoderStat = {
  id: string;
  type: string;
  kind?: string;
  mediaType?: string;
  codecId?: string;
  framesEncoded?: number;
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  mimeType?: string;
  sdpFmtpLine?: string;
  frameWidth?: number;
  frameHeight?: number;
};

/** Backup encodes and a later quality choice must not penalize the original preset. */
export function matchesPrimarySoftware(
  decision: ScreenShareCodecDecision,
  currentKey: string | undefined,
  observation: { codec: string | null; advancing: boolean; software: boolean },
) {
  return (
    decision.key === currentKey &&
    observation.advancing &&
    observation.software &&
    observation.codec === `video/${decision.codec}`
  );
}

/** Preserve only codec configuration, never raw SDP or arbitrary fmtp parameters. */
export function codecProfile(fmtp: string | undefined) {
  const allowed = new Set([
    "profile-level-id",
    "packetization-mode",
    "level-asymmetry-allowed",
    "profile-id",
    "tier-flag",
    "level-id",
    "tx-mode",
  ]);
  const fields: Record<string, string> = {};
  for (const part of (fmtp ?? "").split(";")) {
    const [key, value] = part.trim().split("=");
    if (allowed.has(key) && value && /^[a-zA-Z0-9-]{1,16}$/.test(value))
      fields[key] = value;
  }
  return fields;
}

/** Poll serially and verify ownership after getStats; missing identity is unknown. */
export function startScreenShareEncoderMonitor(options: {
  getSender: () => RTCRtpSender | undefined;
  isCurrent: () => boolean;
  observe: (observation: {
    codec: string | null;
    profile: Record<string, string>;
    encoder: string | null;
    powerEfficient: boolean | null;
    advancing: boolean;
    software: boolean;
    resolution: (number | null)[];
  }) => void;
  intervalMs?: number;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previousSender: RTCRtpSender | undefined;
  const previous = new Map<
    string,
    { frames: number; codecId: string | undefined }
  >();
  const sample = async () => {
    if (stopped || !options.isCurrent()) return;
    try {
      const sender = options.getSender();
      if (sender) {
        if (sender !== previousSender) previous.clear();
        previousSender = sender;
        const report = await sender.getStats();
        if (stopped || !options.isCurrent() || options.getSender() !== sender)
          return;
        const stats: EncoderStat[] = [];
        report.forEach((stat) => stats.push(stat));
        const byId = new Map(stats.map((stat) => [stat.id, stat]));
        const activeIds = new Set<string>();
        for (const stat of stats) {
          if (
            stat.type !== "outbound-rtp" ||
            (stat.kind ?? stat.mediaType) !== "video"
          )
            continue;
          activeIds.add(stat.id);
          const before = previous.get(stat.id);
          const frames = stat.framesEncoded;
          const advancing =
            before !== undefined &&
            before.codecId === stat.codecId &&
            frames !== undefined &&
            frames > before.frames;
          if (frames !== undefined)
            previous.set(stat.id, { frames, codecId: stat.codecId });
          else previous.delete(stat.id);
          const codec = stat.codecId ? byId.get(stat.codecId) : undefined;
          const encoder = stat.encoderImplementation?.slice(0, 120) ?? null;
          options.observe({
            codec: codec?.mimeType?.toLowerCase() ?? null,
            profile: codecProfile(codec?.sdpFmtpLine),
            encoder,
            powerEfficient: stat.powerEfficientEncoder ?? null,
            advancing,
            software:
              !!encoder && /OpenH264|libvpx|libaom|x264|x265/i.test(encoder),
            resolution: [stat.frameWidth ?? null, stat.frameHeight ?? null],
          });
        }
        for (const id of previous.keys()) {
          if (!activeIds.has(id)) previous.delete(id);
        }
      }
    } catch {
      // Diagnostics cannot terminate a live share; retry while it still owns the sender.
      previous.clear();
    } finally {
      if (!stopped && options.isCurrent())
        timer = setTimeout(() => void sample(), options.intervalMs ?? 5_000);
    }
  };
  void sample();
  return () => {
    stopped = true;
    clearTimeout(timer);
    previous.clear();
  };
}
