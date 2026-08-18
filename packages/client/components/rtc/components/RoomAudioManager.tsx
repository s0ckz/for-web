import { createEffect, createMemo } from "solid-js";
import { AudioTrack, useTracks } from "solid-livekit-components";

import { getTrackReferenceId, isLocal } from "@livekit/components-core";
import { Key } from "@solid-primitives/keyed";
import { RemoteTrackPublication, Track } from "livekit-client";

import { useState } from "@revolt/state";

import { isSoundboardPublication } from "../soundboard";
import { useVoice } from "../state";

export function RoomAudioManager() {
  const voice = useVoice();
  const state = useState();

  const tracks = useTracks(
    [
      Track.Source.Microphone,
      Track.Source.ScreenShareAudio,
      Track.Source.Unknown,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: false,
    },
  );

  const filteredTracks = createMemo(() =>
    tracks().filter(
      (track) =>
        !isLocal(track.participant) &&
        track.publication.kind === Track.Kind.Audio,
    ),
  );

  createEffect(() => {
    const tracks = filteredTracks();
    console.info("[rtc] filtered tracks", filteredTracks());
    for (const track of tracks) {
      (track.publication as RemoteTrackPublication).setSubscribed(true);
      console.info(track.publication);
    }
  });

  return (
    <div style={{ display: "none" }}>
      <Key each={filteredTracks()} by={(item) => getTrackReferenceId(item)}>
        {(track) => (
          <AudioTrack
            trackRef={track()}
            volume={
              state.voice.outputVolume *
              (isSoundboardPublication(track().publication)
                ? state.voice.soundboardVolume
                : track().source === Track.Source.ScreenShareAudio
                  ? state.voice.getScreenShareVolume(
                      track().participant.identity,
                    )
                  : state.voice.getUserVolume(track().participant.identity))
            }
            muted={
              (isSoundboardPublication(track().publication)
                ? state.voice.soundboardMuted ||
                  state.voice.getSoundboardUserMuted(
                    track().participant.identity,
                  )
                : track().source === Track.Source.ScreenShareAudio
                  ? // Screen share audio follows the watch choice: a stream you
                    // declined should not be audible, and `muted` maps to
                    // setEnabled(false) so the server stops sending it too.
                    state.voice.getScreenShareMuted(
                      track().participant.identity,
                    ) ||
                    !state.voice.getScreenShareWatching(
                      track().participant.identity,
                    )
                  : state.voice.getUserMuted(track().participant.identity)) ||
              voice.deafen()
            }
            enableBoosting
          />
        )}
      </Key>
    </div>
  );
}
