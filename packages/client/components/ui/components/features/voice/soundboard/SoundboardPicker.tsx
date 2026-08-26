import { useFloating } from "solid-floating-ui";
import {
  Accessor,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Motion, Presence } from "solid-motionone";

import { flip, offset, shift } from "@floating-ui/dom";
import { Trans, useLingui } from "@lingui/solid/macro";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { SoundboardEntry, useSoundboardLibrary, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import {
  Button,
  IconButton,
  Slider,
  Text,
  TextField,
} from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Soundboard toggle for the call controls, together with the floating panel
 * it opens.
 */
export function SoundboardButton(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const { t } = useLingui();

  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [show, setShow] = createSignal(false);

  const enabled = () => voice.speakingPermission && !voice.deafen();

  function toggle() {
    if (!enabled()) return;
    const next = !show();
    setShow(next);
    // Publish the (silent) soundboard track now, so the first sound plays for
    // everyone the moment it is pressed rather than after a negotiation.
    if (next) voice.prepareSoundboard();
  }

  return (
    <>
      <span ref={setAnchor} style={{ display: "contents" }}>
        <IconButton
          size={props.size}
          variant={show() ? "filled" : "tonal"}
          onPress={toggle}
          isDisabled={!enabled()}
          use:floating={{
            tooltip: {
              placement: "top",
              content: !voice.speakingPermission
                ? t`Missing permission`
                : voice.deafen()
                  ? t`Undeafen to use the soundboard`
                  : t`Soundboard`,
            },
          }}
        >
          <Symbol>library_music</Symbol>
        </IconButton>
      </span>
      <Presence>
        <Show when={show()}>
          <Portal mount={document.getElementById("floating")!}>
            <Motion
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15, easing: [0.87, 0, 0.13, 1] }}
            >
              <SoundboardPanel anchor={anchor} onClose={() => setShow(false)} />
            </Motion>
          </Portal>
        </Show>
      </Presence>
    </>
  );
}

/**
 * The floating soundboard panel
 */
