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
export { useVoice, VoiceContext } from "./state";

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
