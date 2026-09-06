import { ScreenShareCaptureOptions } from "livekit-client";

/**
 * Whether this client is the desktop (Electron) build, rather than a plain
 * browser tab.
 *
 * This is the one place every browser-vs-desktop decision in this module
 * should route through, so nothing keys on `window.native` ad hoc the way
 * the screen-picker registration in `state.tsx` (`window.native &&
 * window.native.onceScreenPicker`) does. The desktop build solves the
 * problem this module exists for -- an app leaking its own audio through a
 * screen share -- at the source, with per-process capture and a blocklist,
 * so every function below is written to be a no-op there.
 * @returns Whether `window.native` is present
 */
export function isNativeDesktop(): boolean {
  return typeof window.native !== "undefined";
}

/**
 * Whether this browser recognises the `displaySurface` capture constraint
 * at all.
 *
 * Per spec, an unrecognised constraint member is simply ignored by
 * `getDisplayMedia` -- but checking first keeps this file clear of Safari,
 * which LiveKit's own `screenCaptureToDisplayMediaStreamOptions` already
 * special-cases for capture resolution
 * (livekit-client/src/room/track/utils.ts:204-210), without resorting to
 * user-agent sniffing (this repo has none today, and this should not be
 * the file that introduces it).
 * @returns Whether `getSupportedConstraints().displaySurface` is `true`
 */
export function supportsDisplaySurfaceConstraint(): boolean {
  return (
    navigator.mediaDevices.getSupportedConstraints().displaySurface === true
  );
}

/**
 * Browser-only capture options for a screen share: a `displaySurface` hint
 * and a `systemAudio` inclusion/exclusion choice.
 *
 * Returns `{}` on desktop, so every call site can spread this in
 * unconditionally rather than branching on `isNativeDesktop()` itself --
 * on desktop that keeps the options object passed to
 * `setScreenShareEnabled` / `createScreenTracks` byte-identical to what it
 * was before this file existed.
 * @param settings The saved settings this decision depends on
 * @param settings.screenShareQualityAsk Whether the quality/audio dialog still runs at share start
 * @param settings.screenShareAudio The saved "share audio by default" preference
 * @returns `video`/`systemAudio` to spread into a `ScreenShareCaptureOptions`
 */
export function browserCaptureOptions(settings: {
  screenShareQualityAsk: boolean;
  screenShareAudio: boolean;
}): Pick<ScreenShareCaptureOptions, "video" | "systemAudio"> {
  if (isNativeDesktop()) return {};

  return {
    // Gated on `supportsDisplaySurfaceConstraint()` (unlike `systemAudio`
    // below): `displaySurface` is a `getDisplayMedia` constraint, and per
    // spec an unrecognised constraint member is simply ignored -- but
    // checking first keeps this file clear of Safari (see that function's
    // doc comment). A hint, not enforcement: Chrome opens its picker on the
    // Window pane, but the user can still switch to Screen (or a browser
    // tab) from there. This addresses a user who reported seeing "only
    // screens" and never finding the Window pane at all -- it does not, by
    // itself, stop anyone from sharing a monitor.
    ...(supportsDisplaySurfaceConstraint()
      ? { video: { displaySurface: "window" } }
      : {}),
    // Not gated on `supportsDisplaySurfaceConstraint()`: `systemAudio` is a
    // `getDisplayMedia` dictionary member, not a constraint, so it is never
    // something `getSupportedConstraints()` can report on either way --
    // tying it to that check would suppress it on any browser the check
    // happens to answer "no" for, for a reason that has nothing to do with
    // what the check actually tests.
    //
    // Only exclude system audio when the user has committed to both "no
    // share audio" and "don't ask me again": passing "exclude" whenever
    // `screenShareAudio` is merely false would break the default flow,
    // where the quality/audio dialog is the user's per-share chance to
    // turn audio *on*. Once both are set, that dialog will never run again
    // to offer that choice, so exclusion is what was asked for -- though
    // per the W3C spec and Chrome's screen-sharing-controls doc,
    // `systemAudio` only ever applies to a monitor surface; excluding it
    // has no effect on a tab or window share either way.
    systemAudio:
      !settings.screenShareQualityAsk && !settings.screenShareAudio
        ? "exclude"
        : "include",
  };
}

