import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

// Tags that render as CSS "replaced elements" - they only ever paint their
// own UA content (a video frame, an image, an embedded document, etc.).
// Anything appended as a DOM child of one is legal markup but never
// rendered: it becomes inert fallback content. A message video/image/embed
// (see Attachment.tsx, Embed.tsx, TextEmbed.tsx) can be fullscreened via its
// own native fullscreen control, making it `document.fullscreenElement` -
// mounting a floating portal into it would silently hide every
// tooltip/menu/card/dialog/submenu app-wide for as long as it stayed
// fullscreen, with no error. Never mount into one of these; fall back to
// `#floating` instead, which preserves today's (already-broken-for-this-
// case) behaviour rather than making it worse.
const REPLACED_ELEMENT_TAGS = new Set([
  "VIDEO",
  "IMG",
  "IFRAME",
  "CANVAS",
  "EMBED",
  "OBJECT",
  "INPUT",
]);

/**
 * Tracks `document.fullscreenElement`. Seeded lazily rather than read at
 * module-import time: this module is re-exported through the `@revolt/ui`
 * barrel, so evaluating `document` eagerly here would throw for any
 * consumer that imports the barrel outside a DOM environment.
 */
const [fullscreenElement, setFullscreenElement] = createSignal<Element | null>(
  typeof document === "undefined" ? null : document.fullscreenElement,
);

