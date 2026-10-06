# Screen share performance comparisons

The normal client keeps its existing codec policy and quality ceilings. These
controls are for local comparisons, before starting a new share.

## Enable local controls

Vite development builds offer the controls only on `localhost`, `127.0.0.1`, or
`[::1]`. To test a compiled preview, set `VITE_SCREEN_SHARE_TEST_CONTROLS=true`
**for that build**, then serve it on a loopback address. Normal production builds
leave the flag unset. A non-loopback hostname cannot enable the controls even
when the flag was set.

The controls appear in screen share settings under voice settings and in the
desktop source picker. They offer:

- Codec preference: automatic, H.264, or H.265.
- Bitrate ceiling: preset default, 4.5, 6, or 8 Mbps.

Preferences live in page memory and reset on reload. They apply to the next
share. Changing them does not alter an existing share. Quality changes,
reconnections, capture recovery and source replacement retain the existing
share's test configuration until that share ends.

Codec preferences do not force unsafe encoders. The hardware capability probe
must succeed at the selected resolution, frame rate and bitrate. H.264 requires
the constrained-baseline hint. H.265 additionally requires affirmative Main
receive support from every current remote participant. Missing capability,
unknown/incompatible viewers, timeout and runtime software cooldown retain the
automatic fallback. A later incompatible viewer retains LiveKit's compatible
backup regression policy. Inspect the logged decision and actual negotiated
codec: selecting H.265 in the controls does not prove H.265 was used.

The codec-decision log includes anonymous `viewerSupport` counts from the same
post-probe audience check: `total`, `supported` (`1`), `unsupported` (`0`),
`unknown` (missing or unrecognized announcement), and `allowed`. These include
every remote participant, even someone who is not watching. Zero participants
also leaves HEVC disabled. No participant identities or raw attributes are
logged. A warm-up decision without a room has zero participants; inspect the
decision for the actual share start.

On voice connection/reconnection, the local receive-capability log separates
`supported` from `advertised`. A successful attribute update does not prove that
every peer has received it. A rejected update keeps the compatible fallback;
a capability-query failure logs support as unknown. These logs explain a blocked
comparison without forcing H.265 or changing a live share.

Capability results are cached separately by bitrate. Runtime software evidence
still applies across bitrate choices for the same resolution/frame-rate preset,
so changing a test ceiling cannot bypass that cooldown.

## Compare like for like

Use 720p60, the same capture surface, game scene/replay, weather and viewers.
Keep FSR Quality and the 60 FPS game cap fixed. Warm up first, then record at
least two minutes of the same scene for each condition. Repeat in reverse order
to expose scene and thermal effects. Include rain after the baseline comparison.

| Condition               | Preference | Ceiling  |
| ----------------------- | ---------- | -------- |
| A                       | H.264      | 6 Mbps   |
| B                       | H.265      | 6 Mbps   |
| C                       | H.264      | 8 Mbps   |
| D, only if B works well | H.265      | 4.5 Mbps |

Stop and start the share for each condition. Do not compare a run that silently
fell back to another codec as an HEVC result. Note viewer feedback, visual
quality and latency alongside the measurements. A ceiling is not a requested
constant bitrate. H.265's efficiency must be evaluated at comparable quality;
the same ceiling does not promise lower actual network traffic.

## Read the measurements

The existing publication-owned, non-overlapping ten-second sender poll logs:

- Capture dimensions, requested frame rate, content hint, actual encoding
  ceilings/scaling and effective degradation preference.
- Requested test preference, selected codec, probed bitrate and the owning test
  configuration, separately from the negotiated RTP codec.
- Source, encoded and sent frame rates from counter deltas; actual RTP bitrate
  and mean encode time per encoded frame.
- Optional encoder target bitrate, mean quantizer, resolution-change count,
  retransmission bitrate, mean packet send delay and NACK/PLI/FIR deltas.
- Separate `observedResolutionChanges` (0 or 1 per valid adjacent sample) and
  `resolutionTransition` with the RTP timestamp and previous/current dimensions.
  This remains available when the browser's resolution-change counter stays
  zero. Missing dimensions, changed stream identity or a reset leave the
  observation unknown; do not infer changes across that gap. Changes between
  polls may be missed, so this is not an exact lifetime adaptation count or
  time spent at each quality. The panel labels browser and observed counts
  separately, and clears its observation baseline on visibility/owner changes.
- Optional remote receiver-report loss deltas, reported fraction lost and RTT.
  These describe the sender-to-SFU leg, not every viewer's downstream path.
- Recent quality-limitation durations and the selected video transport's
  bandwidth estimate. That estimate is shared transport headroom, not a
  dedicated screen-share allocation or proof of internet capacity.

Missing browser fields remain unknown rather than zero. The first sample, a
counter reset, changed SSRC/codec/source/transport, or replaced sender starts a
new baseline. Mean QP is codec-specific and cannot be compared numerically
between H.264 and H.265. A receiver's cumulative packets lost may decrease when
late packets arrive; its signed correction is preserved.

The sender's stats panel shows ceiling versus target bitrate, mean QP, send
delay, retransmission bitrate, effective degradation preference and recent
adaptation/feedback counts. Viewer received, decoded and presented frame rates
remain separate. No additional periodic stats loop is introduced.

Native capture stage logs distinguish source arrival, pacing, submission,
readback, bridge delivery and backpressure. Their timing histograms are
**cumulative for the capture session**. Derive interval means using changes in
`count * mean`; do not describe a cumulative percentile as the last ten seconds.
Multiple staging slots overlap GPU work, so an 18 ms readback wait alone does
not establish a 55 FPS ceiling.

## Decide what to optimize

1. Check the actual encoder path with publication stats and OS GPU counters.
   A capability hint is not proof of an active hardware encode. Missing encoder
   identity is unknown; zero OS counters merit investigation and corroboration.
2. If source arrival is already below the requested rate with no pacing or
   queue pressure, investigate capture/presentation cadence and GPU contention.
   Bitrate cannot manufacture the missing source frames.
3. If capture is healthy but output repeatedly changes resolution near the
   ceiling, compare codec efficiency and allocation using A/B/C.
4. If sender output is stable while a viewer's presented rate falls, investigate
   that viewer's reception, decoding and presentation.

Potential later native work includes an isolated monitor comparison with
Desktop Duplication, and a prototype eliminating CPU readback/copies through
GPU texture interoperability. Neither is justified as a default replacement
without measurements. AMD offload needs separate encoder routing, compatibility
checks and cross-adapter transfer measurements; changing the capture adapter
alone does not route WebRTC encoding to the integrated GPU.