function SoundboardPanel(props: {
  anchor: Accessor<HTMLElement | undefined>;
  onClose: () => void;
}) {
  const voice = useVoice();
  const state = useState();
  const { t } = useLingui();
  const library = useSoundboardLibrary(voice.channel);

  const [floating, setFloating] = createSignal<HTMLDivElement>();
  const [adding, setAdding] = createSignal(false);

  const position = useFloating(() => props.anchor(), floating, {
    placement: "top",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  });

  function onMouseDown(e: MouseEvent) {
    const target = e.target as Node;
    if (floating()?.contains(target)) return;
    if (props.anchor()?.contains(target)) return;
    props.onClose();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose();
  }

  onMount(() => {
    addEventListener("mousedown", onMouseDown);
    addEventListener("keydown", onKeyDown);
  });

  onCleanup(() => {
    removeEventListener("mousedown", onMouseDown);
    removeEventListener("keydown", onKeyDown);
  });

  // Leaving the call closes the panel
  createEffect(() => {
    if (!voice.room()) props.onClose();
  });

  const playing = () => voice.soundboard()?.playing() ?? [];
  const isPlaying = (entry: SoundboardEntry) =>
    playing().some((s) => s.id === entry.id);

  return (
    <Base
      ref={setFloating}
      style={{
        position: position.strategy,
        top: `${position.y ?? 0}px`,
        left: `${position.x ?? 0}px`,
      }}
    >
      <Header>
        <Title>
          <Symbol size={20}>library_music</Symbol>
          <Text class="title" size="small">
            <Trans>Soundboard</Trans>
          </Text>
        </Title>
        <Spacer />
        <Show when={playing().length}>
          <IconButton
            size="xs"
            variant="standard"
            onPress={() => voice.stopSoundboard()}
            use:floating={{
              tooltip: { placement: "top", content: t`Stop my sounds` },
            }}
          >
            <Symbol size={20}>stop_circle</Symbol>
          </IconButton>
        </Show>
        <IconButton
          size="xs"
          variant="standard"
          onPress={() =>
            (state.voice.soundboardMuted = !state.voice.soundboardMuted)
          }
          use:floating={{
            tooltip: {
              placement: "top",
              content: state.voice.soundboardMuted
                ? t`Unmute soundboard`
                : t`Mute soundboard`,
            },
          }}
        >
          <Show
            when={state.voice.soundboardMuted}
            fallback={<Symbol size={20}>volume_up</Symbol>}
          >
            <Symbol size={20} color="var(--md-sys-color-error)">
              volume_off
            </Symbol>
          </Show>
        </IconButton>
        <Show when={library.channel() && library.canAdd()}>
          <IconButton
            size="xs"
            variant={adding() ? "filled" : "standard"}
            onPress={() => setAdding((v) => !v)}
            use:floating={{
              tooltip: { placement: "top", content: t`Add sound` },
            }}
          >
            <Symbol size={20}>add</Symbol>
          </IconButton>
        </Show>
      </Header>

      <VolumeRow>
        <Text class="label" size="small">
          <Trans>Soundboard volume</Trans>
        </Text>
        <Slider
          min={0}
          max={2}
          step={0.05}
          value={state.voice.soundboardVolume}
          onInput={(event) =>
            (state.voice.soundboardVolume = event.currentTarget.value)
          }
          labelFormatter={(label) => (label * 100).toFixed(0) + "%"}
        />
      </VolumeRow>

      <Show when={adding()}>
        <AddSoundForm
          onAdd={(file, name) => library.add(file, name)}
          onDone={() => setAdding(false)}
        />
      </Show>

      <Body>
        <Switch>
          <Match when={!library.channel()}>
            <Empty>
              <Symbol size={32}>music_off</Symbol>
              <Text class="body" size="small">
                <Show
                  when={voice.channel()?.server}
                  fallback={
                    <Trans>
                      The soundboard is only available in server voice channels.
                    </Trans>
                  }
                >
                  <Trans>
                    This server has no soundboard yet. Create a text channel
                    named <b>soundboard</b> — every audio file posted there
                    becomes a sound, and the message text is its name.
                  </Trans>
                </Show>
              </Text>
            </Empty>
          </Match>
          <Match when={library.error()}>
            <Empty>
              <Symbol size={32}>error</Symbol>
              <Text class="body" size="small">
                <Trans>Could not load the soundboard.</Trans>
              </Text>
              <Button
                size="xs"
                variant="tonal"
                onPress={() => library.refresh()}
              >
                <Trans>Retry</Trans>
              </Button>
            </Empty>
          </Match>
          <Match when={library.loading() && !library.sounds().length}>
            <Empty>
              <Text class="body" size="small">
                <Trans>Loading sounds…</Trans>
              </Text>
            </Empty>
          </Match>
          <Match when={!library.sounds().length}>
            <Empty>
              <Symbol size={32}>music_note</Symbol>
              <Text class="body" size="small">
                <Show
                  when={library.canAdd()}
                  fallback={
                    <Trans>
                      No sounds yet. Audio files posted in #soundboard show up
                      here.
                    </Trans>
                  }
                >
                  <Trans>
                    No sounds yet. Press + to upload one, or post audio files in
                    #soundboard.
                  </Trans>
                </Show>
              </Text>
            </Empty>
          </Match>
          <Match when={library.sounds().length}>
            <Grid>
              <For each={library.sounds()}>
                {(entry) => (
                  <SoundTile
                    entry={entry}
                    playing={isPlaying(entry)}
                    onPlay={() => voice.playSoundboard(entry)}
                    onRemove={
                      library.canRemove(entry)
                        ? () => library.remove(entry)
                        : undefined
                    }
                  />
                )}
              </For>
            </Grid>
          </Match>
        </Switch>
      </Body>
    </Base>
  );
}

/**
 * One sound in the grid
 */
function SoundTile(props: {
  entry: SoundboardEntry;
  playing: boolean;
  onPlay: () => void;
  onRemove?: () => void;
}) {
  const { t } = useLingui();
  const [confirm, setConfirm] = createSignal(false);

  return (
    <Tile
      playing={props.playing}
      onClick={() => props.onPlay()}
      title={props.entry.name}
    >
      <Symbol size={20} fill={props.playing}>
        {props.playing ? "graphic_eq" : "music_note"}
      </Symbol>
      <TileName>{props.entry.name}</TileName>
      <Show when={props.onRemove}>
        <span
          class={remove({ confirm: confirm() })}
          role="button"
          aria-label={t`Remove sound`}
          onClick={(e) => {
            e.stopPropagation();
            if (confirm()) {
              props.onRemove?.();
              setConfirm(false);
            } else {
              setConfirm(true);
              setTimeout(() => setConfirm(false), 2500);
            }
          }}
          use:floating={{
            tooltip: {
              placement: "top",
              content: confirm() ? t`Click again to remove` : t`Remove sound`,
            },
          }}
        >
          <Symbol size={14}>{confirm() ? "delete_forever" : "close"}</Symbol>
        </span>
      </Show>
    </Tile>
  );
}

/**
 * Inline "add a sound" form
 */