// A single listener for the lifetime of the page, attached unconditionally
// at module scope - deliberately not refcounted per consumer and not tied
// to any component's onCleanup. A refcounted version can drop to zero
// subscribers between fullscreen sessions (e.g. every consumer happens to
// unmount at once) and silently stop tracking from then on, since
// re-attaching later does not re-seed the signal for the gap. One
// document-level listener for the whole app lifetime avoids that failure
// mode entirely and costs nothing to keep alive.
//
// Listener ordering: `VoiceCallCard` attaches its own `fullscreenchange`
// listener directly on `#floating`, and because `fullscreenchange` bubbles,
// that element-target listener fires *before* this document-level one -
// i.e. it runs while `fullscreenElement()` is still stale, one tick before
// the write below. Harmless today because nothing in that listener reads
// `usePortalMount` or its signal; would need attention if `Float` (the
// plain, non-fullscreen-aware portal target that already lives inside
// `#floating`) ever came to depend on this signal.
if (typeof document !== "undefined") {
  document.addEventListener("fullscreenchange", () => {
    const next = document.fullscreenElement;

    // Snapshot what the relocation triggered by `setFullscreenElement`
    // below is otherwise free to discard. Per solid-js@1.9.14
    // (`solid-js/web/dist/web.js`, `Portal`, lines 721-744), every
    // relocation builds a brand-new container `<div>` and the outgoing
    // cleanup removes the *old* container - with the portaled subtree still
    // inside it - before the new container is inserted elsewhere. The same
    // DOM nodes end up reattached a moment later, which is why uncontrolled
    // input values survive on their own - but two things don't: the
    // focused element is blurred (`document.activeElement` falls back to
    // `<body>`), and any scrollable descendant's `scrollTop`/`scrollLeft`
    // resets to 0 (e.g. `Dialog`'s `ScrimSurface`, which sets `overflowY:
    // auto`). Check both possible current mount points - `#floating` and
    // the fullscreen host, if one is active - since which one actually
    // holds the live portal content right now depends on whether we're
    // entering or leaving fullscreen.
    const relocationRoots = [
      document.getElementById("floating"),
      cachedHost?.host,
    ].filter((el): el is HTMLElement => el != null);

    const previouslyFocused = document.activeElement;
    const restoreFocusTo =
      previouslyFocused instanceof HTMLElement &&
      relocationRoots.some((root) => root.contains(previouslyFocused))
        ? previouslyFocused
        : null;

    const scrollPositions = new Map<Element, { top: number; left: number }>();
    for (const root of relocationRoots) {
      for (const el of root.querySelectorAll("*")) {
        if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
          scrollPositions.set(el, { top: el.scrollTop, left: el.scrollLeft });
        }
      }
    }

    // Update the signal *before* touching `cachedHost` below, so every
    // `<Portal mount={...}>` relocates its content out of the host first.
    // This ordering is guaranteed, not just hoped for: `setFullscreenElement`
    // is a plain `createSignal` write made outside any `batch`/
    // `startTransition`/Suspense boundary (this listener isn't inside a
    // Solid component or effect at all). Per solid-js@1.9.14's reactive core
    // (`dist/solid.js`: `writeSignal` -> `runUpdates` -> `completeUpdates`
    // -> `runEffects`), a signal write flushes every dependent effect -
    // including `<Portal>`'s own internal `createEffect`, which is what
    // actually moves its content between containers - synchronously, in the
    // same call, before `setFullscreenElement` returns, unless a
    // `Transition` is running. The reason that holds here isn't about
    // whether `usePortalMount`'s consumers (`FloatingManager`, `Dialog`,
    // `ContextMenuSubMenu`) render under Suspense/Transition - `Transition`
    // is a *module-global* in Solid (`dist/solid.js`, tested everywhere as
    // `Transition && Transition.running`), not something scoped per-signal
    // or per-effect-ancestry. It is only ever `true` inside the synchronous
    // body of the callback `startTransition` schedules via
    // `Promise.resolve().then(...)` (`dist/solid.js:531-556`), and a browser
    // event listener cannot interleave into the middle of that callback's
    // synchronous execution - it runs either before that microtask or after
    // it, never during it. So this listener always sees
    // `Transition.running` as false, independent of what any consumer ever
    // grows underneath it.
    setFullscreenElement(next);

    // Restore what the relocation above would otherwise have discarded.
    // `isConnected` guards both loops defensively: a node that legitimately
    // left the document for an unrelated reason during that (synchronous)
    // relocation shouldn't have stale state forced back onto it, and
    // restoring focus to a gone element must never throw.
    for (const [el, pos] of scrollPositions) {
      if (el.isConnected) {
        el.scrollTop = pos.top;
        el.scrollLeft = pos.left;
      }
    }
    if (restoreFocusTo) {
      try {
        if (restoreFocusTo.isConnected) {
          restoreFocusTo.focus({ preventScroll: true });
        }
      } catch {
        // Defensive only: focusing a still-connected element isn't expected
        // to throw, but silently losing focus is a far better failure mode
        // here than breaking the fullscreen transition itself.
      }
    }

    // Exiting fullscreen never calls `getFullscreenHost` again - there is
    // no new target to diff `cachedHost` against - so nothing else ever
    // cleans up the host left behind inside the element that just left
    // fullscreen. The unconditional reason this matters: `cachedHost` is
    // module-scoped, so leaving it set keeps the *entire* fullscreened
    // subtree alive - `<video>` included - for the rest of the page's life,
    // long after the tile that hosted it has unmounted. There is also a
    // conditional reason, contingent on the host staying `pointer-events:
    // none`: `ParticipantTile` gets the `group` class only when
    // `isScreenShare()`, and its `Controls`/`Overlay` show on
    // `_groupHover`, which matches on any hoverable descendant, not just
    // visible ones - so if this host were ever left hit-testable, an
    // abandoned full-viewport descendant would pin `:hover` (and with it
    // the controls/username overlay) permanently true on whatever
    // screen-share tile it was left in, in the normal (non-fullscreen) grid.
    if (!next && cachedHost) {
      cachedHost.host.remove();
      cachedHost = undefined;
    }
  });
}

/**
 * Cache of the dedicated host element created inside the current fullscreen
 * element by `getFullscreenHost`, so repeated calls while the same element
 * stays fullscreen reuse it instead of creating a new one each time.
 */
let cachedHost: { for: Element; host: HTMLDivElement } | undefined;

