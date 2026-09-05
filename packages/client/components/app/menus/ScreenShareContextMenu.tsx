import { Trans } from "@lingui/solid/macro";

import { useVoice } from "@revolt/rtc";

import MdSelectWindow from "@material-symbols/svg-400/outlined/select_window.svg?component-solid";
import MdStopScreenShare from "@material-symbols/svg-400/outlined/stop_screen_share.svg?component-solid";
import MdTune from "@material-symbols/svg-400/outlined/tune.svg?component-solid";

import {
  ContextMenu,
  ContextMenuButton,
  ContextMenuDivider,
} from "./ContextMenu";

/**
 * Context menu attached to the call card's screen-share button while a
 * share is live, offering to change its quality or source, or stop it
 * outright.
 *
 * Opened on a left-click while sharing, via `use:floating`'s `contextMenu`
 * and `contextMenuHandler: "click"` on that button (see
 * `VoiceCallCardActions`). It used to be right-click only, with left-click
 * left as the plain stop toggle -- but that meant the one gesture users
 * actually reached for to swap windows silently ended their share instead,
 * and nothing about the button hinted a menu existed. Left-click now opens
 * this menu, and stopping moved in here as an explicit item below: that
 * costs stopping an extra click, and gives up right-click as a way to reach
 * this menu (the directive only binds one event at a time), but both are
 * the deliberate trade for making the options discoverable.
 *
 * Icons are passed as SVG components (via `symbol=`, same convention as
 * `NotificationContextMenu`'s `@material-symbols` icons) rather than the
 * `<Symbol>` ligature-font component deliberately: `ContextMenuItem`'s
 * `& span { flexGrow: 1 }` is a descendant selector that would otherwise
 * catch `<Symbol>`'s own `<span>` and grow it alongside the label, splitting
 * the row -- other menus that use `<Symbol>` here wrap it in a fixed-size
 * `IconSlot` for exactly this reason (see `UserContextMenu`). An SVG icon
 * component renders an `<svg>`, which that selector never matches.
 */
export function ScreenShareContextMenu() {
  const voice = useVoice();

  return (
    <ContextMenu>
      <ContextMenuButton
        symbol={MdTune}
        onClick={() => voice.openScreenShareQualitySettings()}
      >
        <Trans>Change quality</Trans>
      </ContextMenuButton>
      <ContextMenuButton
        symbol={MdSelectWindow}
        onClick={() => voice.changeScreenShareSource()}
      >
        <Trans>Change source</Trans>
      </ContextMenuButton>
      <ContextMenuDivider />
      {/* Destructive action last, behind a divider -- same convention as
          the other menus in this folder (e.g. ChannelContextMenu,
          ServerContextMenu). */}
      <ContextMenuButton
        symbol={MdStopScreenShare}
        onClick={() => {
          // Guarded the same way the two items above guard themselves
          // inside `state.tsx`: this menu can still be on screen after the
          // share it was opened for has already ended (the browser's own
          // "Stop sharing" bar, the shared window closing,
          // `#onScreenShareEnded`), and `toggleScreenshare()` has no such
          // guard of its own -- called with `screenshare()` already false
          // it takes the *start* branch. Without this, clicking a
          // destructive "Stop sharing" button on a stale menu would launch
          // a brand new share instead.
          if (voice.screenshare()) voice.toggleScreenshare();
        }}
        destructive
      >
        <Trans>Stop sharing</Trans>
      </ContextMenuButton>
    </ContextMenu>
  );
}
