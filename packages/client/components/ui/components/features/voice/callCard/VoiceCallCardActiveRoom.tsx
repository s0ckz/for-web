import { useLingui } from "@lingui/solid/macro";
import { createResizeObserver } from "@solid-primitives/resize-observer";
import {
  createEffect,
  createMemo,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { TrackLoop } from "solid-livekit-components";
import { styled } from "styled-system/jsx";

import { InRoom, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";
import { scrollableStyles } from "@revolt/ui/directives";

import { ParticipantTile, tile } from "./ParticipantTile";
import { VoiceCallCardActions } from "./VoiceCallCardActions";
import { VoiceCallCardStatus } from "./VoiceCallCardStatus";

/**
 * Call card (active)
 */
export function VoiceCallCardActiveRoom() {
  return (
    <View>
      <Participants />
      <VoiceCallControls>
        <VoiceCallControlHolder right>
          <VoiceHideChat />
          <VoiceShowNonVideoParticipants />
          <VoiceCallFullscreen />
        </VoiceCallControlHolder>
        <VoiceCallCardActions size="sm" />
        <VoiceCallControlHolder left overflow>
          <VoiceCallCardStatus />
        </VoiceCallControlHolder>
      </VoiceCallControls>
    </View>
  );
}

function VoiceCallFullscreen() {
  const voice = useVoice();
  return (
    <IconButton
      size="sm"
      variant={"standard"}
      onPress={() => voice.toggleFullscreen()}
    >
      <Show when={voice.fullscreen()} fallback={<Symbol>fullscreen</Symbol>}>
        <Symbol>fullscreen_exit</Symbol>
      </Show>
    </IconButton>
  );
}

/**
 * Hide the text chat so the call card fills the whole channel area.
 *
 * Not the same as fullscreen: the rest of the app stays put, this only gives
 * the call the space the message list was using.
 */
function VoiceHideChat() {
  const state = useState();
  const { t } = useLingui();

  const hidden = () => state.voice.hideChatInCall;

  return (
    <IconButton
      size="sm"
      variant={"standard"}
      onPress={() => (state.voice.hideChatInCall = !hidden())}
      use:floating={{
        tooltip: {
          placement: "top",
          content: hidden() ? t`Show chat` : t`Hide chat`,
        },
      }}
    >
      <Show when={hidden()} fallback={<Symbol>speaker_notes_off</Symbol>}>
        <Symbol>chat</Symbol>
      </Show>
    </IconButton>
  );
}

/**
 * Toggle whether participants with no camera or screen share get a tile.
 *
 * With a few people idling in a call, their avatar tiles squeeze whoever is
 * actually sharing something down to a thumbnail.
 */
function VoiceShowNonVideoParticipants() {
  const state = useState();
  const { t } = useLingui();

  const shown = () => state.voice.showNonVideoParticipants;

  return (
    <IconButton
      size="sm"
      variant={"standard"}
      onPress={() => (state.voice.showNonVideoParticipants = !shown())}
      use:floating={{
        tooltip: {
          placement: "top",
          content: shown()
            ? t`Hide non-video participants`
            : t`Show non-video participants`,
        },
      }}
    >
      <Show when={shown()} fallback={<Symbol>videocam_off</Symbol>}>
        <Symbol>videocam</Symbol>
      </Show>
    </IconButton>
  );
}

const TILE_MIN_WIDTH = "250px",
  TILE_MIN_FOCUS_HEIGHT = "100px";

/**
 * How long a pinned stream may be missing before the pin is given up.
 *
 * Windows ends a screen capture when the shared window is destroyed or
 * minimised -- alt-tabbing out of a fullscreen game does both -- so the track
 * is unpublished and a new one takes its place a few seconds later. The pin is
 * keyed by participant rather than by track, so simply not letting go of it
 * means the stream drops back into place by itself and nobody has to click the
 * tile again.
 */
const FOCUS_GRACE_MS = 60_000;

/**
 * Show a grid of participants
 */
function Participants() {
  const voice = useVoice();
  const state = useState();
  const { t } = useLingui();

  // Modify this value to get test tracks
  const testTrackCount = 0;

  let callRef: HTMLDivElement | undefined;

  /**
   * Whether something is focused *and* actually on screen right now.
   *
   * While a pinned stream is away the pin is still remembered, but the layout
   * has to behave as though nothing were focused -- otherwise the card sits
   * there with an empty focus area above a strip.
   */
  const focused = createMemo(() => !!voice.focusTrack());

  /**
   * Everything that is not currently focused, optionally narrowed to tiles
   * that actually carry video.
   *
   * A camera placeholder has no publication at all, a camera that is off has
   * one that is muted, and a screen share always counts as video. If the
   * filter would empty the grid entirely, keep everyone: an empty call card is
   * worse than a few avatars.
   */
  const gridTracks = createMemo(() => {
    const tracks = voice.vidTracks().filter((t) => !voice.isFocus(t));
    if (state.voice.showNonVideoParticipants) return tracks;

    const withVideo = tracks.filter(
      (t) => t.publication && !t.publication.isMuted,
    );

    // While something is focused the grid is just the strip underneath it, and
    // an empty strip is exactly what was asked for. It is only the unfocused
    // grid -- the whole card -- that must not end up blank.
    if (focused()) return withVideo;
    return withVideo.length ? withVideo : tracks;
  });

  const tileWidth = () => {
    const vidWidth = Math.round(100 / (gridTracks().length + testTrackCount));
    return `max(${TILE_MIN_WIDTH}, ${vidWidth}% - var(--gap-md))`;
  };

  // Give a pinned stream that disappears a chance to come back before letting
  // go of it; see FOCUS_GRACE_MS.
  let focusGrace: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const pinnedButMissing = !!voice.focusId() && !voice.focusTrack();

    clearTimeout(focusGrace);
    if (!pinnedButMissing) return;

    focusGrace = setTimeout(() => {
      // Still nothing after the grace period, so it is not coming back.
      if (!voice.focusTrack()) voice.toggleFocus();
    }, FOCUS_GRACE_MS);
  });

  onCleanup(() => clearTimeout(focusGrace));

  onMount(() => {
    createResizeObserver(callRef, ({ width, height }, el) => {
      if (el === callRef) {
        el.style.setProperty("--vc-w", `${width}px`);
        el.style.setProperty("--vc-h", `${height}px`);
      }
    });
  });

  return (
    <Call ref={callRef} class={focused() ? "" : scrollableStyles()}>
      <InRoom>
        <FocusedParticipant />
        <Show when={focused()}>
          <ShowBarButtonHolder>
            <div style={{ "margin-bottom": "10px" }}>
              <IconButton
                size="xs"
                variant={"tonal"}
                onPress={() => voice.toggleShowBar()}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: voice.showBar() ? t`Hide Others` : t`Show Others`,
                  },
                }}
              >
                <Show
                  when={voice.showBar()}
                  fallback={<Symbol>keyboard_arrow_up</Symbol>}
                >
                  <Symbol>keyboard_arrow_down</Symbol>
                </Show>
              </IconButton>
            </div>
          </ShowBarButtonHolder>
        </Show>
        <Grid
          focus={focused()}
          show={voice.showBar()}
          class={focused() ? scrollableStyles({ direction: "x" }) : ""}
          style={{ "--vc-tile-width": tileWidth() }}
        >
          <TrackLoop tracks={gridTracks}>{() => <ParticipantTile />}</TrackLoop>
          <For each={Array(testTrackCount)}>
            {() => (
              <div
                class={tile({ fullscreen: voice.fullscreen() }) + " vc_tile"}
              />
            )}
          </For>
        </Grid>
      </InRoom>
    </Call>
  );
}

