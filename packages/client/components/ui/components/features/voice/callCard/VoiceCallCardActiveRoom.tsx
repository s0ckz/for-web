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

import { focusOverlayContext, ParticipantTile, tile } from "./ParticipantTile";
import { VoiceCallCardActions } from "./VoiceCallCardActions";
import { VoiceCallCardStatus } from "./VoiceCallCardStatus";

/**
 * Call card (active)
 */
export function VoiceCallCardActiveRoom(props: { pip: boolean }) {
  return (
    <View>
      <Participants pip={props.pip} />
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
function Participants(props: { pip: boolean }) {
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
   * Everything that actually gets a tile: `gridTracks()` (the strip, or the
   * whole grid when nothing is focused) plus the focused track itself,
   * unconditionally -- a pinned stream stays visible even if its camera is
   * off and `showNonVideoParticipants` would otherwise have filtered it out,
   * same as before this was a single loop.
   *
   * This single list feeds one `TrackLoop` for both the focus tile and the
   * strip (see `Grid` below) instead of two separate ones. That is the whole
   * point: `gridTracks()` above already excludes whichever track is
   * currently focused, so as focus moves from one participant to another,
   * both of them stay members of *this* combined list the entire time --
   * only their position in it (and, correspondingly, `ParticipantTile`'s own
   * `voice.isFocus(track)` read) changes. Solid's keyed `<For>` underneath
   * `TrackLoop` reorders the existing DOM nodes for that, rather than
   * unmounting the old focus tile and mounting a fresh one -- which is
   * exactly the destroy/rebuild (and torn-down `<video>` element) this
   * refactor exists to stop. Placed first, matching where the old, separate
   * focus `TrackLoop` used to sit in the DOM/tab order.
   */
  const visibleTracks = createMemo(() => {
    const focusTrack = voice.focusTrack();
    return focusTrack ? [focusTrack, ...gridTracks()] : gridTracks();
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

  /**
   * Height reserved for the strip when something is focused, exposed as
   * `--vc-strip-h` on `Call` so the focused tile (an absolutely-positioned
   * overlay over the whole of `Call`, not a sibling of the strip anymore --
   * see `ParticipantTile.tsx`'s `focus` variant) knows how much room to leave
   * below it. Mirrors `Grid`'s own `focus`/`show` variants below exactly, so
   * the overlay's bottom edge always lines up with the strip's actual top
   * edge instead of drifting out of sync with it.
   */
  const stripHeight = () =>
    voice.showBar() ? `max(20%, ${TILE_MIN_FOCUS_HEIGHT})` : "0px";

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

      // `VoiceCallCard.tsx` keeps `Base` laid out (`visibility: hidden`,
      // not unmounted) while the floating PiP pill shows on top of it, for
      // exactly this observer to re-measure it on re-dock -- but `Float` is
      // a fixed 300x170 while floating, so measuring it *now* would write a
      // tiny --vc-h/box() and, through tileWidth()'s 250px floor, force
      // every tile down to one per row until the next real resize. Skip the
      // write and keep the last docked measurement; re-docking is itself a
      // real size change on this element, so the observer fires again with
      // the actual docked size as soon as it happens.
      if (props.pip) return;

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

  /**
   * Where `ParticipantTile` portals the currently-focused tile -- see
   * `focusOverlayContext`'s doc comment for why a plain ref, not a signal,
   * and why it has to be assigned before `Grid`'s `TrackLoop` below (it is
   * written first in the JSX that follows).
   */
  let overlayRef: HTMLDivElement | undefined;

  return (
    <focusOverlayContext.Provider value={() => overlayRef}>
      <Call
        ref={callRef}
        focus={focused()}
        class={focused() ? "" : scrollableStyles()}
        style={{ "--vc-strip-h": stripHeight() }}
      >
        <InRoom>
          <Show when={focused()}>
            <ShowBarButtonHolder>
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
            </ShowBarButtonHolder>
          </Show>
          <FocusOverlay ref={overlayRef!} />
          <Grid
            focus={focused()}
            show={voice.showBar()}
            class={focused() ? scrollableStyles({ direction: "x" }) : ""}
            style={{ "--vc-tile-width": tileWidth() }}
          >
            {/*
             * One loop for both the focus tile and the strip -- see
             * `visibleTracks` above for why -- rather than the two separate
             * `TrackLoop`s (one keyed to just the focused track, one to
             * `gridTracks()`) this used to be. `ParticipantTile` positions
             * itself via `voice.isFocus(track)` when it is the focused one
             * (see its `focus` variant, and `FocusOverlay` above for how it
             * escapes `Grid` while doing so), so nothing else here needs to
             * know which array position that is.
             */}
            <TrackLoop tracks={visibleTracks}>
              {() => <ParticipantTile />}
            </TrackLoop>
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
    </focusOverlayContext.Provider>
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

// Floats the "show/hide others" toggle just above the strip's top edge,
// centered. Positioned against `Call` (not a flex sibling between the old
// `FocusBox` and `Grid` anymore -- there is no `FocusBox`; see `Call`'s own
// doc comment) using the same `--vc-strip-h` the focused tile overlay sizes
// itself against, so the two always agree on where the strip actually
// starts. The `+ 10px` reproduces the old layout's gap between the button
// and the strip.
const ShowBarButtonHolder = styled("div", {
  base: {
    position: "absolute",
    left: "50%",
    bottom: "calc(var(--vc-strip-h, 0px) + 10px)",
    transform: "translateX(-50%)",
    zIndex: 9,
  },
});

/**
 * Positioning context for the focused tile's overlay (see `FocusOverlay` and
 * `ParticipantTile`'s `focus` variant) and for `ShowBarButtonHolder` above --
 * both position themselves against this element via `position: absolute`,
 * which is why this stays `position: relative` and why nothing between them
 * and this (`InRoom`, `FocusOverlay`, `Grid`) may introduce a positioning
 * context of its own.
 *
 * THIS INVARIANT HAS ALREADY BEEN BROKEN ONCE, by something that looks
 * nothing like a `position` rule: `Grid`'s `scrollableStyles({ direction:
 * "x" })` class (applied only while focused, for the strip's horizontal
 * scroll) carries `willChange: "transform"`
 * (`directives/scrollable.ts`), and `will-change: transform` makes an
 * element a containing block for its absolutely-positioned descendants --
 * same as `position: relative` would. Because the focused tile used to be a
 * plain descendant of `Grid` (rendered by the same `TrackLoop` as the strip,
 * just pulled out of flex flow via `position: absolute`), that silently
 * retargeted it onto `Grid` -- whose own box is deliberately small (just the
 * strip's height, `overflow-y: hidden`) -- instead of this element, and the
 * whole card appeared to lose its focused tile. Fixed by portaling the
 * focused tile out to `FocusOverlay`, a sibling of `Grid` that -- unlike
 * `Grid` -- has no reason to ever pick up `will-change`, `transform`,
 * `filter`, or any other property that creates a containing block as a side
 * effect. Do not "fix" a future recurrence of this by editing
 * `scrollable.ts`: that style is shared app-wide, and removing it there
 * fixes this one symptom by accident while leaving the actual rule (nothing
 * between the focused tile and this element may become a containing block)
 * unenforced for the next thing that touches `Grid`.
 *
 * There used to be a `FocusBox` here too: a flex sibling, ahead of `Grid` in
 * the flex column below, whose `flex-grow: 1` pushed `Grid` down to the
 * bottom and gave the focused tile a home to center itself in. It is gone
 * now that the focused tile is rendered by the same `TrackLoop` as the strip
 * (see `visibleTracks`) and instead overlays this element directly (via
 * `FocusOverlay`). `Grid` is this component's only flex child left when
 * focused, so `justifyContent: "flex-end"` (below, gated on `focus` the same
 * way `FocusBox` used to be conditionally rendered) takes over pinning it to
 * the bottom edge; it is a no-op when unfocused, where `Grid`'s own
 * `minHeight: "100%"` already fills this box with nothing left over to
 * justify.
 */
const Call = styled("div", {
  base: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    flexGrow: 1,
    minHeight: 0,
  },
  variants: {
    focus: {
      true: {
        justifyContent: "flex-end",
      },
    },
  },
});

/**
 * Mount point `ParticipantTile` portals the currently-focused tile into (see
 * `focusOverlayContext` above), so that tile's `position: absolute` resolves
 * against `Call` -- see `Call`'s own doc comment for the whole story of why
 * that tile cannot simply stay a plain descendant of `Grid`.
 *
 * A sibling of `Grid`, both direct children of `Call` (`InRoom` renders no
 * DOM element of its own), rather than replacing `Grid` or wrapping it: the
 * strip (everyone *not* focused) still needs to render, scroll, and measure
 * exactly as it does today, and this only ever holds the one portaled tile
 * on top of it.
 *
 * Always present and sized to the whole card, even with nothing focused --
 * an empty, `pointer-events: none` box costs nothing, and is simpler than
 * mounting and unmounting it (and, transitively, remounting whatever
 * `ParticipantTile` happens to be portaled into it) in step with focus
 * changes. `pointerEvents: "none"` keeps it from stealing clicks meant for
 * `Grid` underneath when it is empty (or momentarily behind a focus
 * transition); `ParticipantTile`'s `focus` variant re-enables its own
 * pointer events, the same pattern its `Overlay` styled component already
 * uses for the same reason.
 */
const FocusOverlay = styled("div", {
  base: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
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
        // The strip's height flips between this and `show: false`'s `0`
        // (below) whenever the show/hide-others chevron is toggled --
        // animate that instead of snapping, matching the focused tile's own
        // transition (`ParticipantTile.tsx`'s `getHeight()`, which resizes
        // in lockstep via `--vc-strip-h`).
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
