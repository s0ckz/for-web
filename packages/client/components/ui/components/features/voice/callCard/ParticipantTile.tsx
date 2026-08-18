import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  TrackReference,
  useEnsureParticipant,
  useIsMuted,
  useTrackRefContext,
  VideoTrack,
} from "solid-livekit-components";

import type { RemoteTrackPublication } from "livekit-client";
import { Track } from "livekit-client";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUser } from "@revolt/markdown/users";
import { useIsMicMuted, useIsSpeakingFast, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Avatar } from "@revolt/ui/components/design";
import { Row } from "@revolt/ui/components/layout";
import { OverflowingText } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { VoiceStatefulUserIcons } from "../VoiceStatefulUserIcons";

import { ScreenShareStats } from "./ScreenShareStats";

type TileProps = {
  focus?: boolean;
};

/** How long the pointer must be still before fullscreen chrome fades out */
const IDLE_TIMEOUT = 2500;

/**
 * Individual participant tile
 */
export function ParticipantTile(props: TileProps) {
  const voice = useVoice();
  const state = useState();
  const participant = useEnsureParticipant();
  const track = useTrackRefContext();
  const user = useUser(participant.identity);

  let videoRef: HTMLVideoElement | undefined;
  let tileRef: HTMLDivElement | undefined;

  const [videoDims, setVideoDims] = createSignal<{
    height: number;
    width: number;
  }>({ height: 0, width: 0 });

  const [showStats, setShowStats] = createSignal(false);
  const [isFullscreen, setFullscreen] = createSignal(false);
  const [pointerIdle, setPointerIdle] = createSignal(false);

  const isMuted = useIsMicMuted(participant);

  const isScreenShareAudioMuted = useIsMuted({
    participant,
    source: Track.Source.ScreenShareAudio,
  });

  const isRemoteScreenShareMuted = useIsMuted({
    participant,
    source: Track.Source.ScreenShare,
  });

  const isScreenShareAudioUserMuted = () =>
    !user().user!.self && state.voice.getScreenShareMuted(user().user!.id)
      ? "by-user"
      : isScreenShareAudioMuted() || false;

  const isVideoMuted = useIsMuted({
    participant,
    source: Track.Source.Camera,
  });

  const isVideo = () => !isVideoMuted();
  const isScreenShare = () => track.source === Track.Source.ScreenShare;
  const isSpeaking = useIsSpeakingFast(participant);
  const isSelf = () => !!user().user?.self;

  /**
   * Screen shares are opt-in: joining a call with several people sharing should
   * not immediately pull down every stream. Your own share is always shown.
   */
  const isWatching = () =>
    !isScreenShare() ||
    isSelf() ||
    state.voice.getScreenShareWatching(participant.identity);

  /**
   * Drive the actual LiveKit subscription from that choice, so declining to
   * watch genuinely stops the server sending video rather than just hiding it.
   */
  createEffect(() => {
    if (!isScreenShare() || isSelf()) return;
    const publication = track.publication as RemoteTrackPublication | undefined;
    if (typeof publication?.setSubscribed !== "function") return;
    try {
      publication.setSubscribed(isWatching());
    } catch {
      /* publication went away */
    }
  });

  /**
   * Subscribing is asynchronous, so there is a window after clicking "watch"
   * where the publication exists but carries no media. Rendering the video
   * element then leaves an empty, collapsed tile -- so wait for the track.
   */
  const [trackReady, setTrackReady] = createSignal(false);

  createEffect(() => {
    if (!isScreenShare()) {
      setTrackReady(true);
      return;
    }
    if (!isWatching()) {
      setTrackReady(false);
      return;
    }

    const hasTrack = () => {
      const publication = track.publication as
        | RemoteTrackPublication
        | undefined;
      const ready = !!publication?.track;
      setTrackReady(ready);
      return ready;
    };

    if (hasTrack()) return;
    const poll = setInterval(() => {
      if (hasTrack()) clearInterval(poll);
    }, 200);
    onCleanup(() => clearInterval(poll));
  });

  /** Whether an actual video surface is on screen, as opposed to a placeholder */
  const showingVideo = () =>
    isVideo() || (isScreenShare() && isWatching() && trackReady());

  const startWatching = (e: MouseEvent) => {
    e.stopPropagation();
    state.voice.setScreenShareWatching(participant.identity, true);
  };

  const stopWatching = (e: MouseEvent) => {
    e.stopPropagation();
    setShowStats(false);
    state.voice.setScreenShareWatching(participant.identity, false);
  };

  // -- fullscreen ---------------------------------------------------------

  const onFullscreenChange = () =>
    setFullscreen(document.fullscreenElement === tileRef);

  document.addEventListener("fullscreenchange", onFullscreenChange);
  onCleanup(() =>
    document.removeEventListener("fullscreenchange", onFullscreenChange),
  );

  const toggleFullscreen = (e: MouseEvent) => {
    e.stopPropagation();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      tileRef?.requestFullscreen?.().catch(() => {});
    }
  };

  // Chrome only fades out while the pointer is still; any movement brings it
  // straight back.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const pokePointer = () => {
    if (!isFullscreen()) return;
    setPointerIdle(false);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => setPointerIdle(true), IDLE_TIMEOUT);
  };
  onCleanup(() => clearTimeout(idleTimer));

  const chromeHidden = () => isFullscreen() && pointerIdle();

  const getHeight = () => {
    if (isFullscreen()) return { width: "100%", height: "100%" };
    if (!props.focus || videoDims().height == 0) return {};
    // Calculate the aspect ratio
    const ratio = videoDims().width / videoDims().height;

    return ratio > 1
      ? { height: `min(var(--vc-w) / ${ratio}, 100%)` }
      : { height: "100%" };
  };

  return (
    <Show when={!isScreenShare() || !isRemoteScreenShareMuted()}>
      <div
        ref={tileRef}
        class={
          tile({
            speaking: !isScreenShare() && isSpeaking(),
            video: showingVideo(),
            fullscreen: voice.fullscreen(),
            ...props,
          }) + (isScreenShare() ? " vc_tile group" : " vc_tile")
        }
        onClick={() => voice.toggleFocus(track)}
        onMouseMove={pokePointer}
        use:floating={{
          // TODO: Conflicts with focusing, maybe only show if clicking name itself
          //   userCard: {
          //     user: user().user!,
          //     member: user().member,
          //   },
          contextMenu: () => (
            <UserContextMenu
              user={user().user!}
              member={user().member}
              inVoice={!isScreenShare()}
              isScreenshare={isScreenShare()}
            />
          ),
        }}
        style={{ ...getHeight(), cursor: chromeHidden() ? "none" : undefined }}
      >
        <Show
          when={isVideo() || isScreenShare()}
          fallback={
            <AvatarOnly>
              <Avatar
                src={user().avatar}
                fallback={user().username}
                size={48}
                interactive={false}
              />
            </AvatarOnly>
          }
        >
          <Show
            when={isWatching()}
            fallback={
              <NotWatching onClick={startWatching}>
                <Symbol size={32}>screen_share</Symbol>
                <NotWatchingTitle>
                  {user().username} is sharing their screen
                </NotWatchingTitle>
                <WatchButton>Watch stream</WatchButton>
              </NotWatching>
            }
          >
            <Show when={!trackReady()}>
              <Connecting>
                <Symbol size={28}>hourglass_top</Symbol>
                <NotWatchingTitle>Connecting…</NotWatchingTitle>
              </Connecting>
            </Show>
            <VideoTrack
              style={{
                "grid-area": "1/1",
                "object-fit": "contain",
                width: "100%",
                height: "100%",
                overflow: "hidden",
              }}
              trackRef={track as TrackReference}
              // We drive setSubscribed ourselves from the watch choice above;
              // letting VideoTrack manage it unsubscribes 3s after the element
              // is hidden and then fights us over it.
              manageSubscription={false}
              ref={videoRef}
              on:resize={() => {
                setVideoDims({
                  height: videoRef?.videoHeight || 0,
                  width: videoRef?.videoWidth || 0,
                });
              }}
            />
          </Show>
        </Show>

        <Show when={isScreenShare() && isWatching() && showStats()}>
          <ScreenShareStats
            trackRef={track as TrackReference}
            username={user().username}
            onClose={() => setShowStats(false)}
          />
        </Show>

        <Show when={isScreenShare() && isWatching() && !chromeHidden()}>
          <Controls onClick={(e) => e.stopPropagation()}>
            <ControlButton
              title="Statistics"
              onClick={(e) => {
                e.stopPropagation();
                setShowStats((v) => !v);
              }}
            >
              <Symbol size={18}>analytics</Symbol>
            </ControlButton>
            <Show when={!isSelf()}>
              <ControlButton title="Stop watching" onClick={stopWatching}>
                <Symbol size={18}>visibility_off</Symbol>
              </ControlButton>
            </Show>
            <ControlButton
              title={isFullscreen() ? "Exit fullscreen" : "Fullscreen"}
              onClick={toggleFullscreen}
            >
              <Symbol size={18}>
                {isFullscreen() ? "fullscreen_exit" : "fullscreen"}
              </Symbol>
            </ControlButton>
          </Controls>
        </Show>

        <Show when={!chromeHidden()}>
          <Overlay showOnHover={isScreenShare()}>
            <OverlayInner>
              <OverflowingText>{user().username}</OverflowingText>
              <Row gap="md">
                {isScreenShare() ? (
                  <Show when={isScreenShareAudioUserMuted()}>
                    <Symbol
                      size={18}
                      color={
                        isScreenShareAudioUserMuted() === "by-user"
                          ? "var(--md-sys-color-error)"
                          : undefined
                      }
                    >
                      no_sound
                    </Symbol>
                  </Show>
                ) : (
                  <VoiceStatefulUserIcons
                    userId={participant.identity}
                    muted={isMuted()}
                    camera={isVideo()}
                  />
                )}
              </Row>
            </OverlayInner>
          </Overlay>
        </Show>
      </div>
    </Show>
  );
}

