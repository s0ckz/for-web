import { Show, createSignal } from "solid-js";

import { useLingui } from "@lingui/solid/macro";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { symbolSize, typography } from "@revolt/ui";

import MdSystemUpdateAlt from "@material-symbols/svg-400/outlined/system_update_alt.svg?component-solid";

import type { DesktopUpdateState } from "./desktopUpdates";

export function DesktopUpdateButton(props: {
  state: DesktopUpdateState;
  install: () => Promise<boolean>;
}) {
  const { t } = useLingui();
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const label = () => {
    if (props.state.status === "downloading") return t`Downloading update…`;
    if (pending() || props.state.status === "installing") return t`Restarting…`;
    if (failed()) return t`Retry update`;
    return t`Restart to update`;
  };

  async function restart() {
    if (props.state.status !== "ready" || pending()) return;
    setPending(true);
    setFailed(false);
    try {
      if (!(await props.install())) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <Show when={props.state.status !== "idle"}>
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{ "-webkit-app-region": "no-drag" }}
      >
        <UpdateAction
          type="button"
          data-desktop-update
          aria-label={label()}
          title={
            props.state.status === "downloading"
              ? label()
              : failed()
                ? t`Could not restart Stoat. Try again or use the tray icon.`
                : t`Restart Stoat to install the update. This ends any active call.`
          }
          disabled={props.state.status !== "ready" || pending()}
          onClick={restart}
        >
          <MdSystemUpdateAlt {...symbolSize(16)} aria-hidden="true" />
          <span
            class={css({ "@media (max-width: 600px)": { display: "none" } })}
          >
            {label()}
          </span>
        </UpdateAction>
      </div>
    </Show>
  );
}

const UpdateAction = styled("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    height: "23px",
    paddingInline: "8px",
    marginInlineEnd: "8px",
    flexShrink: 0,
    whiteSpace: "nowrap",
    border: "none",
    borderRadius: "999px",
    cursor: "pointer",
    background: "var(--md-sys-color-primary)",
    color: "var(--md-sys-color-on-primary)",
    fill: "currentColor",
    ...typography.raw({ class: "label", size: "small" }),
    _hover: { filter: "brightness(1.1)" },
    _focusVisible: {
      outline: "2px solid var(--md-sys-color-on-surface)",
      outlineOffset: "2px",
    },
    _disabled: { cursor: "default", opacity: 0.7 },
  },
});
