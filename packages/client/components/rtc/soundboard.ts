import { Accessor, createSignal, onCleanup } from "solid-js";

import {
  AudioPresets,
  LocalTrackPublication,
  Participant,
  ParticipantEvent,
  Room,
  Track,
  TrackPublication,
} from "livekit-client";

/**
 * Name of the LiveKit track carrying soundboard audio.
 *
 * The backend only lets us publish `microphone` (and, with the Video
 * permission, camera / screen share) sources and never grants
 * `can_publish_data`, so soundboard sounds travel as a *second* microphone
 * track that is told apart from the real one purely by its name.
 */
export const SOUNDBOARD_TRACK_NAME = "soundboard";

/**
 * Whether a publication is the soundboard track
 */
export function isSoundboardPublication(pub?: TrackPublication | null) {
  return !!pub && pub.trackName === SOUNDBOARD_TRACK_NAME;
}

/**
 * Find a participant's real microphone publication, ignoring the soundboard
 * track (which is also published with the microphone source).
 */
export function getMicPublication(
  participant: Participant,
): TrackPublication | undefined {
  for (const pub of participant.audioTrackPublications.values()) {
    if (pub.source === Track.Source.Microphone && !isSoundboardPublication(pub))
      return pub;
  }
  return undefined;
}

/**
 * Whether the participant currently has the soundboard track published
 */
export function hasSoundboardPublication(participant: Participant) {
  for (const pub of participant.audioTrackPublications.values()) {
    if (isSoundboardPublication(pub)) return true;
  }
  return false;
}

const MIC_EVENTS = [
  ParticipantEvent.TrackMuted,
  ParticipantEvent.TrackUnmuted,
  ParticipantEvent.TrackPublished,
  ParticipantEvent.TrackUnpublished,
  ParticipantEvent.TrackSubscribed,
  ParticipantEvent.TrackUnsubscribed,
  ParticipantEvent.LocalTrackPublished,
  ParticipantEvent.LocalTrackUnpublished,
] as const;

/**
 * Soundboard-aware replacement for `useIsMuted({ source: Microphone })`.
 *
 * `useIsMuted` picks the first microphone-source publication, which may be the
 * soundboard track — a user who joined muted would then look unmuted for as
 * long as it exists.
 */
export function useIsMicMuted(participant: Participant): Accessor<boolean> {
  const compute = () => getMicPublication(participant)?.isMuted ?? true;
  const [muted, setMuted] = createSignal(compute());
  const update = () => setMuted(compute());

  for (const event of MIC_EVENTS) participant.on(event, update);
  onCleanup(() => {
    for (const event of MIC_EVENTS) participant.off(event, update);
  });

  return muted;
}

/**
 * A sound that can be played through the soundboard
 */
export interface SoundboardSound {
  /** Stable id (the attachment id) */
  id: string;
  /** Display name */
  name: string;
  /** URL of the audio file */
  url: string;
}

type PlayingSound = {
  sound: SoundboardSound;
  source: AudioBufferSourceNode;
};

/**
 * Sender side of the soundboard.
 *
 * Decodes sounds with Web Audio and plays them into a MediaStream destination
 * that is published to LiveKit as the soundboard track, while also monitoring
 * them locally so the person who pressed the button hears them too.
 */
export class SoundboardPlayer {
  #room: Room;
  #context?: AudioContext;
  #destination?: MediaStreamAudioDestinationNode;
  #monitor?: GainNode;
  #publication?: LocalTrackPublication;
  #publishing?: Promise<LocalTrackPublication | undefined>;
  #buffers = new Map<string, Promise<AudioBuffer>>();
  #playing = new Set<PlayingSound>();
  #monitorVolume = 1;
  #sinkId?: string;

  playing: Accessor<SoundboardSound[]>;
  #setPlaying: (sounds: SoundboardSound[]) => void;

  constructor(room: Room) {
    this.#room = room;
    const [playing, setPlaying] = createSignal<SoundboardSound[]>([]);
    this.playing = playing;
    this.#setPlaying = setPlaying;
  }

  /**
   * Whether the soundboard track has been published in this call
   */
  get published() {
    return !!this.#publication;
  }