function FocusedParticipant() {
  const voice = useVoice();

  return (
    <Show when={voice.focusTrack()}>
      <TrackLoop tracks={() => [voice.focusTrack()!]}>
        {() => (
          <FocusBox>
            <ParticipantTile focus />
          </FocusBox>
        )}
      </TrackLoop>
    </Show>
  );
}

const View = styled("div", {
  base: {
    minHeight: 0,
    height: "100%",
    width: "100%",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
  },
});

const VoiceCallControls = styled("div", {
  base: {
    display: "flex",
    flexShrink: "0",
    overflow: "hidden",
    flexDirection: "row-reverse",
  },
});

const VoiceCallControlHolder = styled("div", {
  base: {
    display: "flex",
    flex: "1",
    alignSelf: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
  },
  variants: {
    right: {
      true: {
        justifyContent: "flex-end",
      },
    },
    empty: {
      true: {
        gap: "0px",
        padding: "0px",
      },
    },
    left: {
      true: {
        justifyContent: "flex-start",
      },
    },
    overflow: {
      true: {
        overflow: "hidden",
      },
    },
  },
});

const ShowBarButtonHolder = styled("div", {
  base: {
    height: "0px",
    alignSelf: "center",
    overflow: "visible",
    display: "flex",
    flexDirection: "column-reverse",
  },
});

const Call = styled("div", {
  base: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    flexGrow: 1,
    minHeight: 0,
  },
});

const Grid = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "safe center",
    alignContent: "safe center",
    minHeight: "100%",
    gap: "var(--gap-md)",
  },

  variants: {
    focus: {
      true: {
        flexDirection: "column",
        height: `max(20%, ${TILE_MIN_FOCUS_HEIGHT})`,
        minHeight: 0,
        transition: "height .3s ease",

        "& .vc_tile": {
          width: "auto",
          height: "100%",
        },
      },
    },
    show: {
      false: {
        height: 0,
      },
    },
  },
});

const FocusBox = styled("div", {
  base: {
    height: 0,
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    margin: "0 auto",
  },
});
