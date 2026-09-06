import { Trans, useLingui } from "@lingui/solid/macro";
import { createFormControl, createFormGroup } from "solid-forms";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";
import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";
import { VideoTrack } from "solid-livekit-components";

import { Show, createUniqueId } from "solid-js";
import { Modals } from "../types";

export function ScreenShareSettingsModal(
  props: DialogProps & Modals & { type: "screen_share_settings" },
) {
  const { voice } = useState();
  const { t } = useLingui();

  // Seed from the offered list, not blindly from the saved setting: the
  // saved quality can be "high" while this instance's video_resolution
  // limit only offers "low", which used to leave the button group's value
  // matching no button.
  //
  // `props.initialQualityName` -- what this share actually started with --
  // takes priority over the saved default when given. Editing a share
  // already running has to seed from that, not the saved setting: the two
  // can disagree (a desktop-picker choice made at share start, or an
  // earlier edit), and seeding from the saved default here would silently
  // revert the live share back to it the moment "Save" is pressed without
  // touching anything.
  const initialQualityName =
    props.qualities.find(
      (q) => q.name === (props.initialQualityName ?? voice.screenShareQuality),
    )?.name ??
    props.qualities[0]?.name ??
    "low";

  // A confirmed `"leak"` (the whole machine's audio) starts this checkbox
  // unticked regardless of the saved default or a live-edit's current
  // value -- the user can still turn it on, but the *default* stops being
  // "yes, broadcast everything". Anything short of that (no risk, or the
  // merely provisional `"caution"`) keeps the existing seeding behaviour.
  const initialAudioValue =
    props.surfaceRisk === "leak"
      ? false
      : (props.initialAudio ?? voice.screenShareAudio);

  // Only actually referenced (via `aria-describedby` below) while the
  // warning is shown, but it costs nothing to always have one ready.
  const warningId = createUniqueId();
  const hasWarning = () =>
    props.surfaceRisk === "leak" || props.surfaceRisk === "caution";

  const group = createFormGroup({
    qualityName: createFormControl<ScreenShareQualityName>(initialQualityName, {
      required: true,
    }),
    audio: createFormControl(props.audio && initialAudioValue, {
      disabled: !props.audio,
    }),
    dontAsk: createFormControl(false),
  });

  async function onSubmit() {
    if (group.controls.dontAsk.value) {
      voice.screenShareQuality = group.controls.qualityName.value;
      voice.screenShareQualityAsk = false;
      voice.screenShareAudio = group.controls.audio.value;
    }

    props.callback(
      group.controls.qualityName.value,
      group.controls.audio.value && props.audio,
    );
    props.onClose();
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={() => {
        props.onCancel();
        props.onClose();
      }}
      title={t`Screen Share Settings`}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          // "Go" reads like starting a share, which this isn't when editing
          // one already running.
          text: props.liveEdit ? <Trans>Save</Trans> : <Trans>Go</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
        },
      ]}
    >
      <VideoTrack
        trackRef={props.trackReference}
        style={{
          padding: "var(--gap-md)",
          "border-radius": "var(--borderRadius-lg)",
          "max-height": "400px",
          "justify-self": "center",
        }}
      />
      <form onSubmit={submit}>
        <Column>
          <Form2.ButtonGroup
            control={group.controls.qualityName}
            buttonDefinitions={props.qualities.map((quality) => {
              return {
                children: quality.fullName,
                value: quality.name,
              };
            })}
          />
          {/* This browser cannot isolate the captured audio to just this
              screen/window (no web API exposes per-application capture or
              exclusion) -- so a `"leak"` or `"caution"` classification gets
              a warning here rather than a silent default. `"leak"` is a
              confirmed whole-machine capture (a monitor share with an
              audio track); `"caution"` covers everything less certain
              (a window share, or an unrecognised surface) -- see
              screenShareSurface.ts's risk table for why those are kept
              apart rather than both leaking or both warning.

              `role="alert"` for `"leak"` (an assertive interruption fits a
              confirmed whole-machine capture); `role="status"` for the
              merely provisional `"caution"`, which does not warrant
              interrupting. Nothing else in this repo uses `role="alert"`
              today -- this is the first, deliberately, for a warning that
              is the worst place to be color-only. `aria-describedby` on
              the audio checkbox below associates it with whichever of
              these is showing. */}
          <Show
            when={
              props.surfaceRisk === "leak" || props.surfaceRisk === "caution"
            }
          >
            <Warning
              risk={props.surfaceRisk!}
              id={warningId}
              role={props.surfaceRisk === "leak" ? "alert" : "status"}
            >
              <Show
                when={props.surfaceRisk === "leak"}
                fallback={
                  <Trans>
                    This may include audio from other apps on your device, not
                    just this screen.
                  </Trans>
                }
              >
                <Trans>
                  This shares everything you can hear, including other calls.
                  Leave audio off to share silently, or use the desktop app to
                  share a single app's audio.
                </Trans>
              </Show>
            </Warning>
          </Show>
          <Show when={props.audio}>
            <Form2.Checkbox
              control={group.controls.audio}
              aria-describedby={hasWarning() ? warningId : undefined}
            >
              <Trans>Share audio</Trans>
            </Form2.Checkbox>
          </Show>
          {/* Writes global "always ask at share start" settings (see
              onSubmit) -- only offered at share start, not while editing a
              share already running. */}
          <Show when={!props.liveEdit}>
            <Form2.Checkbox control={group.controls.dontAsk}>
              <Trans>Don't ask me again</Trans>
            </Form2.Checkbox>
          </Show>
          <Show when={!props.audio}>
            <small>
              <Show
                when={props.displaySurface === "window"}
                fallback={<Trans>Audio disabled by browser</Trans>}
              >
                <Trans>This share did not include audio</Trans>
              </Show>
            </small>
          </Show>
        </Column>
      </form>
    </Dialog>
  );
}

// `"leak"` reuses the error palette (a confirmed whole-machine capture);
// `"caution"` reuses the tertiary palette (everything less certain -- see
// screenShareSurface.ts's risk table). Local to this file, following
// ScreenSharePicker.tsx's convention, rather than a new shared component
// for a single use.
const Warning = styled("div", {
  base: {
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-sm)",
    fontSize: "0.875rem",
  },
  variants: {
    risk: {
      leak: {
        color: "var(--md-sys-color-error)",
        background: "var(--md-sys-color-error-container)",
      },
      caution: {
        color: "var(--md-sys-color-tertiary)",
        background: "var(--md-sys-color-tertiary-container)",
      },
      none: {},
    },
  },
});
