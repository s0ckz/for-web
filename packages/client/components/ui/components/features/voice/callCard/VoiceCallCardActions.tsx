import { useNavigate } from "@solidjs/router";
import { Show } from "solid-js";

import { useLingui } from "@lingui/solid/macro";
import { styled } from "styled-system/jsx";

import { ScreenShareContextMenu } from "@revolt/app";
import { useInstance } from "@revolt/instance";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Button, IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { SoundboardButton } from "../soundboard/SoundboardPicker";

export function VoiceCallCardActions(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const state = useState();
  const navigate = useNavigate();
  const { t } = useLingui();
  const { limits } = useInstance();

  return (
    <Actions>
      <Show when={props.size === "xs"}>
        <IconButton
          variant="standard"
          size={props.size}
          onPress={() => {
            navigate(voice.channel()?.path ?? "");
            state.appDrawer()?.setShown(true);
          }}
          use:floating={{
            tooltip: {
              placement: "top",
              content: t`Return to voice channel`,
            },
          }}
        >
          <Symbol>arrow_top_left</Symbol>
        </IconButton>
      </Show>
      <IconButton
        size={props.size}
        variant={voice.microphone() ? "filled" : "tonal"}
        onPress={() => voice.toggleMute()}
        use:floating={{
          tooltip: {
            placement: "top",
            content: voice.speakingPermission
              ? voice.microphone()
                ? t`Mute`
                : t`Unmute`
              : t`Missing permission`,
          },
        }}
        isDisabled={!voice.speakingPermission}
      >
        <Show when={voice.microphone()} fallback={<Symbol>mic_off</Symbol>}>
          <Symbol>mic</Symbol>
        </Show>
      </IconButton>
      <IconButton
        size={props.size}
        variant={voice.deafen() || !voice.listenPermission ? "tonal" : "filled"}
        onPress={() => voice.toggleDeafen()}
        use:floating={{
          tooltip: {
            placement: "top",
            content: voice.listenPermission
              ? voice.deafen()
                ? t`Undeafen`
                : t`Deafen`
              : t`Missing permission`,
          },
        }}
        isDisabled={!voice.listenPermission}
      >
        <Show
          when={voice.deafen() || !voice.listenPermission}
          fallback={<Symbol>headset</Symbol>}
        >
          <Symbol>headset_off</Symbol>
        </Show>
      </IconButton>
      <IconButton
        size={props.size}
        variant={limits().video && voice.video() ? "filled" : "tonal"}
        onPress={() => {
          if (limits().video) voice.toggleCamera();
        }}
        use:floating={{
          tooltip: {
            placement: "top",
            content: limits().video
              ? voice.video()
                ? t`Stop camera`
                : t`Start camera`
              : t`Coming soon! 👀`,
          },
        }}
        isDisabled={!limits().video}
      >
        <Symbol>camera_video</Symbol>
      </IconButton>
      <IconButton
        size={props.size}
        variant={limits().video && voice.screenshare() ? "filled" : "tonal"}
        onPress={(e) => {
          if (!limits().video) return;

          if (voice.screenshare()) {
            // A user who left-clicked here to swap their shared window
            // instead lost the share outright -- this was a plain
            // stop/start toggle, and the only way to reach "change
            // source"/"change quality" was an undiscoverable right-click.
            // So pointer activation (mouse/touch) now opens
            // `ScreenShareContextMenu` instead of toggling -- via the
            // separate "click"-triggered `contextMenu` listener below, not
            // this handler -- and stopping moved into that menu as an
            // explicit item.
            //
            // Keyboard activation (Enter/Space) lands here too, but
            // deliberately keeps the old direct-stop behaviour instead of
            // also opening the menu: solid-aria preventDefaults the
            // button's native click for keyboard presses (see
            // `shouldPreventDefaultKeyboard` in `@solid-aria/interactions`,
            // which only skips that for `type="submit"` buttons), so the
            // menu's "click" listener never fires for it -- and that's the
            // right outcome here, not a gap to route around. The menu
            // isn't keyboard-operable app-wide: `ContextMenuItem` renders
            // an `<a>` with no `href`/`tabIndex`/`role`, so nothing inside
            // it is reachable by Tab, and its position comes from live
            // pointermove/pointerdown coordinates that a keyboard press
            // never supplies, so it would open pinned to the viewport's
            // top-left corner. Forcing it open for keyboard users would
            // replace "Enter stops the share" with "Enter pops an
            // unreachable menu in the corner" -- worse than before this
            // change, not parity with the pointer path. For the same
            // reason this button doesn't advertise `aria-haspopup`/
            // `aria-expanded`: on the keyboard path it doesn't open a menu
            // at all, so claiming one would be a lie. Assistive-tech
            // activation that arrives as a real click (solid-aria's
            // "virtual" pointer type) does reach the menu, and inherits
            // the same unreachable-items problem described above -- a
            // known gap in the menu itself, not something this button can
            // fix on its own. This divergence is deliberate, and stays
            // until the menu is made focusable and anchored to the trigger
            // instead of the pointer.
            if (e.pointerType === "keyboard") {
              voice.toggleScreenshare();
            }
            return;
          }

          voice.toggleScreenshare();
        }}
        use:floating={{
          tooltip: {
            placement: "top",
            content: limits().video
              ? voice.screenshare()
                ? t`Sharing options`
                : t`Share screen`
              : t`Coming soon! 👀`,
          },
          // Only while actually sharing -- `undefined` rather than always
          // providing the menu, since `floating`'s directive only attaches
          // a listener at all when this is truthy, so with nothing to
          // share yet a click still falls through to starting a share
          // instead of opening an empty menu.
          contextMenu: voice.screenshare()
            ? () => <ScreenShareContextMenu />
            : undefined,
          // Left-click opens the menu above while sharing (see onPress).
          // The directive only binds one event at a time, so this gives up
          // right-click as a way to reach the menu -- a deliberate trade,
          // since left-click is the gesture people already reach for here
          // and is now the discoverable path.
          contextMenuHandler: "click",
        }}
        isDisabled={!limits().video}
      >
        <Show
          when={!limits().video || voice.screenshare()}
          fallback={<Symbol>stop_screen_share</Symbol>}
        >
          <Symbol>screen_share</Symbol>
        </Show>
      </IconButton>
      <SoundboardButton size={props.size} />
      <Button
        size={props.size}
        variant="_error"
        onPress={() => voice.disconnect()}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`End call`,
          },
        }}
      >
        <Symbol>call_end</Symbol>
      </Button>
    </Actions>
  );
}

const Actions = styled("div", {
  base: {
    flexShrink: 0,
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    zIndex: 2,

    display: "flex",
    width: "fit-content",
    justifyContent: "center",
    alignSelf: "center",

    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container)",
  },
});