/**
 * How risky a captured screen-share surface is, in terms of unintentionally
 * broadcasting audio the sharer did not mean to share.
 *
 * `"none"` covers both "genuinely fine" (tab audio, or no audio at all) and
 * "not our call to make" (desktop, which solves this elsewhere). `"leak"`
 * is reserved for the one case the browser confirms is the whole machine's
 * audio mix.
 */
export type SurfaceRisk = "none" | "caution" | "leak";

/**
 * Classify a just-captured screen share by how likely its audio track (if
 * any) is to be broadcasting more than the sharer intended.
 *
 * The trigger is the presence of an audio track, not the surface alone --
 * that is load-bearing, not incidental. It is what keeps this correct
 * whichever way the open question below resolves, and it is why macOS
 * Chrome (which only ever attaches genuinely tab-scoped audio) and Firefox
 * (which does not support display-media audio at all) never see a warning
 * that does not apply to them: no audio track means nothing to leak,
 * regardless of what `displaySurface` says.
 *
 * Risk table (implement exactly):
 *
 * | `displaySurface`   | audio track | risk    | why                                            |
 * |---------------------|-------------|---------|-------------------------------------------------|
 * | `"browser"` (tab)    | yes         | none    | tab audio is genuinely scoped to the tab         |
 * | `"monitor"`          | yes         | leak    | this is the whole machine's audio                |
 * | `"window"`           | yes         | caution | provisional -- see the open question below       |
 * | any                  | no          | none    | no audio track, nothing to leak                  |
 * | `undefined`          | yes         | caution | unknown surface -- never assume "monitor"        |
 * | any                  | any (desktop) | none  | desktop solves this at the source, not here      |
 *
 * Open question this table is deliberately built to survive either way:
 * whether Chrome on Windows attaches an audio track to a *window* share at
 * all and, if it does, whether that track is scoped to the shared window
 * or carries the whole system mix -- Chrome's own documentation
 * contradicts itself on this. That is why `"window"` sits at `caution`
 * rather than being folded into `"none"` or `"leak"`: this row is
 * provisional, and should move to `"leak"` if field data (via the
 * `console.info` below) shows a window share carries the full system mix,
 * or to `"none"` if it shows the capture is genuinely scoped to that
 * window.
 * @param videoTrack The captured screen-share video track
 * @param hasAudio Whether a screen-share audio track was also captured
 * @returns The surface reported by the browser (if any) and its risk
 */
export function classifyCapturedSurface(
  videoTrack: MediaStreamTrack | undefined,
  hasAudio: boolean,
): { displaySurface?: string; risk: SurfaceRisk } {
  if (isNativeDesktop()) return { risk: "none" };

  // `getSettings().displaySurface` comes back `undefined` on a browser that
  // does not report it at all (or does not support the constraint) -- that
  // must never be read as "monitor". The `undefined` branch below is
  // exactly the fallback that keeps it as merely `caution`.
  const displaySurface = videoTrack?.getSettings().displaySurface;

  let risk: SurfaceRisk;
  if (!hasAudio) {
    risk = "none";
  } else if (displaySurface === "browser") {
    risk = "none";
  } else if (displaySurface === "monitor") {
    risk = "leak";
  } else {
    // Covers both "window" and unknown/undefined -- see the open question
    // above.
    risk = "caution";
  }

  // Deliberate diagnostic logging, not stray debugging output -- do not
  // remove this as unrelated. There is no web API to ask ahead of time
  // whether a window share will carry system audio (see the open question
  // above), and this is a local devtools log with no collection path, so
  // it does not settle that question on its own -- it only can if someone
  // opens devtools during a window share and reports back what it printed.
  // That is a real limitation, not a placeholder for telemetry that
  // exists elsewhere in this codebase; it is better than guessing from
  // documentation that disagrees with itself, but it is not a substitute
  // for an actual collection path if this needs settling faster than that.
  console.info("[rtc] screen share surface", {
    displaySurface,
    hasAudio,
    risk,
  });

  return { displaySurface, risk };
}
