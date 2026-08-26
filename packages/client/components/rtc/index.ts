import {
  setNextScreenShareFrameRate,
  takeNextScreenShareFrameRate,
} from "./screenShareCapture";
import { getVirtmic } from "./virtualMic";

export {
  getMicPublication,
  isSoundboardPublication,
  SOUNDBOARD_TRACK_NAME,
  useIsMicMuted,
} from "./soundboard";
export type { SoundboardSound } from "./soundboard";
export { useSoundboardLibrary } from "./soundboardLibrary";
export type { SoundboardEntry, SoundboardLibrary } from "./soundboardLibrary";
export { registerSpeakingMeter, useIsSpeakingFast } from "./speaking";
export { getScreenShareCodecDecision, useVoice, VoiceContext } from "./state";
export { setNextScreenShareFrameRate };

export { InRoom } from "./components/InRoom";
export { RoomAudioManager } from "./components/RoomAudioManager";
export { stoatSinkName } from "./virtualMic";

const originalMediaCall = navigator.mediaDevices.getDisplayMedia;

navigator.mediaDevices.getDisplayMedia = async function (opts) {
  // Upstream clamped every capture to 640x480 at 5fps here, despite a comment
  // claiming it only held shares to 720p. LiveKit always passes `video` as an
  // object when a resolution is set, so it always fired, and the share only
  // ever recovered because applyConstraints raised it again afterwards. That
  // left the source starting at 5fps -- fatal for a 60fps share, and the prime
  // suspect for shares measuring 11fps. The quality the user picked is already
  // enforced by `resolution` here and applyConstraints after publishing.
  //
  // state.tsx no longer hands LiveKit a capture `resolution` at all -- doing
  // so forced Chromium's WGC capturer to rescale every frame on the capture
  // thread even when the source was smaller than the requested resolution,
  // and Chromium's capture governor (`capture_period = max(2 x
  // last_capture_duration, 1/target_fps)`) doubles the cost of anything that
  // runs on that thread. Output resolution is controlled on the encoder
  // instead (`scaleResolutionDownBy`, in state.tsx's `#applyEncoderLimits`),
  // where hardware H.26x makes it nearly free.
  //
  // But `ScreenShareCaptureOptions` has no `video.frameRate` field, and
  // LiveKit's `screenCaptureToDisplayMediaStreamOptions()` only ever attaches
  // `frameRate` to these constraints when a `resolution` was given -- so
  // dropping `resolution` through LiveKit's own API would silently drop the
  // framerate ask too. `takeNextScreenShareFrameRate()` (see
  // screenShareCapture.ts) is state.tsx's way of asking for a framerate here
  // regardless, at the one remaining place that can still say so to the
  // browser. It only ever touches `opts.video`, so it cannot affect the
  // Wayland virtual-mic swap below, and this wrapper is `getDisplayMedia`
  // specifically, so it is never reached by camera `getUserMedia` either.
  const frameRate = takeNextScreenShareFrameRate();
  if (frameRate !== undefined && opts) {
    opts.video =
      typeof opts.video === "object" && opts.video
        ? { ...opts.video, frameRate: { ideal: frameRate, max: frameRate } }
        : { frameRate: { ideal: frameRate, max: frameRate } };
  }

  const stream: MediaStream = await originalMediaCall.call(this, opts);

  if (opts && opts.audio && window.native?.isWayland?.()) {
    const id = await getVirtmic();

    console.debug("Virt mic acquired:", id);

    if (id) {
      const audio = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: {
            exact: id,
          },
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
          channelCount: 2,
          sampleRate: 48000,
          sampleSize: 16,
        },
      });

      stream.getAudioTracks().forEach((t) => stream.removeTrack(t));
      stream.addTrack(audio.getAudioTracks()[0]);
    }
  }

  return stream;
};
