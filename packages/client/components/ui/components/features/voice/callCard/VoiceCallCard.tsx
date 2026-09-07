import {
  JSX,
  Show,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  useContext,
} from "solid-js";
import { Portal } from "solid-js/web";

import { createResizeObserver } from "@solid-primitives/resize-observer";
import { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { SlideState } from "@revolt/ui/components/navigation/SlideDrawer";

import { VoiceCallCardActiveRoom } from "./VoiceCallCardActiveRoom";
import { VoiceCallCardPiP } from "./VoiceCallCardPiP";
import { VoiceCallCardPreview } from "./VoiceCallCardPreview";

type Mode = "floating" | "moving";
type FloatType = "tl" | "tr" | "bl" | "br";

type Info = {
  channel: Channel;
  pos: DOMRect;
  drawer?: SlideState;
  /** Chat is hidden, so the card should fill the whole channel area */
  expanded?: boolean;
};

const PAD = 16,
  PAD_X = `${PAD}px`,
  PAD_Y = `${PAD + 56}px`;

const callCardContext = createContext<(info?: Info) => void>();

/** Voice call card context */
export function VoiceCallCardContext(props: { children: JSX.Element }) {
  const voice = useVoice();
  const inCall = () => !!voice.channel();

  const [mode, setMode] = createSignal<Mode>();
  const [info, setInfo] = createSignal<Info>();

  let ref: HTMLDivElement | undefined,
    events: AbortController | null,
    pid = 0,
    ofsX = 0,
    ofsY = 0;

  function mouseDown(e: PointerEvent) {
    pid = e.pointerId;
    if (mode() === "floating") {
      const pos = ref!.getBoundingClientRect();
      ofsX = e.clientX - pos.x;
      ofsY = e.clientY - pos.y;
      setMode("moving");
      addEvents();
    }
  }

  function mouseMove(e: PointerEvent) {
    if (e.pointerId !== pid) return;
    e.preventDefault();
    const x = e.clientX - ofsX,
      y = e.clientY - ofsY;
    ref!.style.transform = `translate(${x}px, ${y}px)`;
  }

  function mouseUp(e: PointerEvent) {
    if (e.pointerId !== pid) return;
    const sty = ref!.style,
      pos = ref!.getBoundingClientRect(),
      left = e.clientX - ofsX + pos.width / 2 < innerWidth / 2,
      top = e.clientY - ofsY + pos.height / 2 < innerHeight / 2;

    sty.transition = "all .2s cubic-bezier(0, 1.5, 0.85, 0.8)";
    setFloat(left ? (top ? "tl" : "bl") : top ? "tr" : "br");
    //Reset CSS transition on next render pass
    setTimeout(() => (sty.transition = ""), 1);
    resetEvents();
  }

  function addEvents() {
    if (events) return;
    events = new AbortController();
    const opt = { passive: false, signal: events.signal };
    document.addEventListener("pointermove", mouseMove, opt);
    document.addEventListener("pointerup", mouseUp, opt);
  }

  function resetEvents() {
    events?.abort();
    events = null;
  }

  createEffect(() => {
    const inf = info();
    if (!ref) return;
    const sty = ref.style;
    resetEvents();

    //Set mode based on state
    if (voice.fullscreen()) {
      sty.transform = ``;
      sty.width = `100%`;
      sty.height = ``;
      setMode();
    } else if (inf?.pos && (!inf.drawer || inf.drawer === SlideState.SHOWN)) {
      sty.transform = `translate(${inf.pos.x}px, ${inf.pos.y}px)`;
      sty.width = `${inf.pos.width}px`;
      // With the chat hidden the mount marker grows to fill <main>, so the
      // card can simply take its height instead of the default 40vh.
      sty.height = inf.expanded ? `${inf.pos.height}px` : ``;
      setMode();
    } else if (!inCall()) {
      const y = inf?.pos.y ?? ref.getBoundingClientRect().y;
      sty.transform = `translate(${innerWidth + 50}px, ${y}px)`;
      setMode();
    } else if (!mode()) setFloat("tr");
  });

  const channel = () => info()?.channel;

  function setFloat(float: FloatType) {
    const sty = ref!.style,
      x = float[1] === "l" ? PAD_X : `calc(100vw - var(--flt-w) - ${PAD_X})`,
      y = float[0] === "t" ? PAD_Y : `calc(100vh - var(--flt-h) - ${PAD_Y})`;
    sty.transform = `translate(${x}, ${y})`;
    sty.width = "";
    sty.height = "";
    setMode("floating");
  }

  onCleanup(resetEvents);

  onMount(() => {
    document
      .getElementById("floating")
      ?.addEventListener("fullscreenchange", () => {
        if (!document.fullscreenElement) {
          voice.toggleFullscreen(false);
        }
      });
  });

  createEffect(() => {
    if (voice.fullscreen() && inCall()) {
      if (
        !document
          .getElementById("floating")
          ?.isSameNode(document.fullscreenElement)
      ) {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        }
        document.getElementById("floating")?.requestFullscreen();
      }
    } else if (document.fullscreenElement) {
      document.exitFullscreen();
    }
  });

  return (
    <callCardContext.Provider value={setInfo}>
      {props.children}
      <Portal mount={document.getElementById("floating")! as HTMLDivElement}>
        <Float
          ref={ref}
          mode={mode()}
          onPointerDown={mouseDown}
          fullscreen={voice.fullscreen()}
        >
          {/*
           * `VoiceCallCard` (and, inside it, `VoiceCallCardActiveRoom`'s
           * whole participant grid) used to be swapped out via `<Switch>`
           * for `VoiceCallCardPiP` whenever the card was dragged into its
           * floating pill -- destroying and rebuilding every tile (and its
           * `<video>` element) on each drag/undrag. It now stays mounted the
           * whole time `channel()` is set, and is just hidden with CSS
           * (`pip`, below) while the pill is showing; `VoiceCallCardPiP`
           * itself is cheap (no per-tile grid) and stays conditionally
           * mounted as before.
           */}
          <Show when={channel()}>
            <VoiceCallCard
              channel={channel()!}
              inCall={inCall()}
              showCard={voice.showCard(channel()!)}
              fullscreen={voice.fullscreen()}
              pip={!!mode() && inCall()}
            />
          </Show>
          <Show when={mode() && inCall()}>
            <VoiceCallCardPiP />
          </Show>
        </Float>
      </Portal>
    </callCardContext.Provider>
  );
}

