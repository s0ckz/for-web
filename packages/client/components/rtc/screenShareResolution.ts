type ResolutionStat = {
  id: string;
  timestamp: number;
  type?: unknown;
  kind?: unknown;
  mediaType?: unknown;
  ssrc?: unknown;
  codecId?: unknown;
  mediaSourceId?: unknown;
  trackIdentifier?: unknown;
  transportId?: unknown;
  frameWidth?: unknown;
  frameHeight?: unknown;
  framesEncoded?: unknown;
  framesSent?: unknown;
  bytesSent?: unknown;
  packetsSent?: unknown;
};

function dimensions(stat: ResolutionStat): [number, number] | undefined {
  const { frameWidth: width, frameHeight: height } = stat;
  return typeof width === "number" &&
    Number.isInteger(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height > 0
    ? [width, height]
    : undefined;
}

/** At most one observed transition between polls; not the browser's adaptation counter. */
export function observeResolutionChange(
  current: ResolutionStat,
  previous: ResolutionStat | undefined,
) {
  if (
    !previous ||
    current.id !== previous.id ||
    !Number.isFinite(current.timestamp) ||
    !Number.isFinite(previous.timestamp) ||
    current.timestamp <= previous.timestamp ||
    (current.kind ?? current.mediaType) !==
      (previous.kind ?? previous.mediaType) ||
    [
      "type",
      "ssrc",
      "codecId",
      "mediaSourceId",
      "trackIdentifier",
      "transportId",
    ].some(
      (key) =>
        current[key as keyof ResolutionStat] !==
        previous[key as keyof ResolutionStat],
    ) ||
    ["framesEncoded", "framesSent", "bytesSent", "packetsSent"].some((key) => {
      const now = current[key as keyof ResolutionStat];
      const before = previous[key as keyof ResolutionStat];
      return (
        typeof now === "number" && typeof before === "number" && now < before
      );
    })
  )
    return undefined;
  const from = dimensions(previous),
    to = dimensions(current);
  if (!from || !to) return undefined;
  return {
    changes: from[0] === to[0] && from[1] === to[1] ? 0 : 1,
    timestampMs: current.timestamp,
    from,
    to,
  };
}
