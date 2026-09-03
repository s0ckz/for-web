import { Trans } from "@lingui/solid/macro";

import { useVoice } from "@revolt/rtc";

import MdSelectWindow from "@material-symbols/svg-400/outlined/select_window.svg?component-solid";
import MdTune from "@material-symbols/svg-400/outlined/tune.svg?component-solid";

import { ContextMenu, ContextMenuButton } from "./ContextMenu";

/**
 * Context menu attached to the call card's screen-share button while a
 * share is live, offering to change its quality or its source without
 * stopping.
 *
 * Only ever opened on a right-click, via `use:floating`'s `contextMenu` on
 * that button -- left-click there stays the plain stop/start toggle it
 * always was (see VoiceCallCardActions), so the two never conflict.
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
    </ContextMenu>
  );
}