const Float = styled("div", {
  base: {
    position: "fixed",
    zIndex: 10,
    pointerEvents: "none",
    transition: "all .3s cubic-bezier(1, 0, 0, 1)",
    height: "40vh",
    touchAction: "none",
  },
  variants: {
    mode: {
      floating: { cursor: "grab" },
      moving: {
        cursor: "grabbing",
        transition: "none",
      },
    },
    fullscreen: {
      true: {
        zIndex: 100,
        height: "100vh",
        top: 0,
        // Width is set by floating logic in effect above
      },
      false: {},
    },
  },
  compoundVariants: [
    {
      mode: ["floating", "moving"],
      css: {
        "--flt-w": "300px",
        "--flt-h": "170px",
        width: "var(--flt-w)",
        height: "var(--flt-h)",
      },
    },
  ],
});

/** 'Marker' to send position information for mounting the floating call card */
export function VoiceChannelCallCardMount(props: {
  channel: Channel;
  expanded?: boolean;
}) {
  const voice = useVoice();
  const state = useState();
  const setInfo = useContext(callCardContext)!;
  let ref: HTMLDivElement | undefined;

  // The floating card is positioned from this rect, and with the chat hidden it
  // grows to fill this very marker -- so publishing a fresh object on every
  // observation feeds the card's own size back into the observer that measured
  // it. Only publish when something actually moved.
  let lastKey = "";

  // `getBoundingClientRect()` forces a synchronous layout, so it must only
  // ever run from the resize observer below (an actual size/position
  // change), not from `updateInfo` itself -- `updateInfo` also re-runs on
  // every reactive change unrelated to layout (`voice.channel()`,
  // `state.appDrawer()`, `props.expanded`), and re-measuring on each of
  // those would force a reflow on renders that never moved anything. Cached
  // here instead, and `undefined` until the observer's first callback --
  // which fires once immediately on `observe()` -- has measured it.
  let lastRect: DOMRect | undefined;

  function updateInfo() {
    const vc = voice.channel();
    const drawer = state.appDrawer()?.state;
    const expanded = props.expanded;
    const elsewhere = !!vc && vc.id !== props.channel.id;
    const pos = lastRect;
    if (!pos) return;

    const key = elsewhere
      ? "elsewhere"
      : [
          props.channel.id,
          Math.round(pos.x),
          Math.round(pos.y),
          Math.round(pos.width),
          Math.round(pos.height),
          drawer,
          expanded,
        ].join("|");
    if (key === lastKey) return;
    lastKey = key;

    setInfo(
      elsewhere
        ? undefined
        : {
            channel: props.channel,
            pos,
            drawer,
            expanded,
          },
    );
  }

  createEffect(updateInfo);

  onMount(() => {
    const target = ref?.parentElement;
    if (!target) return;

    createResizeObserver(target, () => {
      lastRect = ref!.getBoundingClientRect();
      updateInfo();
    });
  });
  onCleanup(() => {
    setInfo();
  });

  return (
    <div
      ref={ref!}
      style={props.expanded ? { flex: 1, "min-height": 0 } : {}}
    />
  );
}

