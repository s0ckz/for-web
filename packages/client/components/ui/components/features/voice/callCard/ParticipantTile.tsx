import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  TrackReference,
  useEnsureParticipant,
  useIsMuted,
  useMediaTrackBySourceOrName,
  useTrackRefContext,
  VideoTrack,
} from "solid-livekit-components";

import { RemoteTrackPublication, Track } from "livekit-client";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUser } from "@revolt/markdown/users";
import { useIsMicMuted, useIsSpeakingFast, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Avatar } from "@revolt/ui/components/design";
import { fullscreenElement } from "@revolt/ui/components/floating";
import { Row } from "@revolt/ui/components/layout";
import { OverflowingText } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { VoiceStatefulUserIcons } from "../VoiceStatefulUserIcons";

import {
  createScreenShareSample,
  ScreenShareBadge,
  ScreenShareStats,
} from "./ScreenShareStats";

/** How long the pointer must be still before fullscreen chrome fades out */
const IDLE_TIMEOUT = 2500;

/**
 * Badge + (when open) full stats panel for the sharer's own screen share,
 * both fed by one sampler -- see `createScreenShareSample`'s doc comment in
 * ScreenShareStats.tsx for why the panel takes it as a `sample` prop rather
 * than polling `getStats()` itself here.
 *
 * A dedicated component rather than inlining this in `ParticipantTile`'s
 * `<Show>`: `createScreenShareSample` starts an interval that must run for
 * exactly as long as this is mounted, and a component's setup body is what
 * runs once per mount in Solid -- an inline expression inside `<Show>`
 * children has no such guarantee.
 */
function OwnScreenShareOverlay(props: {
  trackRef: TrackReference;
  username: string;
  open: boolean;
  onCloseStats: () => void;
}) {
  const sample = createScreenShareSample(() => props.trackRef);

  return (
    <>
      {/*
       * Not role="status": unlike ReacquiringNotice below (a rare state
       * transition), this badge's text changes on every 1s sample tick --
       * making it a live region would have a screen reader announce a new
       * fps reading once a second. It stays a plain visual overlay, same as
       * the "stats for nerds" panel it summarises.
       */}
      <ScreenShareBadge sample={sample} />
      <Show when={props.open}>
        <ScreenShareStats
          trackRef={props.trackRef}
          username={props.username}
          onClose={props.onCloseStats}
          sample={sample}
        />
      </Show>
    </>
  );
}

/**
 * Individual participant tile.
 *
 * Takes no props: `VoiceCallCardActiveRoom` renders every tile -- focused or
 * not -- through one `TrackLoop`, so this reads its own focus state
 * (`isFocused` below) from `voice.isFocus(track)` instead of a `focus` prop.
 * That is what lets focus move between tiles without unmounting either one --
 * a prop can only change on an element that is already there; the whole
 * reason this used to need two separate `TrackLoop`s (and remounted a tile on
 * every focus change) was that a `focus` prop had nowhere to be read from
 * until the element existed.
 */
