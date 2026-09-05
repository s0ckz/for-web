import { useDevice } from "@revolt/common";
import {
  type Accessor,
  type JSX,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

type Props = JSX.Directives["floating"] & object;

export type FloatingElement = {
  config: () => Props;
  element: HTMLElement;
  hide: () => void;
  show: Accessor<Props | undefined>;
};

const [floatingElements, setFloatingElements] = createSignal<FloatingElement[]>(
  [],
);

export { floatingElements };

/**
 * Register a new floating element
 * @param element element
 */
export function registerFloatingElement(element: FloatingElement) {
  setFloatingElements((elements) => [...elements, element]);
}

/**
 * Un register floating element
 * @param element DOM Element
 */
export function unregisterFloatingElement(element: HTMLElement) {
  setFloatingElements((elements) =>
    elements.filter((entry) => entry.element !== element),
  );
}

/**
 * Add floating elements
 * @param element Element
 * @param accessor Parameters
 */
export function floating(element: HTMLElement, accessor: Accessor<Props>) {
  const config = accessor();
  if (!config) return;

  const { isIOSTouch } = useDevice();

  const [show, setShow] = createSignal<Props | undefined>();
  // DEBUG: createEffect(() => console.info("show:", show()));

  registerFloatingElement({
    config: accessor,
    element,
    show,
    /**
     * Hide the element
     */
    hide() {
      setShow(undefined);
    },
  });

  /**
   * Trigger a floating element
   */
  function trigger(target: keyof Props, desiredState?: boolean) {
    const current = show();
    const config = accessor();

    if (target === "userCard" && config.userCard) {
      if (current?.userCard) {
        setShow(undefined);
      } else if (!current) {
        setShow({ userCard: config.userCard });
      } else {
        setShow(undefined);
        setShow({ userCard: config.userCard });
      }
    }

    if (target === "tooltip" && config.tooltip) {
      if (current?.tooltip) {
        if (desiredState !== true) {
          setShow(undefined);
        }
      } else if (!current) {
        if (desiredState !== false) {
          setShow({ tooltip: config.tooltip });
        }
      }
    }

    if (target === "contextMenu" && config.contextMenu) {
      if (current?.contextMenu) {
        setShow(undefined);
      } else if (!current) {
        setShow({ contextMenu: config.contextMenu });
      } else {
        setShow(undefined);
        setShow({ contextMenu: config.contextMenu });
      }
    }
  }

  /**
   * Handle click events
   */
  function onClick() {
    // TODO: handle shift+click for mention
    trigger("userCard");
  }

  /**
   * Handle context menu click
   */
  function onContextMenu(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    trigger("contextMenu");
  }

  let isTouching = false,
    tTmr: NodeJS.Timeout | undefined;

  /**
   * Handle mouse entering
   */
  function onMouseEnter() {
    if (!isTouching) trigger("tooltip", true);
  }

  /**
   * Handle mouse leaving
   */
  function onMouseLeave() {
    trigger("tooltip", false);
  }

  function onTouch() {
    isTouching = true;
    clearTimeout(tTmr);
    tTmr = setTimeout(() => {
      isTouching = false;
      tTmr = undefined;
    }, 100);
  }

  createEffect(
    on(
      () => accessor().userCard,
      (userCard) => {
        if (userCard) {
          element.style.cursor = "pointer";
          element.style.userSelect = "none";
          element.addEventListener("click", onClick);

          onCleanup(() => element.removeEventListener("click", onClick));
        }
      },
    ),
  );

  createEffect(
    on(
      () => accessor().tooltip,
      (tooltip) => {
        if (tooltip) {
          element.ariaLabel =
            typeof tooltip.content === "string"
              ? tooltip.content
              : tooltip!.aria!;

          element.addEventListener("mouseenter", onMouseEnter);
          element.addEventListener("mouseleave", onMouseLeave);
          element.addEventListener("touchstart", onTouch);
          element.addEventListener("touchend", onTouch);

          onCleanup(() => {
            element.removeEventListener("mouseenter", onMouseEnter);
            element.removeEventListener("mouseleave", onMouseLeave);
            element.removeEventListener("touchstart", onTouch);
            element.removeEventListener("touchend", onTouch);
          });
        }
      },
    ),
  );

  createEffect(
    on(
      () => accessor().contextMenu,
      (contextMenu) => {
        if (contextMenu) {
          // Captured once for this effect run instead of re-read from
          // `accessor()` (or the setup-time `config`) in the cleanup below.
          // Not a bug fix -- `use()` in solid-js/web calls this directive
          // via `untrack(() => fn(element, arg))`, so `accessor()` is an
          // untracked one-shot snapshot for the directive's whole
          // lifetime, and every current call site passes a static string
          // literal anyway, so cleanup already always saw the same value
          // the listener was registered under. This just hardens against a
          // future call site that reads a genuinely reactive value here
          // (through some path other than `accessor()`), where relying on
          // that re-read in cleanup instead of a captured value really
          // would remove the wrong event name and leave the real listener
          // attached.
          const handler = accessor().contextMenuHandler ?? "contextmenu";

          if (handler === "contextmenu" && isIOSTouch) {
            element.addEventListener("long-press", onContextMenu);
          } else {
            element.addEventListener(handler, onContextMenu);
          }

          onCleanup(() => {
            if (isIOSTouch) {
              element.removeEventListener("long-press", onContextMenu);
            }
            element.removeEventListener(handler, onContextMenu);
          });
        } else {
          // The menu can go from configured to `undefined` while it's still
          // showing (e.g. a share ends -- browser "Stop sharing" bar, the
          // shared window closing, `#onScreenShareEnded` -- while its menu
          // is open) without any click ever landing to close it. Without
          // this, `show` keeps the stale captured menu and `FloatingManager`
          // renders it forever, since nothing else reacts to `contextMenu`
          // going falsy.
          setShow(undefined);
        }
      },
    ),
  );

  onCleanup(() => unregisterFloatingElement(element));
}
