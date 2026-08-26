import { createSignal, For, onCleanup, Show } from "solid-js";

import type { TrackReference } from "solid-livekit-components";

import { isLocal } from "@livekit/components-core";
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

  const sending = () => isLocal(props.trackRef.participant);

  /**
   * Stats for your own share: what the capturer produced, what the encoder
   * actually sent, and what held it back.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sampleOutbound = async (track: any) => {
    const sender: RTCRtpSender | undefined = track?.sender;

    if (!sender?.getStats) {
      setRows([{ label: "Status", value: "not publishing" }]);
      return;
    }

    let report: RTCStatsReport;
    try {
      report = await sender.getStats();
    } catch {
      setRows([{ label: "Status", value: "stats unavailable" }]);
      return;
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
      setRows([{ label: "Status", value: "no video being sent" }]);
      return;
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

    lastBytes = bytes;
    lastAt = now;
    lastFramesSent = framesSent;

    const codec = codecs.get(outbound.codecId);

    // Where the time went while quality was limited -- `cpu` here means the
    // encoder could not keep up, `bandwidth` means the network could not.
    const durations = outbound.qualityLimitationDurations ?? {};
    const limitBreakdown = ["cpu", "bandwidth", "other"]
      .filter((k) => (durations[k] ?? 0) > 0.1)
      .map((k) => `${k} ${(durations[k] as number).toFixed(1)}s`)
      .join(", ");

    const next: Row[] = [
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
      { label: "Encoder", value: outbound.encoderImplementation ?? NA },
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
        label: "NACK / PLI",
        value: `${outbound.nackCount ?? 0} / ${outbound.pliCount ?? 0}`,
      },
    ];

    setRows(next);
  };

  const sample = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const track = props.trackRef.publication?.track as any;

    if (sending()) return sampleOutbound(track);

    const receiver: RTCRtpReceiver | undefined = track?.receiver;

    if (!receiver?.getStats) {
      setRows([{ label: "Status", value: "no receiver (not subscribed?)" }]);
      return;
    }

    let report: RTCStatsReport;
    try {
      report = await receiver.getStats();
    } catch {
      setRows([{ label: "Status", value: "stats unavailable" }]);
      return;
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
      setRows([{ label: "Status", value: "no video being received" }]);
      return;
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

    const next: Row[] = [
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

    setRows(next);
  };

  sample();
  const timer = setInterval(sample, 1000);
  onCleanup(() => clearInterval(timer));

  const copy = async () => {
    const body = rows()
      .map((r) => `${r.label.padEnd(16)} ${r.value}`)
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
        <For each={rows()}>
          {(row) => (
            <>
              <Label>{row.label}</Label>
              <Value>{row.value}</Value>
            </>
          )}
        </For>
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