/**
 * Whether the pointer-events rule below has already been injected, so that
 * repeatedly entering/leaving fullscreen (each call to `getFullscreenHost`
 * for a new `target`) doesn't keep appending duplicate `<style>` tags.
 */
let pointerEventsRuleInjected = false;

/**
 * Inject (once, ever) the stylesheet rule that hands `pointer-events` back
 * to whatever gets portaled into a fullscreen host. The bare host is
 * `pointer-events: none` (see `getFullscreenHost`); without this rule that
 * would be inherited by everything portaled inside it too, since
 * `pointer-events` is an inherited property - making menus, dialogs, and
 * every other consumer unclickable along with the host itself.
 *
 * This depends on a specific fact about Solid's internals rather than
 * anything in its public API: `<Portal>` inserts its own plain, unstyled
 * `<div>` as the direct child of its mount target before placing content
 * inside that div, for every consumer (`FloatingManager`, `Dialog`,
 * `ContextMenuSubMenu`) - so a direct-child selector reaches all of them
 * without any consumer-side change, and without re-enabling pointer events
 * on the host itself. Verified against `solid-js@1.9.14`
 * (`solid-js/web/dist/web.js`: `Portal`'s non-`<head>` branch calls
 * `createElement(props.isSVG ? "g" : "div", ...)` with no style/class/attrs
 * at line 731, then `el.appendChild(container)` at line 742). If a future
 * Solid version ever wraps that div, nests it deeper, or stops inserting it
 * at all, this selector silently stops matching - every element portaled
 * while fullscreen becomes unclickable, with no error and nothing CI would
 * catch. Re-check this comment's line numbers against the installed
 * `solid-js` version if this rule is ever suspected of not applying.
 */
function ensurePointerEventsRule(): void {
  if (pointerEventsRuleInjected) return;

  const style = document.createElement("style");
  style.textContent = "[data-floating-host] > * { pointer-events: auto; }";
  document.head.appendChild(style);
  // Set only after the append succeeds, so a throw from appendChild (e.g.
  // `document.head` missing in some exotic host) doesn't leave this `true`
  // while no rule actually made it into the document - which would
  // permanently skip injection on every later retry.
  pointerEventsRuleInjected = true;
}

/**
 * Get (creating if necessary) a dedicated host element appended as a child
 * of `target`, to portal into instead of `target` itself.
 *
 * Portaling straight into `target` is legal DOM but can corrupt its layout.
 * For example, `ParticipantTile`'s fullscreened container is `display:
 * grid` with every existing child pinned to `gridArea: "1/1"` (a strict
 * 1x1 overlay grid). Solid's `<Portal>` appends a plain, unstyled `<div>`;
 * as an unplaced grid item it auto-places into an implicit second row, and
 * `align-content: normal` then splits the tile's height between the two
 * rows - visibly shifting the video up and floating the username overlay
 * above the bottom edge. Note this happens merely from a portal existing
 * (e.g. `FloatingManager`'s, which is always mounted, not gated on a menu
 * being open) - no menu needs to be open to see it.
 *
 * `position: fixed` on the host takes it out of grid flow entirely (an
 * out-of-flow/positioned box is never a grid auto-placement candidate),
 * escapes any `overflow: hidden` on `target`, and - because the browser's
 * fullscreen UA stylesheet forces `transform: none` on the fullscreen
 * element - its containing block is the viewport, so floating-ui's
 * viewport-relative coordinates keep working unmodified.
 *
 * See the BUG HISTORY comment below this function for why the host must
 * also be non-zero-sized and carry an explicit z-index, on top of being
 * out-of-flow.
 *
 * TODO: `strategy: "fixed"` - see the TODO on `usePortalMount` below.
 */