export const tile = cva({
  base: {
    display: "grid",
    aspectRatio: "16/9",
    transition: "all .3s ease, width 0s, height 0s",
    borderRadius: "var(--borderRadius-lg)",
    width: "var(--vc-tile-width)",
    maxWidth: "calc(var(--vc-h) * 16 / 9)",
    cursor: "pointer",

    color: "var(--md-sys-color-on-surface)",
    background: "#0002",

    overflow: "hidden",
    outlineWidth: "3px",
    outlineStyle: "solid",
    outlineOffset: "-3px",
    outlineColor: "transparent",

    // Fullscreen must fill the screen rather than keep the grid sizing.
    "&:fullscreen": {
      width: "100%",
      height: "100%",
      maxWidth: "none",
      maxHeight: "none",
      aspectRatio: "auto",
      borderRadius: 0,
      background: "#000",
    },
  },
  variants: {
    speaking: {
      true: {
        outlineColor: "var(--md-sys-color-primary)",
      },
    },
    focus: {
      true: {
        width: "auto",
        maxWidth: "none",
      },
    },
    video: {
      true: {},
    },
    fullscreen: {
      true: {
        minWidth: "20%",
      },
    },
  },
  compoundVariants: [
    {
      video: [false],
      focus: [true],
      css: {
        height: "100%",
        maxHeight: "calc(var(--vc-w) * 9 / 16)",
      },
    },
    {
      video: [true],
      focus: [true],
      css: {
        aspectRatio: "auto",
      },
    },
  ],
});

