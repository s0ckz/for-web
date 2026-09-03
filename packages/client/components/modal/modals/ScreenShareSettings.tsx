import { Trans, useLingui } from "@lingui/solid/macro";
import { createFormControl, createFormGroup } from "solid-forms";

import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";
import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";
import { VideoTrack } from "solid-livekit-components";

import { Show } from "solid-js";
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

  const group = createFormGroup({
    qualityName: createFormControl<ScreenShareQualityName>(initialQualityName, {
      required: true,
    }),
    audio: createFormControl(
      props.audio && (props.initialAudio ?? voice.screenShareAudio),
      { disabled: !props.audio },
    ),
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
          <Show when={props.audio}>
            <Form2.Checkbox control={group.controls.audio}>
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
              <Trans>Audio disabled by browser</Trans>
            </small>
          </Show>
        </Column>
      </form>
    </Dialog>
  );
}