/**
 * Call card
 *
 * `pip` is true while the floating pill (`VoiceCallCardPiP`) is showing on
 * top of this card instead. It used to mean this component simply was not
 * rendered at all (see the `<Switch>` this replaced in
 * `VoiceCallCardContext`) -- now it stays mounted underneath and is just
 * hidden with CSS, so `VoiceCallCardActiveRoom`'s participant grid does not
 * get destroyed and rebuilt every time the card is dragged into or out of
 * its pill.
 */
function VoiceCallCard(props: {
  channel: Channel;
  inCall: boolean;
  showCard: boolean;
  fullscreen: boolean;
  pip: boolean;
}) {
  return (
    <Show when={props.showCard}>
      <Base fullscreen={props.fullscreen} pip={props.pip}>
        <Card active={props.inCall} fullscreen={props.fullscreen}>
          <Show
            when={props.inCall}
            fallback={<VoiceCallCardPreview channel={props.channel} />}
          >
            <VoiceCallCardActiveRoom />
          </Show>
        </Card>
      </Base>
    </Show>
  );
}

const Base = styled("div", {
  base: {
    left: 0,
    top: "var(--gap-md)",
    padding: "var(--gap-md)",

    width: "100%",
    height: "100%",
    position: "absolute",

    zIndex: 2,
    userSelect: "none",

    display: "flex",
    alignItems: "center",
    flexDirection: "column",
  },
  variants: {
    fullscreen: {
      true: {
        top: 0,
        height: "100%",
        padding: 0,
      },
    },
    // Hides the card while `VoiceCallCardPiP` shows on top of it, without
    // unmounting it (see the doc comment on `VoiceCallCard` above).
    // `visibility: hidden` rather than `display: none` so it stays a real
    // laid-out box (`VoiceCallCardActiveRoom`'s resize observer keeps
    // measuring it) and drops out of the tab order/accessibility tree,
    // unlike `opacity: 0`.
    pip: {
      true: {
        visibility: "hidden",
        pointerEvents: "none",
      },
    },
  },
});

const Card = styled("div", {
  base: {
    pointerEvents: "all",

    maxWidth: "100%",
    transition: "var(--transitions-fast) all",
    transitionTimingFunction: "ease-in-out",

    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-secondary-container)",
  },
  variants: {
    active: {
      true: {
        width: "100%",
      },
      false: {
        width: "360px",
        height: "120px",
        cursor: "pointer",
      },
    },
    fullscreen: {
      true: {
        height: "100%",
        borderRadius: 0,
      },
      false: {},
    },
  },
  compoundVariants: [
    {
      active: [true],
      fullscreen: [false],
      css: {
        // Float is 40vh by default and the whole channel area when the chat is
        // hidden; either way the card fills it, minus Base's padding.
        height: "calc(100% - 2 * var(--gap-md))",
      },
    },
  ],
  defaultVariants: {
    active: false,
    fullscreen: false,
  },
});
