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
        onPress={() => {
          if (limits().video) voice.toggleScreenshare();
        }}
        use:floating={{
          tooltip: {
            placement: "top",
            content: limits().video
              ? voice.screenshare()
                ? t`Stop sharing`
                : t`Share screen`
              : t`Coming soon! 👀`,
          },
          // Right-click only, and only while actually sharing -- left-click
          // above stays a plain stop/start toggle either way. `undefined`
          // rather than always providing the menu: `floating`'s directive
          // only attaches a "contextmenu" listener at all when this is
          // truthy, so with nothing to share yet a right-click still falls
          // through to the browser's own menu instead of opening an empty one.
          contextMenu: voice.screenshare()
            ? () => <ScreenShareContextMenu />
            : undefined,
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
