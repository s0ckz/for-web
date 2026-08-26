/**
 * A one-shot hand-off of the target capture framerate from `state.tsx` to
 * the `getDisplayMedia` wrapper in `index.ts`.
 *
 * `ScreenShareCaptureOptions` (the options object passed to
 * `setScreenShareEnabled`) has no `video.frameRate` field, and LiveKit's
 * `screenCaptureToDisplayMediaStreamOptions()` only ever attaches
 * `frameRate` to the browser-facing constraints when `resolution.width > 0
 * && resolution.height > 0` (checked directly against the compiled
 * source). So the moment `state.tsx` stops handing LiveKit a capture
 * resolution -- to stop Chromium's WGC capturer from doing a full-frame
 * libyuv ARGB->I420 rescale on the capture thread, which Chromium's
 * capture governor (`capture_period = max(2 x last_capture_duration,
 * 1/target_fps)`) then *doubles* the cost of -- LiveKit has no way left to
 * ask for a framerate either. The `getDisplayMedia` wrapper in `index.ts`
 * is the one remaining place that can, since it sees the constraints
 * object right before it reaches the browser.
 *
 * `getDisplayMedia` is invoked by `setScreenShareEnabled` deep inside
 * livekit-client, not by our own code, so a plain function argument isn't
 * possible across that boundary -- this module is the closest equivalent,
 * threaded explicitly: the caller in `state.tsx` sets it immediately
 * before calling `setScreenShareEnabled` and clears it in a `finally`, and
 * the wrapper reads-and-clears it eagerly, so a value can never survive
 * past the one capture it was set for.
 */
let nextScreenShareFrameRate: number | undefined;

/**
 * Set the framerate the very next `getDisplayMedia` call should ask for.
 * Call immediately before `setScreenShareEnabled`; clear with `undefined`
 * in a `finally` around that call.
 * @param frameRate Target capture framerate, or `undefined` to clear
 */
export function setNextScreenShareFrameRate(frameRate: number | undefined) {
  nextScreenShareFrameRate = frameRate;
}

/**
 * Read and clear the pending frame rate in one step, so a `getDisplayMedia`
 * call this wasn't meant for (there shouldn't be a concurrent one, but)
 * can never pick up a stale value.
 * @returns The pending framerate, if any
 */
export function takeNextScreenShareFrameRate(): number | undefined {
  const frameRate = nextScreenShareFrameRate;
  nextScreenShareFrameRate = undefined;
  return frameRate;
}