function getFullscreenHost(target: Element): HTMLDivElement {
  if (cachedHost?.for === target) return cachedHost.host;

  // the previous host, if any, belongs to an element we've since left
  // fullscreen (or are no longer targeting) - drop it
  cachedHost?.host.remove();

  ensurePointerEventsRule();

  const host = document.createElement("div");
  host.dataset.floatingHost = "";
  // Intentionally no ARIA attributes. This div is a bare positioning
  // wrapper - no role, no text - and already invisible to assistive tech on
  // its own merits. Never add `aria-hidden="true"` here specifically,
  // though: unlike a typical decorative wrapper, everything portaled inside
  // this one *is* the app's floating UI, so hiding it would hide every
  // menu, tooltip, card, and dialog from screen readers for as long as the
  // tile stays fullscreen.

  // INVARIANTS - each one below fixes a distinct, previously-shipped bug;
  // see BUG HISTORY below this function for what breaks if any is dropped:
  // - out-of-flow AND non-zero-sized (`position: fixed` with `inset: 0`,
  //   not `width: 0; height: 0`)
  // - `pointer-events: none` here, paired with the injected `> *` rule in
  //   `ensurePointerEventsRule`
  // - an explicit `z-index` (not the stacking context's default `auto`)
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.pointerEvents = "none";
  host.style.zIndex = "10000";
  target.appendChild(host);

  cachedHost = { for: target, host };
  return host;
}

/*
 * BUG HISTORY for `getFullscreenHost` - two more consequences of
 * `position: fixed`, beyond the out-of-flow escape explained in the
 * function's own doc comment above. Both were shipped and fixed once
 * already; don't reintroduce either by "simplifying" the invariants above.
 *
 * First bug (fixed by keeping the host non-zero-sized): an earlier version
 * gave the host `top: 0; left: 0; width: 0; height: 0` on the theory that a
 * zero-area host can't visually disturb anything. But `position: fixed`
 * doesn't just take the host out of flow - it also makes the host a
 * *positioned* ancestor, i.e. the containing block that an
 * absolutely-positioned descendant resolves its own size against.
 * `FloatingManager`'s floating element defaults to `position: absolute`
 * (floating-ui's default `strategy`, since none is passed to
 * `useFloating`), so with a 0-width containing block, a menu's natural
 * `width: auto` shrink-to-fit had zero available width to shrink-to-fit
 * *within* - collapsing every label to one character per line instead of
 * wrapping only where needed.
 *
 * The out-of-flow guarantee never depended on the host being zero-sized -
 * `position: fixed` removes it from grid auto-placement regardless of its
 * `width`/`height`. So the host is sized to cover the full viewport
 * (`inset: 0`) instead, giving descendants a normal, non-zero containing
 * block while staying just as inert to layout. What sizing the host up
 * does reintroduce is a full-viewport element that would otherwise sit on
 * top of the tile and swallow every click, right-click, and hover meant
 * for the video/controls beneath it. `pointer-events: none` removes the
 * *bare* host from hit-testing, and `ensurePointerEventsRule` hands
 * `pointer-events: auto` back to the portaled content so it isn't
 * collateral damage - but that pairing is not a blanket hit-testing
 * guarantee for everything the host ever contains: `pointer-events` is
 * inherited, the injected rule re-enables the *entire* portaled subtree,
 * and `Dialog`'s `ScrimSurface` explicitly sets `pointerEvents: "all"` in
 * its own base styles. A `Dialog` the modal controller keeps mounted with
 * `show: false` for 500ms after close therefore still has a full-viewport
 * click-swallowing surface live in the host during that window. That's
 * pre-existing behaviour of `ScrimSurface`, not something this file
 * introduces, and it's out of scope to fix here - but don't read this
 * host's own `pointer-events: none` as a guarantee against it.
 *
 * Second bug (fixed by an explicit z-index): per CSS Position L3,
 * `position: fixed` *always* creates a stacking context, even at the
 * default `z-index: auto`. That has two effects here. First, it traps the
 * z-indexes used *inside* the host (`999`/`99` on `FloatingManager`'s
 * floating div, `998` on `Dialog`'s Scrim, `1000` on the submenu `Motion`)
 * inside that stacking context - they can no longer out-rank anything
 * outside it. Second, and worse, the host itself paints at `z-index: auto`,
 * which loses to every *sibling* with a positive `z-index`.
 *
 * Concretely: in tile fullscreen, the host's siblings inside the tile are
 * grid items with explicit z-indexes (`ScreenShareStats`' Panel at 10,
 * `ParticipantTile`'s `Controls` at 9, `NotWatching` at 3, `Connecting` at
 * 2) - so with the stats panel open the context menu paints *behind* it,
 * the Controls cluster fades in *over* an open menu, and a dropped track
 * covers it entirely. In call-card fullscreen it's worse: `VoiceCallCard`
 * fullscreens `#floating` itself (a `DIV`, not a replaced element), so
 * `getFullscreenHost` builds the host *inside* `#floating`, sibling to the
 * `Float` portal container there (`position: fixed`, `z-index: 10`, or
 * `100` under the `fullscreen` variant) - `100 > auto`, so right-clicking a
 * participant tile while the call card is fullscreen rendered the context
 * menu *behind the call card, i.e. invisible*. That was the exact bug this
 * feature exists to fix, reintroduced by the fix itself in the other
 * fullscreen mode. (Before this feature, `FloatingManager` mounted straight
 * into the unstyled `#floating`, so its `999` competed directly with
 * `Float`'s `100` in the root stacking context and simply won.)
 *
 * Fix: give the host an explicit `z-index` (`10000`) above everything it
 * must clear, chosen from an actual repo-and-dependency sweep rather than
 * the theoretical maximum. The highest z-index anywhere else in the app is
 * `9999` (`AndroidNag.tsx`), and that component lives in `#root` - it never
 * shares a stacking context with this host, so it isn't even a real
 * competitor, just the ceiling worth clearing with headroom. Inside the
 * fullscreen subtree itself the highest competitors are `1000` and `999`
 * (see above). `10000` clears all of it and leaves the true ceiling
 * (`2147483647`) available should something legitimately need it later.
 * Using the maximum here directly, as an earlier version of this fix did,
 * has its own cost: it silently inverts an existing pairing during
 * call-card fullscreen. `ImageViewer` (`999`) used to reliably paint above
 * `Dialog`'s Scrim (`998`); at the maximum z-index, every `Dialog` rendered
 * through this host would out-rank it instead. This is safe regardless of
 * whether a given engine treats `position: fixed` as stacking-context-
 * forming in some edge case or not: if it does, the whole subtree lifts
 * with it; if it somehow doesn't, the host is simply a positioned element
 * at a high z-index, which is harmless either way.
 */