const AvatarOnly = styled("div", {
  base: {
    gridArea: "1/1",
    display: "grid",
    placeItems: "center",
    overflow: "hidden",

    // TODO: Refactor the avatar component to be reactive later.
    "& > *": {
      width: "auto !important",
      height: "30% !important",
      minHeight: "48px",
    },
  },
});

const NotWatching = styled("div", {
  base: {
    gridArea: "1/1",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-sm)",
    padding: "var(--gap-lg)",
    textAlign: "center",
    background: "#0003",
    cursor: "pointer",
    zIndex: 3,
    pointerEvents: "auto",
  },
});

const NotWatchingTitle = styled("div", {
  base: {
    fontSize: "0.8rem",
    opacity: 0.75,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%",
  },
});

const Connecting = styled("div", {
  base: {
    gridArea: "1/1",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-sm)",
    background: "#0004",
    zIndex: 2,
  },
});

const WatchButton = styled("div", {
  base: {
    marginTop: "var(--gap-sm)",
    padding: "var(--gap-sm) var(--gap-lg)",
    borderRadius: "var(--borderRadius-full, 999px)",
    background: "var(--md-sys-color-primary)",
    color: "var(--md-sys-color-on-primary)",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
});

const Controls = styled("div", {
  base: {
    gridArea: "1/1",
    alignSelf: "start",
    justifySelf: "end",
    margin: "var(--gap-md)",
    zIndex: 9,

    display: "flex",
    gap: "var(--gap-sm)",
    pointerEvents: "auto",

    opacity: 0,
    transition: "var(--transitions-fast) opacity",
    _groupHover: { opacity: 1 },
  },
});

const ControlButton = styled("button", {
  base: {
    all: "unset",
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
    width: "28px",
    height: "28px",
    borderRadius: "var(--borderRadius-md)",
    background: "#000000aa",
    color: "#fff",
    _hover: { background: "#000000dd" },
  },
});

const Overlay = styled("div", {
  base: {
    minWidth: 0,
    gridArea: "1/1",

    // Informational only. Without this it covers the whole tile and steals
    // clicks from the watch button and the controls beneath it.
    pointerEvents: "none",

    padding: "var(--gap-md) var(--gap-lg)",

    opacity: 1,
    display: "flex",
    alignItems: "end",
    flexDirection: "row",

    transition: "var(--transitions-fast) all",
    transitionTimingFunction: "ease",
  },
  variants: {
    showOnHover: {
      true: {
        opacity: 0,

        _groupHover: {
          opacity: 1,
        },
      },
      false: {
        opacity: 1,
      },
    },
  },
  defaultVariants: {
    showOnHover: false,
  },
});

const OverlayInner = styled("div", {
  base: {
    minWidth: 0,

    display: "flex",
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",

    _first: {
      flexGrow: 1,
    },
  },
});
