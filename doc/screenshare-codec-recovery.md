# Screen share codec recovery (R15)

## Problem and scope

The last desktop session reported hardware H.264 capability, but the actual
sender used OpenH264. That software observation previously cached VP9 for every
later share at the same resolution and frame rate until the page reloaded.
The later VP9 sender used libvpx, also a software encoder.

This batch fixes recovery and makes negotiation observable. It does not establish
why Chromium missed hardware H.264 or promise higher FPS. Capture remains on the
existing native path. Desktop Duplication (Batch C) and AMD adapter offload remain
separate work; neither is justified by a codec mismatch alone.

## Selection and recovery

- Prefer H.264 when the constrained-baseline capability probe reports both
  supported and power efficient, and the sender can negotiate H.264. Main/High
  probes remain diagnostic hints because LiveKit selects a codec, not a profile.
- Cache capability results for five minutes. Probe errors retry at the next share;
  an error for one codec does not discard another codec's successful result.
- Bound the startup probe wait to 1.5 seconds. A late result can benefit a later
  share but cannot change the options already returned for the current share.
  Replace hung probe generations on subsequent starts.
- Observe the publication's encoder immediately and every five seconds. An
  unknown identity is retried. Record software evidence only for advancing
  frames of the selected primary codec at the original preset.
  Mid-share quality changes retain the published codec and stay visible in
  diagnostics, but do not penalize the original preset's recovery cache.
- Cool down the observed software H.264/H.265 candidate for two minutes at that
  preset. Other presets and codecs retain their own eligibility. After expiry,
  re-probe on the next start. No recovery timer republishes active media.
- Bind observations to the room, publication and sender. Stop on unpublish or
  disconnect; reconnect republishing re-arms monitoring for the same media track.
  Superseded probe generations cannot overwrite newer capability evidence.

## H.265 compatibility

H.265 is eligible when hardware H.264 is unavailable or cooling down, hardware
HEVC capability is reported, and every current remote participant affirmatively
advertises HEVC Main receive capability. No viewers, missing advertisements,
older clients, Main10-only capability and incompatible clients retain VP9.
The gate is evaluated after the asynchronous probe.

Updated clients advertise a single `stoat:h265-receive` attribute (`1` or `0`) on
connect/reconnect, using `RTCRtpReceiver.getCapabilities`. This is a browser
capability hint, not proof of successful decoding at every resolution. It carries
no device identifier or hardware inventory. HEVC Main defaults follow
[RFC 7798](https://www.rfc-editor.org/rfc/rfc7798.html).

HEVC publications request LiveKit's `REGRESSION` backup policy: when a compatible
backup is activated, the server should move subscribers to it rather than retain
two active encoders. See the
[LiveKit protocol](https://github.com/livekit/protocol/blob/main/protobufs/livekit_models.proto)
and [server implementation](https://github.com/livekit/livekit/blob/master/pkg/rtc/mediatrack.go).
This requires validation against the deployed SFU, especially an incompatible
viewer joining after an HEVC share starts. The initial viewer gate cannot cover
future joins or make SFU fallback infallible. A backup becoming active is logged
but does not count as primary encoder failure.

## Diagnostics and validation

`[rtc] screen share codec decision` logs the preset, probes, decision generation,
viewer gate and retry deadline. `[rtc] screen share encoder verification` logs
selected versus actual codec, negotiated profile, encoder implementation,
power-efficiency hint, actual dimensions, current preset, server version and
sender codec profiles. Only whitelisted codec parameters are logged; raw SDP is
excluded. Existing sender diagnostics still provide encode/send FPS, encode time
and interval bandwidth limitation.

Automated regression tests cover cooldown expiry, preset isolation, unknown
viewers, HEVC profiles, concurrent callers, timeout/hung/rejected probes, stale
observations, unknown/inactive encoders and negotiated codec changes. CI runs
the codec tests alongside the TypeScript check.

Before production rollout, use the local web build through the desktop shell
with the production backend configuration and record:

1. A monitored 1080p30 share that reproduces hardware H.264 probe/OpenH264 runtime
   disagreement. Compare offered/negotiated profiles and the actual encoder.
2. Stop/restart within two minutes. Verify HEVC is chosen only with affirmative
   viewer support; otherwise VP9. Stop/restart after expiry and verify H.264 is
   re-probed. A continuously running share must remain published throughout.
3. HEVC with a capable watcher, then an older/incompatible watcher joining later.
   Confirm both receive frames and fallback does not leave parallel encoders
   active. If this fails, keep HEVC recovery out of the rollout.
4. Stop/start quickly, switch quality/source and reconnect. Verify old
   observations do not alter later selections or penalize a different preset.
5. A controlled LMU rain comparison at the same FSR setting, game FPS cap,
   resolution, viewer and network. Compare measured sender/presentation FPS;
   the earlier Wardogs session is not a controlled LMU benchmark.

Next decision: use the new evidence to distinguish profile negotiation from
hardware encoder startup failure. Investigate desktop GPU/Media Foundation
diagnostics if negotiated profiles still match and OpenH264 persists. Pursue
Batch C only if capture acquisition, rather than encoding or bandwidth, remains
the demonstrated bottleneck.