/**
 * Resolve where a top-level floating portal (context menu, tooltip, user
 * card, dialog, submenu, ...) should mount.
 *
 * Everything normally mounts into the `#floating` div, which sits high in
 * the document so it paints above regular app content. But the Fullscreen
 * API only promotes the fullscreened element itself (and its descendants)
 * into the browser's top layer. Tile fullscreen
 * (`tileRef.requestFullscreen()` in `ParticipantTile`) fullscreens a deep
 * descendant of `#floating` instead - anything still portaled into
 * `#floating` in that case renders *outside* the top layer, so it is
 * technically mounted but never actually visible.
 *
 * Call-card fullscreen (`VoiceCallCard` calling
 * `document.getElementById("floating")?.requestFullscreen()`) fullscreens
 * `#floating` *itself* - and is very much affected by this, not exempt from
 * it: `#floating` is a `DIV`, not one of the `REPLACED_ELEMENT_TAGS` below,
 * so the check below falls through to `getFullscreenHost(#floating)` just
 * like any other target. During call-card fullscreen, the host, its
 * `pointer-events: none`, and the injected stylesheet rule are therefore
 * live for the *entire app's* floating UI (every tooltip, menu, card,
 * dialog, submenu), not scoped to one tile - see the BUG HISTORY on
 * `getFullscreenHost` for the z-index consequence this has in that mode
 * specifically.
 *
 * Returns a *reactive* accessor, and passing it straight to `<Portal
 * mount={mount()}>` is enough - no extra `<Show keyed>`-style wrapper is
 * needed. Solid's `<Portal>` reads `mount()` inside its own internal effect
 * and, when the returned element changes, relocates the same (memoised)
 * content instead of tearing it down and recreating it - preserving
 * component state and uncontrolled input values (same DOM nodes, just
 * moved). It is not, however, a seamless in-place move: per
 * solid-js@1.9.14 (`solid-js/web/dist/web.js`, `Portal`, lines 721-744),
 * each relocation builds a brand-new container `<div>` and the outgoing
 * cleanup removes the *old* container - with the subtree still inside it -
 * before the new one is inserted. Two things don't survive that
 * detach/reattach on their own: the focused element is blurred, and any
 * scrollable descendant's scroll offset resets to 0 (e.g. an open
 * `Dialog`'s `ScrimSurface`, which sets `overflowY: auto`). The
 * `fullscreenchange` listener above saves both immediately before the
 * relocating signal write and restores them immediately after, specifically
 * to cover this gap - see that listener for the mechanism. Wrapping this
 * accessor in something keyed would still be worse than today regardless:
 * it would force a teardown-and-recreate of the whole portaled subtree -
 * losing an open Dialog's `Presence` exit animation, resetting uncontrolled
 * input values, and defeating the save/restore above - on every single
 * fullscreen transition.
 *
 * Not tied to a Solid component/owner: this function performs no
 * subscription of its own that would need cleanup, so it is safe to call
 * from anywhere, including outside a reactive scope.
 *
 * TODO: the cleaner long-term fix here is the `popover` attribute - the
 * browser promotes a popover into the top layer regardless of DOM
 * ancestry, which would make this entire module (the replaced-element
 * check and the grid-layout host workaround alike) unnecessary. Deferred
 * for this PR because it means reworking the dismiss/animation logic
 * already built around `<Portal>` in all three consumers, which is a
 * larger and riskier change than this fix.
 *
 * A narrower, incremental step in the same direction: passing
 * `strategy: "fixed"` to `useFloating` in `FloatingManager` and
 * `ContextMenuSubMenu` (`Dialog` doesn't call `useFloating` at all) would
 * resolve those floating elements against the viewport instead of against
 * this host. At that point the host's size stops mattering for
 * positioning, and the injected stylesheet in `ensurePointerEventsRule`,
 * the Solid-internals coupling it depends on, and this host's hit-testing
 * surface could all be deleted outright. Not doing that now, since it
 * touches two consumers - but it is the change that stops this sequence of
 * fixes.
 *
 * Currently wired up in `FloatingManager`, `Dialog`, and
 * `ContextMenuSubMenu`. `SnackbarProvider` (design/Snackbar.tsx) mounts
 * into `#floating` the same way and can in principle fire unprompted while
 * a tile is fullscreen, but that is cosmetic (a missed toast, not an
 * unusable app) and left out of scope here.
 */
export function usePortalMount(): Accessor<Element | null> {
  // Returning a closure that reads a signal is the entire point here: this
  // is an accessor, and its callers read it inside JSX
  // (`<Portal mount={mount()}>`), which is a tracked scope. solid/reactivity
  // cannot see that from this side of the call, so it is silenced below.
  //
  // Do NOT "fix" the warning by wrapping this body in createMemo or by
  // resolving the element eagerly -- either would freeze the mount target at
  // the value it had when the component rendered, and the portal would stop
  // following fullscreen transitions, which is the whole feature.
  // eslint-disable-next-line solid/reactivity
  return () => {
    const target = fullscreenElement();
    if (!target || REPLACED_ELEMENT_TAGS.has(target.tagName)) {
      return document.getElementById("floating");
    }

    return getFullscreenHost(target);
  };
}
