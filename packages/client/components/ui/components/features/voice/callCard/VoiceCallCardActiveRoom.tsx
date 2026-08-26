import { useLingui } from "@lingui/solid/macro";
import { createResizeObserver } from "@solid-primitives/resize-observer";
import {
  createEffect,
  createMemo,
  createSignal,
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

const TILE_MIN_WIDTH = 250,
  TILE_MIN_FOCUS_HEIGHT = "100px",
  TILE_ASPECT = 16 / 9,
  /** Mirrors --gap-md, the gap the grid puts between tiles. */
  GRID_GAP = 8,
  /** How much larger a layout with more rows must be to be worth stacking. */
  ROW_PENALTY = 1.1;

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

  /** Size of the grid area, kept up to date by the resize observer below. */
  const [box, setBox] = createSignal({ w: 0, h: 0 });

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

  /**
   * Column count that makes the tiles as large as the card allows.
   *
   * Every tile is 16/9, so a candidate column count is worth exactly the tile
   * width it yields: a column has to fit across the width, and the row it
   * belongs to has to fit down the height, whichever binds first. Handing out
   * 1/N of the width instead -- which is what this used to do -- always packs
   * everyone onto one row, so four people on a tall card got quarter-width
   * tiles and three quarters of the card stayed empty.
   *
   * Near-ties go to the layout with fewer rows: two people side by side reads
   * better than two people stacked even where stacking is a few percent
   * larger, and 6 belongs in 3x2 rather than 2x3. An exact tie goes to the
   * wider layout, because when the height is what binds, the tiles end up
   * narrower than their column and flex would pack that many per row anyway.
   */
  const columns = createMemo(() => {
    const n = gridTracks().length + testTrackCount;
    const { w, h } = box();
    if (n < 2 || !w || !h) return Math.max(1, n);

    const options: { c: number; rows: number; size: number }[] = [];
    for (let c = 1; c <= n; c++) {
      const rows = Math.ceil(n / c);
      options.push({
        c,
        rows,
        size: Math.min(
          (w - (c - 1) * GRID_GAP) / c,
          ((h - (rows - 1) * GRID_GAP) / rows) * TILE_ASPECT,
        ),
      });
    }

    const largest = Math.max(...options.map((o) => o.size));
    return options
      .filter((o) => o.size >= largest / ROW_PENALTY)
      .sort(
        (a, b) =>
          a.rows - b.rows ||
          Math.round(b.size) - Math.round(a.size) ||
          b.c - a.c,
      )[0].c;
  });

  /**
   * Width of a single tile, which through `aspect-ratio` sets its height too.
   *
   * The 1px comes off because `cols * ((100% - gaps) / cols)` can land a hair
   * over 100% once the browser snaps each flex item to 1/64px, which wraps a
   * row early and drops the last tile out of view. Clamping by row height as
   * well keeps a full grid inside the card; the `max()` floor is what is left
   * over from the old behaviour, and still lets a crowded small card wrap and
   * scroll rather than shrink tiles to nothing. Until the observer has
   * measured the card --vc-h is missing, and the 100vh fallback simply leaves
   * the column width binding for that first frame.
   */
  const tileWidth = () => {
    const cols = columns();
    const rows = Math.max(
      1,
      Math.ceil((gridTracks().length + testTrackCount) / cols),
    );
    const colGaps = (cols - 1) * GRID_GAP,
      rowGaps = (rows - 1) * GRID_GAP;

    return `max(${TILE_MIN_WIDTH}px, calc(min((100% - ${colGaps}px) / ${cols}, (var(--vc-h, 100vh) - ${rowGaps}px) / ${rows} * 16 / 9) - 1px))`;
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
    // This observer writes to the element it is observing, so it can drive
    // itself: --vc-h sizes the tiles, the tiles change the content height, the
    // card's own scrollbar appears or disappears, and its box changes again.
    // Sub-pixel jitter alone was enough to keep that going -- the log filled
    // with "ResizeObserver loop completed with undelivered notifications" and
    // the renderer sat on a full core for the whole call. Round to whole
    // pixels and write only on a real change.
    let lastW = -1;
    let lastH = -1;
    createResizeObserver(callRef, ({ width, height }, el) => {
      if (el !== callRef) return;

      const w = Math.round(width);
      const h = Math.round(height);
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;

      el.style.setProperty("--vc-w", `${w}px`);
      el.style.setProperty("--vc-h", `${h}px`);
      setBox({ w, h });
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
