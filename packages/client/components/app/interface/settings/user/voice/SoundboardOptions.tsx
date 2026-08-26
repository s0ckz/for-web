import { Trans } from "@lingui/solid/macro";

import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Slider, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Soundboard playback options
 */
export function SoundboardOptions() {
  const { voice } = useState();

  return (
    <Column>
      <Text class="title">
        <Trans>Soundboard</Trans>
      </Text>
      <Column>
        <Text class="label">
          <Trans>Soundboard Volume</Trans>
        </Text>
        <Slider
          min={0}
          max={2}
          step={0.05}
          value={voice.soundboardVolume}
          onInput={(event) =>
            (voice.soundboardVolume = event.currentTarget.value)
          }
          labelFormatter={(label) => (label * 100).toFixed(0) + "%"}
        />
      </Column>
      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>music_off</Symbol>}
          description={
            <Trans>
              Stop hearing soundboard sounds from everyone. You can also mute a
              single person's soundboard from their context menu.
            </Trans>
          }
          action={<Checkbox checked={voice.soundboardMuted} />}
          onClick={() => (voice.soundboardMuted = !voice.soundboardMuted)}
        >
          <Trans>Mute Soundboard</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