  #ensureContext() {
    if (this.#context) return this.#context;

    const context = new AudioContext({ sampleRate: 48000 });
    this.#context = context;

    this.#destination = context.createMediaStreamDestination();
    this.#destination.channelCount = 2;

    this.#monitor = context.createGain();
    this.#monitor.gain.value = this.#monitorVolume;
    this.#monitor.connect(context.destination);

    if (this.#sinkId !== undefined) this.#applySink();

    return context;
  }

  /**
   * Publish the soundboard track if it is not published yet.
   *
   * Idempotent; safe to call every time the panel opens. The track stays up
   * for the rest of the call — while idle it carries silence, which DTX turns
   * into (almost) nothing on the wire.
   */
  ensurePublished(): Promise<LocalTrackPublication | undefined> {
    if (this.#publication) return Promise.resolve(this.#publication);
    if (this.#publishing) return this.#publishing;

    this.#ensureContext();
    const track = this.#destination!.stream.getAudioTracks()[0];

    this.#publishing = this.#room.localParticipant
      .publishTrack(track, {
        name: SOUNDBOARD_TRACK_NAME,
        source: Track.Source.Microphone,
        dtx: true,
        red: true,
        forceStereo: true,
        audioPreset: AudioPresets.musicStereo,
        stopMicTrackOnMute: false,
      })
      .then((pub) => {
        this.#publication = pub;
        return pub;
      })
      .finally(() => {
        this.#publishing = undefined;
      });

    return this.#publishing;
  }

  /**
   * Fetch and decode a sound, caching the result for the rest of the call
   */
  #load(sound: SoundboardSound): Promise<AudioBuffer> {
    let buffer = this.#buffers.get(sound.id);
    if (!buffer) {
      buffer = fetch(sound.url)
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to fetch sound (${res.status})`);
          return res.arrayBuffer();
        })
        .then((data) => this.#ensureContext().decodeAudioData(data));

      // don't cache failures
      buffer.catch(() => this.#buffers.delete(sound.id));
      this.#buffers.set(sound.id, buffer);
    }
    return buffer;
  }

  /**
   * Warm the cache for a sound without playing it
   */
  preload(sound: SoundboardSound) {
    this.#load(sound).catch(() => {});
  }

  /**
   * Play a sound for everyone in the call (and locally)
   */
  async play(sound: SoundboardSound) {
    const context = this.#ensureContext();
    if (context.state !== "running") await context.resume();

    const [buffer] = await Promise.all([
      this.#load(sound),
      this.ensurePublished(),
    ]);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#destination!);
    source.connect(this.#monitor!);

    const entry: PlayingSound = { sound, source };
    this.#playing.add(entry);
    this.#emitPlaying();

    source.onended = () => {
      source.disconnect();
      this.#playing.delete(entry);
      this.#emitPlaying();
    };

    source.start();
  }

  /**
   * Stop every sound we are currently playing
   */
  stopAll() {
    for (const entry of [...this.#playing]) {
      try {
        entry.source.stop();
      } catch {
        // already stopped
      }
    }
  }

  #emitPlaying() {
    this.#setPlaying([...this.#playing].map((entry) => entry.sound));
  }

  /**
   * Set how loud we hear our own sounds (0 mutes local monitoring only)
   */
  setMonitorVolume(volume: number) {
    this.#monitorVolume = volume;
    if (this.#monitor && this.#context) {
      this.#monitor.gain.setTargetAtTime(
        volume,
        this.#context.currentTime,
        0.01,
      );
    }
  }

  /**
   * Route local monitoring to the chosen output device
   */
  setSinkId(sinkId: string | undefined) {
    this.#sinkId = sinkId;
    if (this.#context) this.#applySink();
  }

  #applySink() {
    const context = this.#context as AudioContext & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    if (typeof context.setSinkId !== "function") return;
    context.setSinkId(this.#sinkId ?? "").catch(() => {});
  }

  /**
   * Tear everything down; the room is expected to be disconnecting
   */
  dispose() {
    this.stopAll();
    this.#buffers.clear();

    const pub = this.#publication;
    this.#publication = undefined;
    if (pub?.track) {
      this.#room.localParticipant.unpublishTrack(pub.track).catch(() => {});
    }

    this.#context?.close().catch(() => {});
    this.#context = undefined;
    this.#destination = undefined;
    this.#monitor = undefined;
  }
}
