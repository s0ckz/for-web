import { Accessor } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { useIsSpeaking } from "solid-livekit-components";

import { Participant } from "livekit-client";

/**
 * Client-side speaking detection.
 *
 * LiveKit's own `isSpeaking` comes from the SFU's speaker updates, which are
 * batched at roughly 400ms and then smoothed -- fine for "who is talking", far
 * too slow for the ring around a tile, which visibly lags the audio.
 *
 * This meters the actual audio tracks locally instead: one shared AudioContext,
 * one interval for every participant, and an AnalyserNode per track.
 */

/** How often every registered meter is sampled */
const POLL_MS = 50;

/** RMS level above which we call it speech */
const SPEAKING_DBFS = -40;

/** How long the indicator stays lit after the last loud sample */
const RELEASE_MS = 400;

type Meter = {
  identity: string;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  lastLoud: number;
};

const meters = new Map<string, Meter>();

const [speaking, setSpeaking] = createStore<Record<string, boolean>>({});

let context: AudioContext | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Shared AudioContext.
 *
 * Kept for the lifetime of the page rather than closed with the last meter:
 * the track references are rebuilt on every room event, so meters churn, and
 * browsers cap how many AudioContexts may exist at once. It is suspended
 * while nothing is being metered instead.
 */
function audioContext(): AudioContext {
  if (!context) context = new AudioContext();
  if (context.state === "suspended") context.resume().catch(() => {});
  return context;
}

/**
 * Sample every registered meter
 */
function tick() {
  const now = performance.now();

  for (const meter of meters.values()) {
    meter.analyser.getFloatTimeDomainData(meter.buffer);

    let sum = 0;
    for (let i = 0; i < meter.buffer.length; i++) {
      sum += meter.buffer[i] * meter.buffer[i];
    }

    const rms = Math.sqrt(sum / meter.buffer.length);
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

    if (dbfs > SPEAKING_DBFS) meter.lastLoud = now;

    const loud = now - meter.lastLoud < RELEASE_MS;
    if (speaking[meter.identity] !== loud) setSpeaking(meter.identity, loud);
  }
}

/**
 * Disconnect a meter's audio graph
 */
function teardown(meter: Meter) {
  try {
    meter.source.disconnect();
    meter.analyser.disconnect();
  } catch {
    /* already gone */
  }
}

/**
 * Start metering a participant's audio track.
 *
 * Registering a second meter for the same identity replaces the first, so a
 * restarted or republished microphone does not leave a dead analyser behind.
 * @param identity Participant identity
 * @param track Microphone media stream track
 * @returns Disposer
 */
export function registerSpeakingMeter(
  identity: string,
  track: MediaStreamTrack,
): () => void {
  let meter: Meter;

  try {
    const ctx = audioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0;

    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(analyser);

    meter = {
      identity,
      source,
      analyser,
      buffer: new Float32Array(analyser.fftSize),
      lastLoud: 0,
    };
  } catch (err) {
    // Audio metering is a nicety; falling back to the server flag is fine.
    console.warn("[rtc] could not meter audio for", identity, err);
    return () => {};
  }

  const previous = meters.get(identity);
  if (previous) teardown(previous);

  meters.set(identity, meter);
  setSpeaking(identity, false);

  if (!timer) timer = setInterval(tick, POLL_MS);

  return () => {
    // A newer meter for this identity has already taken over
    if (meters.get(identity) !== meter) return;

    teardown(meter);
    meters.delete(identity);
    setSpeaking(
      produce((state) => {
        delete state[identity];
      }),
    );

    if (!meters.size) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }

      context?.suspend().catch(() => {});
    }
  };
}

/**
 * Whether a participant is speaking, measured locally where possible.
 *
 * Falls back to LiveKit's server-derived flag for anyone without a meter --
 * a participant whose track we have not subscribed to, for instance.
 * @param participant Participant
 * @returns Accessor
 */
export function useIsSpeakingFast(participant: Participant): Accessor<boolean> {
  const fallback = useIsSpeaking(participant);

  return () => {
    const measured = speaking[participant.identity];
    return measured === undefined ? fallback() : measured;
  };
}
