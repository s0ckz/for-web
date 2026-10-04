/** Local benchmark preferences; never bypass codec eligibility or viewer safety. */
export type ScreenShareExperiment = Readonly<{
  codec: "auto" | "h264" | "h265";
  maxBitrate?: number;
}>;

export function screenShareExperimentsEnabled(
  development: boolean,
  buildFlag: string | undefined,
  hostname: string,
) {
  return (
    (development || buildFlag === "true") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
  );
}

/** Only bounded, reviewed test values are accepted; production gets no override. */
export function screenShareExperiment(
  enabled: boolean,
  codec: unknown,
  maxBitrate: unknown,
): ScreenShareExperiment | undefined {
  if (!enabled) return undefined;
  const preference = codec === "h264" || codec === "h265" ? codec : "auto";
  const ceiling = [4_500_000, 6_000_000, 8_000_000].includes(
    maxBitrate as number,
  )
    ? (maxBitrate as number)
    : undefined;
  return preference === "auto" && ceiling === undefined
    ? undefined
    : Object.freeze({ codec: preference, maxBitrate: ceiling });
}
