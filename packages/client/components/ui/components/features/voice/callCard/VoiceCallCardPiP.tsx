import { createMemo, Show } from "solid-js";
import {
  TrackLoop,
  TrackReference,
  TrackReferenceOrPlaceholder,
  useEnsureParticipant,
  useIsMuted,
  useTrackRefContext,
  useTracks,
  VideoTrack,
} from "solid-livekit-components";

import { Track } from "livekit-client";
import { styled } from "styled-system/jsx";

import { useUser } from "@revolt/markdown/users";
import {
  isSoundboardPublication,
  useIsMicMuted,
  useIsSpeakingFast,
  useVoice,
} from "@revolt/rtc";
import { Avatar } from "@revolt/ui/components/design";
import { Row } from "@revolt/ui/components/layout";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { VoiceCallCardActions } from "./VoiceCallCardActions";
import { VoiceCallCardStatus } from "./VoiceCallCardStatus";

export function VoiceCallCardPiP() {
  const voice = useVoice();
  const allAudTracks = useTracks(
    [{ source: Track.Source.Microphone, withPlaceholder: true }],
    { onlySubscribed: false },
  );

  // The soundboard is a second microphone-source track, which would give its
  // owner two avatars here. Keep exactly one entry per participant.
  const audTracks = createMemo(() => {
    const seen = new Set<string>();
    const result: TrackReferenceOrPlaceholder[] = [];
    const soundboardOnly = new Map<string, TrackReferenceOrPlaceholder>();

    for (const ref of allAudTracks()) {
      const id = ref.participant.identity;
      if (isSoundboardPublication(ref.publication)) {
        if (!seen.has(id)) soundboardOnly.set(id, ref);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      soundboardOnly.delete(id);
      result.push(ref);
    }

    for (const ref of soundboardOnly.values()) {
      if (seen.has(ref.participant.identity)) continue;
      seen.add(ref.participant.identity);
      result.push({
        participant: ref.participant,
        source: Track.Source.Microphone,
      });
    }

    return result;
  });

  const hasFocusVideo = () => {
    const track = voice.focusTrack();
    if (!track) return false;

    return (
      track.source === Track.Source.ScreenShare ||
      !useIsMuted({
        participant: track.participant,
        source: Track.Source.Camera,
      })()
    );
  };

  return (
    <MiniCard>
      <VoiceCallCardStatus pip />
      <Show when={!hasFocusVideo()} fallback={<MiniVideoTile />}>
        <Row align justify grow wrap>
          <TrackLoop tracks={audTracks}>{() => <ConnectedUser />}</TrackLoop>
        </Row>
      </Show>
      <VoiceCallCardActions size="xs" />
    </MiniCard>
  );
}

function ConnectedUser() {
  const participant = useEnsureParticipant();

  const isMuted = useIsMicMuted(participant);

  const isSpeaking = useIsSpeakingFast(participant);
  const user = useUser(participant.identity);

  return (
    <UserIcon speaking={isSpeaking()}>
      <Avatar
        size={24}
        src={user().avatar}
        fallback={user().username}
        shape="square"
      />
      <Show when={isMuted()}>
        <Symbol background="rgba(0,0,0,.5)">mic_off</Symbol>
      </Show>
    </UserIcon>
  );
}

function MiniVideoTile() {
  const voice = useVoice();

  return (
    <TrackLoop tracks={() => [voice.focusTrack()!]}>
      {() => <MiniVideo />}
    </TrackLoop>
  );
}

/**
 * While this is showing, `VoiceCallCardActiveRoom` -- specifically the
 * `ParticipantTile` for this same focused track -- can be mounted
 * underneath it too (see `VoiceCallCard.tsx`'s `pip` prop): it is now kept
 * mounted and just hidden with CSS across the pill/full-card switch, rather
 * than unmounted, so its own `<VideoTrack>` for this track can still be
 * attached at the same time as this one. That is not a bug to route around:
 * `useMediaTrackBySourceOrName` (the hook both `VideoTrack` instances use)
 * calls `track.attach(el)`/`track.detach(el)` with *its own* element each
 * time, and `livekit-client`'s `Track` tracks attached elements per-call in
 * a set rather than assuming exactly one -- so two independent `VideoTrack`s
 * attaching the same track is an explicitly supported, ordinary case, not
 * a shared/exclusive resource the two could fight over.
 */
function MiniVideo() {
  const track = useTrackRefContext();

  return (
    <VideoTrack
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        "border-radius": "inherit",
        "object-fit": "cover",
        overflow: "hidden",
      }}
      trackRef={track as TrackReference}
      manageSubscription={true}
    />
  );
}

const UserIcon = styled("div", {
  base: {
    display: "grid",
    width: "24px",
    height: "24px",
    color: "#fffb",
    overflow: "hidden",
    borderRadius: "var(--borderRadius-circle)",

    "& *": {
      gridArea: "1/1",
    },
  },
  variants: {
    speaking: {
      true: {
        "& svg": {
          outlineOffset: "1px",
          outline: "2px solid var(--md-sys-color-primary)",
          borderRadius: "var(--borderRadius-circle)",
        },
      },
    },
  },
});

const MiniCard = styled("div", {
  base: {
    userSelect: "none",

    pointerEvents: "all",
    width: "100%",
    height: "100%",

    display: "flex",
    alignItems: "center",
    flexDirection: "column",
    justifyContent: "end",

    gap: "var(--gap-md)",
    padding: "var(--gap-md)",

    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-secondary-container)",
  },
});
