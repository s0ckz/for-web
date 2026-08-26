import {
  Accessor,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { Channel, Message } from "stoat.js";

import { useClient } from "@revolt/client";
import { useInstance } from "@revolt/instance";

import { SoundboardSound } from "./soundboard";

/**
 * Name of the text channel that acts as a server's soundboard library.
 *
 * There is no per-server storage in the API we could put a sound list in, so
 * the library is simply "every audio attachment posted in #soundboard".
 * The message text is the sound's name; permissions come from the channel.
 */
export const SOUNDBOARD_CHANNEL_NAME = "soundboard";

/**
 * How many messages to look back through for sounds
 */
const FETCH_LIMIT = 100;

/**
 * A sound together with the message it came from
 */
export interface SoundboardEntry extends SoundboardSound {
  message: Message;
}

export interface SoundboardLibrary {
  /** The soundboard channel of the current server, if any */
  channel: Accessor<Channel | undefined>;
  /** Sounds available, oldest first */
  sounds: Accessor<SoundboardEntry[]>;
  /** Whether the initial fetch is still running */
  loading: Accessor<boolean>;
  /** Error from the last fetch, if any */
  error: Accessor<unknown>;
  /** Whether we can add sounds to the library */
  canAdd: Accessor<boolean>;
  /** Whether we can remove a given sound */
  canRemove: (entry: SoundboardEntry) => boolean;
  /** Fetch the sound list again */
  refresh: () => Promise<void>;
  /** Upload an audio file and post it as a new sound */
  add: (file: File, name: string) => Promise<void>;
  /** Delete a sound (its message) */
  remove: (entry: SoundboardEntry) => Promise<void>;
}

/**
 * Find the soundboard channel of a server
 */
export function findSoundboardChannel(channel?: Channel): Channel | undefined {
  return channel?.server?.channels.find(
    (c) =>
      c.type === "TextChannel" &&
      c.name.trim().toLowerCase() === SOUNDBOARD_CHANNEL_NAME,
  );
}

/**
 * Whether an attachment is something we can play
 */
function isAudioFile(file: {
  metadata: { type: string };
  contentType?: string;
}) {
  return (
    file.metadata.type === "Audio" ||
    (file.contentType?.startsWith("audio/") ?? false)
  );
}

/**
 * Turn a message into zero or more sounds
 */
function soundsFromMessage(message: Message): SoundboardEntry[] {
  const files = message.attachments?.filter(isAudioFile) ?? [];
  if (!files.length) return [];

  const content = message.content?.trim().split("\n")[0]?.trim() ?? "";

  return files.map((file) => ({
    id: file.id,
    // The message text names the sound; multiple attachments in one message
    // fall back to their filenames so they stay distinguishable.
    name:
      (files.length === 1 && content) ||
      file.filename?.replace(/\.[a-z0-9]+$/i, "") ||
      content ||
      "Sound",
    url: file.originalUrl,
    message,
  }));
}

/**
 * Reactive access to a voice channel's server soundboard library
 * @param voiceChannel The channel of the call we are in
 */
export function useSoundboardLibrary(
  voiceChannel: Accessor<Channel | undefined>,
): SoundboardLibrary {
  const client = useClient();
  const instance = useInstance();

  const channel = createMemo(() => findSoundboardChannel(voiceChannel()));

  const [messages, setMessages] = createSignal<Message[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<unknown>();

  let generation = 0;

  async function refresh() {
    const target = channel();
    const current = ++generation;

    if (!target) {
      setMessages([]);
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const fetched = await target.fetchMessages({ limit: FETCH_LIMIT });
      if (current !== generation) return;
      // API returns newest first; show oldest first so the grid is stable
      setMessages(fetched.reverse());
    } catch (e) {
      if (current !== generation) return;
      setError(e);
    } finally {
      if (current === generation) setLoading(false);
    }
  }

  // Refetch whenever the soundboard channel changes
  createEffect(on(channel, () => void refresh()));

  // Keep the list live while the panel is open
  createEffect(() => {
    const target = channel();
    if (!target) return;

    const c = client();

    const onCreate = (message: Message) => {
      if (message.channelId !== target.id) return;
      setMessages((list) =>
        list.some((m) => m.id === message.id) ? list : [...list, message],
      );
    };

    const onDelete = (message: { id: string; channelId?: string }) => {
      if (message.channelId && message.channelId !== target.id) return;
      setMessages((list) => list.filter((m) => m.id !== message.id));
    };

    const onUpdate = (message: Message) => {
      if (message.channelId !== target.id) return;
      // names come from message content; force a re-read
      setMessages((list) => [...list]);
    };

    c.on("messageCreate", onCreate);
    c.on("messageDelete", onDelete);
    c.on("messageUpdate", onUpdate);

    onCleanup(() => {
      c.off("messageCreate", onCreate);
      c.off("messageDelete", onDelete);
      c.off("messageUpdate", onUpdate);
    });
  });

  const sounds = createMemo(() => messages().flatMap(soundsFromMessage));

  const canAdd = () =>
    !!channel()?.havePermission("SendMessage") &&
    !!channel()?.havePermission("UploadFiles");

  const canRemove = (entry: SoundboardEntry) =>
    entry.message.authorId === client().user?.id ||
    !!channel()?.havePermission("ManageMessages");

  async function add(file: File, name: string) {
    const target = channel();
    if (!target) throw new Error("No soundboard channel");

    const body = new FormData();
    body.set("file", file);

    const [authHeader, authHeaderValue] = client().authenticationHeader;
    const response = await fetch(`${instance.mediaUrl}/attachments`, {
      method: "POST",
      headers: { [authHeader]: authHeaderValue },
      body,
    });

    if (!response.ok) {
      throw new Error(`Upload failed (${response.status})`);
    }

    const { id } = (await response.json()) as { id: string };

    await target.sendMessage({
      content: name.trim() || file.name.replace(/\.[a-z0-9]+$/i, ""),
      attachments: [id],
    });
  }

  async function remove(entry: SoundboardEntry) {
    await entry.message.delete();
  }

  return {
    channel,
    sounds,
    loading,
    error,
    canAdd,
    canRemove,
    refresh,
    add,
    remove,
  };
}