export function ParticipantTile() {
  const voice = useVoice();
  const state = useState();
  const participant = useEnsureParticipant();
  const track = useTrackRefContext();
  const user = useUser(participant.identity);

  /** Whether this is the currently-focused (pinned) tile. */
  const isFocused = () => voice.isFocus(track);

  let videoRef: HTMLVideoElement | undefined;
  let tileRef: HTMLDivElement | undefined;

  const [videoDims, setVideoDims] = createSignal<{
    height: number;
    width: number;
  }>({ height: 0, width: 0 });

  const [showStats, setShowStats] = createSignal(false);
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

  // The publication (and, below, the track) read reactively, rather than
  // `track.publication`'s one-time snapshot from context: a
  // subscribe/unsubscribe cycle or a reconnect can hand the participant a
  // new `TrackPublication` instance for the same source, and the effects
  // below need to see that to drive (and clean up after) the *current* one.
  const { publication: trackPublication, track: mediaTrack } =
    useMediaTrackBySourceOrName({
      participant,
      source: track.source,
    });

  /**
   * Drive the actual LiveKit subscription from that choice, so declining to
   * watch a screen share genuinely stops the server sending video rather than
   * just hiding it. Cameras have no equivalent "watch" concept -- there is
   * nothing to opt out of -- so isWatching() always evaluates true for them
   * and they subscribe unconditionally as soon as their tile renders.
   *
   * The room connects with autoSubscribe: false, so every remote track needs
   * an explicit setSubscribed call somewhere, and this effect is it for both
   * kinds: VideoTrack's own subscription management is turned off below.
   *
   * Unmounting this tile -- a channel change, or simply dropping out of
   * `gridTracks()` (see `VoiceCallCardActiveRoom.tsx`) -- must not leave a
   * share subscribed and decoding with nothing on screen watching it, so the
   * cleanup below un-desires it again -- unless it was never this effect's
   * to manage (self) or something else already dropped it. A PiP/float swap
   * no longer unmounts this tile at all (`VoiceCallCardActiveRoom` stays
   * mounted underneath the floating pill), so that is one fewer case this
   * cleanup needs to cover, not an additional one.
   */
  createEffect(() => {
    if (isSelf()) return;
    const publication = trackPublication() as
      | RemoteTrackPublication
      | undefined;
    if (typeof publication?.setSubscribed !== "function") return;
    try {
      publication.setSubscribed(isWatching());
    } catch {
      /* publication went away */
    }
    onCleanup(() => {
      if (!isSelf() && publication?.isDesired) publication.setSubscribed(false);
    });
  });

  /**
   * Ask the SFU for a lower temporal layer on watched vp9 screen shares that
   * are in the strip (this tile is not the focused one) -- pure decode-load
   * relief, not a pause: `setVideoFPS` only ever writes the `fps` field of an
   * `UpdateTrackSettings` sent for an already-subscribed track (see
   * `RemoteTrackPublication.emitTrackUpdate`/`isManualOperationAllowed` in
   * livekit-client), it never touches `disabled`/`isEnabled`. The strip/focus
   * split reuses the existing focus concept (`isFocused()`, above -- reading
   * `voice.isFocus(track)` directly rather than a `focus` prop, since every
   * tile is now rendered through the same `TrackLoop` regardless of focus;
   * see this component's own doc comment) -- no viewport or visibility
   * detection.
   *
   * This must stay reactive to `isFocused()` specifically, not read it once:
   * unlike the old `focus` prop -- which could only ever be `true` on a tile
   * `FocusedParticipant` chose to mount and never changed again for that
   * tile's lifetime, since a *different* focused participant meant a
   * *different* tile being mounted elsewhere -- `isFocused()` can now flip on
   * an already-mounted tile (that is the whole point of the single-`TrackLoop`
   * change), and this effect has to re-fire and re-ask the SFU when it does,
   * not just capture whatever it was worth when the tile first appeared.
   *
   * vp9-only: h264/h265 screen shares (the common case -- see
   * `screenSharePublishOptions` in `rtc/state.tsx`) are unaffected, because
   * LiveKit's SFU only has independent temporal sub-layers to drop frames
   * from when the publisher used VP9's SVC encoding; h264/h265 here are
   * single-layer (`screenSharePublishOptions` disables simulcast for them),
   * so there is nothing for a subscriber-side fps ask to select between.
   *
   * `setVideoFPS(0)` on focus is the reset: `RemoteTrackPublication.fps`
   * starts `undefined` and only this effect ever changes it, and the `fps`
   * field on `UpdateTrackSettings` is a plain (non-`optional`) proto3 uint32
   * -- implicit presence means a `0` is not put on the wire, so `fps: 0`
   * serializes identically to `fps` never having been set, i.e. genuinely
   * unlimited rather than "capped at some large number".
   *
   * Gated on `isWatching()` (mirrors the subscription effect above) so this
   * doesn't fire while `isManualOperationAllowed()` would reject it anyway
   * (unsubscribed) and log a warning.
   */
  createEffect(() => {
    if (!isScreenShare()) return;
    const publication = trackPublication();
    if (!(publication instanceof RemoteTrackPublication)) return;
    if (publication.mimeType?.toLowerCase() !== "video/vp9") return;
    if (!isWatching()) return;
    try {
      publication.setVideoFPS(isFocused() ? 0 : 15);
    } catch {
      /* publication went away */
    }
  });

  /**
   * Subscribing is asynchronous, so there is a window -- after clicking
   * "watch" for a screen share, or immediately on mount for a camera, since
   * that one subscribes unconditionally -- where the publication exists but
   * carries no media yet. Rendering the video element then leaves an empty,
   * collapsed tile, so wait for the actual track before treating it as ready;
   * until then the tile shows its "Connecting…" placeholder instead.
   *
   * `mediaTrack` (from the same `useMediaTrackBySourceOrName` call as
   * `trackPublication` above) is already a reactive read of the current
   * publication's track, kept in sync by that hook's own `trackObserver`
   * subscription -- so this just needs to read it, not poll for it. This
   * used to re-check on a 200ms `setInterval` instead, because the hook's
   * effects did not reliably re-track their dependencies; that has since
   * been fixed (see the hook's own history), so the poll was pure waste on
   * top of a value already updating itself.
   */
  const trackReady = () => isWatching() && !!mediaTrack();

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

  // Reads the shared `fullscreenElement()` signal (`portalMount.ts`) instead
  // of attaching a per-tile `document` `fullscreenchange` listener -- one
  // document-level listener for the whole app already tracks this centrally,
  // so N tiles no longer each need their own. `tileRef` is a plain (non-
  // reactive) local, same as `toggleFullscreen` below already reads it: by
  // the time this is ever called, the tile has mounted and `tileRef` is set.
  const isFullscreen = () => fullscreenElement() === tileRef;

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

  /**
   * Inline height for the focused tile, on top of the `focus` cva variant
   * below (which positions it as an overlay spanning `Call`'s full width,
   * from its top down to `var(--vc-strip-h)`).
   *
   * `calc(100% - var(--vc-strip-h, 0px))` -- rather than a plain `100%` -- is
   * the one adjustment this needed for that overlay: this tile's containing
   * block is now `Call` itself (see the `focus` variant), which is the whole
   * card, not just the area above the strip the way the old `FocusBox`
   * wrapper was. Subtracting `--vc-strip-h` (set by `VoiceCallCardActiveRoom`
   * to the same value `Grid` sizes the strip to) recovers that same "height
   * available above the strip" reference.
   *
   * Always returned as an inline style while focused, including the
   * no-video-yet case that used to be left to the `{ video: false, focus:
   * true }` compound variant's own `height: 100%` -- `Grid`'s `focus: true`
   * variant also puts `height: 100%` on *every* `.vc_tile` descendant
   * (sizing ordinary strip tiles against the strip's own height, which is
   * correct for them), and a stylesheet rule targeting `.vc_tile` beats a
   * single utility class on specificity alone regardless of source order.
   * For every other tile that is "100% of Grid" (correct); for this
   * absolutely-positioned one it would resolve against `Call` instead
   * (`position: absolute` changes what "100%" means) and ignore the strip
   * reservation entirely. Only an inline style -- which always outranks any
   * stylesheet rule -- reliably wins that fight.
   */
  const getHeight = () => {
    if (isFullscreen()) return { width: "100%", height: "100%" };
    if (!isFocused()) return {};

    const available = "calc(100% - var(--vc-strip-h, 0px))";
    if (videoDims().height == 0) return { height: available };

    const ratio = videoDims().width / videoDims().height;
    return ratio > 1
      ? { height: `min(var(--vc-w) / ${ratio}, ${available})` }
      : { height: available };
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
            focus: isFocused(),
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
              // We drive setSubscribed ourselves for both cameras and screen
              // shares (see the effect above); letting VideoTrack manage it
              // unsubscribes 3s after the element is hidden and then fights
              // us over it.
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

        <Show when={isScreenShare() && isSelf()}>
          <OwnScreenShareOverlay
            trackRef={track as TrackReference}
            username={user().username}
            open={showStats()}
            onCloseStats={() => setShowStats(false)}
          />
        </Show>

        <Show
          when={isScreenShare() && isWatching() && showStats() && !isSelf()}
        >
          <ScreenShareStats
            trackRef={track as TrackReference}
            username={user().username}
            onClose={() => setShowStats(false)}
          />
        </Show>

        {/*
         * Recovery giving up is not the same as the share ending -- the
         * capture is just parked and retrying (see Voice#scheduleReacquireRetry).
         * Only shown on the sharer's own tile: everyone else just keeps
         * seeing the frozen last frame, which is the point.
         *
         * `role="status"` (implicit `aria-live="polite"` +
         * `aria-atomic="true"`) so a screen reader actually announces this
         * to the sharer instead of it being silently visual-only -- same
         * non-interrupting choice ScreenShareSettings.tsx makes for its
         * "caution" notice, since a share that is quietly retrying in the
         * background is not worth an assertive `role="alert"` interruption.
         */}
        <Show
          when={
            isScreenShare() &&
            isSelf() &&
            voice.screenShareState() === "reacquiring"
          }
        >
          <ReacquiringNotice role="status">
            <Symbol size={16}>sync_problem</Symbol>
            Trying to reconnect your screen share…
          </ReacquiringNotice>
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
    // Only the outline (the speaking ring) actually needs to animate.
    // `transition: all` was making every property change on this element --
    // including layout-affecting ones like `width`/`height` on focus/strip
    // changes, and anything the browser recomputes on a video frame update --
    // pay for a transition it never asked for, once per tile per frame.
    transition: "outline-color .3s ease, width 0s, height 0s",
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
    // The focused tile is rendered by the same `TrackLoop` as the strip (see
    // `VoiceCallCardActiveRoom.tsx`'s `visibleTracks`), so it needs to pull
    // itself out of the strip's normal flex flow and lay itself over the
    // whole card instead of relying on a separate wrapper element to do
    // that -- hence `position: absolute` here rather than in a parent.
    // `Call` (the nearest positioned ancestor) is where `top`/`left`/`right`
    // resolve against; the actual height comes from `getHeight()`'s inline
    // style (aspect-ratio-aware) or, when that has nothing to say yet, the
    // `{ video: false, focus: true }` compound variant below.
    focus: {
      true: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
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
      // `height` itself is set inline by `getHeight()` (see its doc comment
      // for why that has to be inline rather than a class here) -- this
      // compound variant only still needs to contribute `maxHeight`, which
      // `Grid`'s own `.vc_tile` rule never touches.
      video: [false],
      focus: [true],
      css: {
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

const ReacquiringNotice = styled("div", {
  base: {
    gridArea: "1/1",
    alignSelf: "start",
    justifySelf: "start",
    margin: "var(--gap-md)",
    zIndex: 9,

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
    padding: "var(--gap-xs) var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    background: "#000000aa",
    color: "#fff",
    fontSize: "0.75rem",

    pointerEvents: "none",
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
