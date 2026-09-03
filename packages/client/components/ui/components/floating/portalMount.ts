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
if (typeof document !== "undefined") {
  document.addEventListener("fullscreenchange", () => {
    setFullscreenElement(document.fullscreenElement);
  });
}

/**
 * Cache of the dedicated host element created inside the current fullscreen
 * element by `getFullscreenHost`, so repeated calls while the same element
 * stays fullscreen reuse it instead of creating a new one each time.
 */
let cachedHost: { for: Element; host: HTMLDivElement } | undefined;

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
 */
function getFullscreenHost(target: Element): HTMLDivElement {
  if (cachedHost?.for === target) return cachedHost.host;

  // the previous host, if any, belongs to an element we've since left
  // fullscreen (or are no longer targeting) - drop it
  cachedHost?.host.remove();

  const host = document.createElement("div");
  host.dataset.floatingHost = "";
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = "0";
  host.style.height = "0";
  target.appendChild(host);

  cachedHost = { for: target, host };
  return host;
}

/**
 * Resolve where a top-level floating portal (context menu, tooltip, user
 * card, dialog, submenu, ...) should mount.
 *
 * Everything normally mounts into the `#floating` div, which sits high in
 * the document so it paints above regular app content. But the Fullscreen
 * API only promotes the fullscreened element itself (and its descendants)
 * into the browser's top layer. Call-card fullscreen (`voice.fullscreen()`)
 * fullscreens `#floating` directly, so that case is unaffected by any of
 * this. Tile fullscreen (`tileRef.requestFullscreen()` in
 * `ParticipantTile`) fullscreens a deep descendant of `#floating` instead -
 * anything still portaled into `#floating` in that case renders *outside*
 * the top layer, so it is technically mounted but never actually visible.
 *
 * Returns a *reactive* accessor, and passing it straight to `<Portal
 * mount={mount()}>` is enough - no extra `<Show keyed>`-style wrapper is
 * needed. Solid's `<Portal>` reads `mount()` inside its own internal
 * effect and *relocates* the same (memoised) content into the new
 * container in place, preserving component state, when the returned
 * element changes; it does not need help re-mounting. Wrapping it in
 * something keyed would instead force a teardown-and-recreate of the whole
 * portaled subtree - and anything live inside it, e.g. an open Dialog's
 * uncontrolled input values, scroll position, and `Presence` exit
 * animation - on every single fullscreen transition, which is worse than
 * doing nothing.
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
