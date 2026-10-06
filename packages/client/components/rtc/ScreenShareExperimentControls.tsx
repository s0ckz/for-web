import { Trans } from "@lingui/solid/macro";
import { createSignal, Show } from "solid-js";

import { CategoryButton, Column, Text } from "@revolt/ui";

import {
  screenShareExperiment,
  screenShareExperimentsEnabled,
} from "./screenShareExperiments";

const enabled = screenShareExperimentsEnabled(
  import.meta.env.DEV,
  import.meta.env.VITE_SCREEN_SHARE_TEST_CONTROLS,
  typeof window === "undefined" ? "" : window.location.hostname,
);
// Page memory only. A running share keeps its own snapshot until it ends.
const [codec, setCodec] = createSignal("auto");
const [bitrate, setBitrate] = createSignal("default");

export function getScreenShareExperiment() {
  return screenShareExperiment(enabled, codec(), Number(bitrate()));
}

/** Offered before capture starts, never as a live quality/codec switch. */
export function ScreenShareExperimentControls() {
  return (
    <Show when={enabled}>
      <Column>
        <Text class="title">
          <Trans>Screen share performance test</Trans>
        </Text>
        <Text>
          <Trans>
            Applies to the next share. Unsupported codecs still fall back
            automatically.
          </Trans>
        </Text>
        <CategoryButton.Group>
          <CategoryButton.Select
            icon="blank"
            title={<Trans>Preferred test codec</Trans>}
            value={codec()}
            onUpdate={setCodec}
            options={{
              auto: { title: <Trans>Automatic</Trans> },
              h264: { title: "H.264" },
              h265: { title: "H.265" },
            }}
          />
          <CategoryButton.Select
            icon="blank"
            title={<Trans>Test bitrate ceiling</Trans>}
            value={bitrate()}
            onUpdate={setBitrate}
            options={{
              default: { title: <Trans>Preset default</Trans> },
              "4500000": { title: "4.5 Mbps" },
              "6000000": { title: "6 Mbps" },
              "8000000": { title: "8 Mbps" },
            }}
          />
        </CategoryButton.Group>
      </Column>
    </Show>
  );
}