function AddSoundForm(props: {
  onAdd: (file: File, name: string) => Promise<void>;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const [file, setFile] = createSignal<File>();
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  let fileInput: HTMLInputElement | undefined;

  function pick(list: FileList | null) {
    const picked = list?.[0];
    setFile(picked);
    if (picked && !name().trim()) {
      setName(picked.name.replace(/\.[a-z0-9]+$/i, ""));
    }
  }

  async function submit() {
    const f = file();
    if (!f || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onAdd(f, name());
      props.onDone();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        onChange={(e) => pick(e.currentTarget.files)}
      />
      <Button
        size="xs"
        variant="tonal"
        onPress={() => fileInput?.click()}
        isDisabled={busy()}
      >
        <Symbol size={18}>upload_file</Symbol>
        {file() ? file()!.name : t`Choose audio file`}
      </Button>
      <TextField
        label={t`Sound name`}
        value={name()}
        disabled={busy()}
        onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
      />
      <FormActions>
        <Show when={error()}>
          <Text class="body" size="small">
            {error()}
          </Text>
        </Show>
        <Spacer />
        <Button
          size="xs"
          variant="text"
          onPress={props.onDone}
          isDisabled={busy()}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button
          size="xs"
          variant="filled"
          onPress={submit}
          isDisabled={!file() || busy()}
        >
          <Show when={busy()} fallback={<Trans>Add</Trans>}>
            <Trans>Uploading…</Trans>
          </Show>
        </Button>
      </FormActions>
    </Form>
  );
}

const Base = styled("div", {
  base: {
    zIndex: 100,
    width: "360px",
    maxWidth: "calc(100vw - 16px)",
    maxHeight: "min(480px, calc(100vh - 16px))",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",

    padding: "var(--gap-md)",
    userSelect: "none",

    borderRadius: "var(--borderRadius-lg)",
    color: "var(--md-sys-color-on-surface)",
    fill: "var(--md-sys-color-on-surface)",
    boxShadow: "0 0 3px var(--md-sys-color-shadow)",
    background: "var(--md-sys-color-surface-container)",
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
  },
});

const Title = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});

const Spacer = styled("div", {
  base: {
    flexGrow: 1,
  },
});

const VolumeRow = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    paddingInline: "var(--gap-xs)",
  },
});

const Body = styled("div", {
  base: {
    minHeight: "96px",
    overflowY: "auto",
    scrollbarWidth: "thin",
  },
});

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "var(--gap-sm)",
  },
});

const Tile = styled("button", {
  base: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-xs)",

    minHeight: "64px",
    padding: "var(--gap-sm)",
    cursor: "pointer",

    border: "none",
    borderRadius: "var(--borderRadius-md)",
    color: "var(--md-sys-color-on-secondary-container)",
    fill: "var(--md-sys-color-on-secondary-container)",
    background: "var(--md-sys-color-secondary-container)",
    transition: "var(--transitions-fast) all",

    _hover: {
      filter: "brightness(1.1)",
    },
    _active: {
      transform: "scale(0.97)",
    },
  },
  variants: {
    playing: {
      true: {
        color: "var(--md-sys-color-on-primary)",
        fill: "var(--md-sys-color-on-primary)",
        background: "var(--md-sys-color-primary)",
      },
    },
  },
});

const TileName = styled("span", {
  base: {
    maxWidth: "100%",
    fontSize: "12px",
    fontWeight: 500,
    lineHeight: 1.2,
    textAlign: "center",
    overflow: "hidden",
    lineClamp: 2,
    wordBreak: "break-word",
  },
});

const remove = cva({
  base: {
    position: "absolute",
    top: "2px",
    right: "2px",
    display: "grid",
    placeItems: "center",
    width: "18px",
    height: "18px",
    borderRadius: "var(--borderRadius-full)",
    opacity: 0,
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface)",
    fill: "var(--md-sys-color-on-surface)",
    transition: "var(--transitions-fast) all",

    "button:hover &": {
      opacity: 1,
    },
  },
  variants: {
    confirm: {
      true: {
        opacity: 1,
        background: "var(--md-sys-color-error)",
        color: "var(--md-sys-color-on-error)",
        fill: "var(--md-sys-color-on-error)",
      },
    },
  },
});

const Empty = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-sm)",
    minHeight: "96px",
    padding: "var(--gap-md)",
    textAlign: "center",
    color: "var(--md-sys-color-on-surface-variant)",
    fill: "var(--md-sys-color-on-surface-variant)",
  },
});

const Form = styled("form", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-high)",
  },
});

const FormActions = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});
