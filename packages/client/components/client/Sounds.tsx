import { createContext, JSXElement, useContext } from "solid-js";

import { Sounds, TypeSounds, useState } from "@revolt/state";
import deafenSound from "../../public/assets/sounds/deafen.ogg";
import messageSound from "../../public/assets/sounds/message_sound.ogg";
import muteSound from "../../public/assets/sounds/mute.ogg";
import ringtoneIncomingSound from "../../public/assets/sounds/ringtone_incoming.ogg";
import ringtoneOutgoingSound from "../../public/assets/sounds/ringtone_outgoing.ogg";
import streamEndSound from "../../public/assets/sounds/stream_end.ogg";
import streamStartSound from "../../public/assets/sounds/stream_start.ogg";
import streamViewerJoinSound from "../../public/assets/sounds/stream_viewer_join.ogg";
import streamViewerLeaveSound from "../../public/assets/sounds/stream_viewer_leave.ogg";
import undeafenSound from "../../public/assets/sounds/undeafen.ogg";
import unmuteSound from "../../public/assets/sounds/unmute.ogg";
import userJoinVoiceSound from "../../public/assets/sounds/user_join_voice.ogg";
import userLeaveVoiceSound from "../../public/assets/sounds/user_leave_voice.ogg";
import userMovedSound from "../../public/assets/sounds/user_moved.ogg";
// Leaf module with no imports of its own, so reaching into rtc/ from here
// introduces no cycle -- `@revolt/rtc` imports this file, not vice versa.
import { perceptualGain } from "../rtc/volume";

/**
 * The slice of voice settings notification sounds need to respect.
 *
 * Deliberately structural rather than the `Voice` store class itself: that
 * class is not re-exported from `@revolt/state`, and this only ever reads
 * two values, so a narrow shape keeps the coupling honest.
 */
type OutputSettings = {
  readonly preferredAudioOutputDevice: string | undefined;
  readonly outputVolume: number;
};

/**
 * A controller class for making sure sounds are managed in one place and to prevent undesirable sound overlaps
 */
export class SoundController {
  readonly soundState: Sounds;

  readonly outputSettings: OutputSettings;

  node?: HTMLAudioElement;

  lastPlayedSound?: keyof TypeSounds;

  constructor(soundState: Sounds, outputSettings: OutputSettings) {
    this.soundState = soundState;
    this.outputSettings = outputSettings;

    this.isPlaying = this.isPlaying.bind(this);
    this.canPlay = this.canPlay.bind(this);
    this.playSound = this.playSound.bind(this);
  }

  /**
   * Get whether a sound is currently being played by the sound controller
   *
   * NOTE: this used to read `this.node?.paused ?? false`, which is inverted --
   * that returns `true` when the node is *paused*, i.e. exactly backwards.
   * It has been inert until now because both branches of `canPlay` return
   * `true` regardless of this value, so fixing the inversion here changes
   * nothing observable yet. Left in place (rather than "optimised" away) so
   * the sound-collision check in `canPlay` has a correct signal to read if
   * it is ever tightened.
   *
   * @returns Whether a sound is currently playing
   */
  isPlaying(): boolean {
    return this.node ? !this.node.paused : false;
  }

  /**
   * Get whether a sound can be played right now
   *
   * @param newSound Sound to check for playability
   * @returns Whether the sound passed is playable currently
   */
  canPlay(newSound: keyof TypeSounds): boolean {
    // Never let a sound turned off play
    if (!this.soundState.enabled(newSound)) {
      return false;
    }

    // Always let the sound play if nothing is currently playing
    if (!this.isPlaying()) {
      return true;
    }

    // If there are any cases where you don't want sound collisions, put them here.
    // None for now.
    return true;
  }

  /**
   * Play a sound, following the rules of sound playability unless force is true
   *
   * Logs diagnostics for every outcome so playback failures are never silent:
   * suppression (canPlay() false) and a rejected play() promise are genuine
   * faults and go to console.error so they reach app-audio.log in the
   * Electron shell (which only forwards error-level and above); a
   * successful dispatch is normal operation and goes to console.debug only.
   *
   * @param sound The sound to play
   * @param force Bypass canPlay check
   * @returns Whether the sound played
   */
  playSound(sound: keyof TypeSounds, force?: boolean): boolean {
    if (!force && !this.canPlay(sound)) {
      // Distinguish the two ways a sound gets suppressed, because only one
      // of them is a fault:
      //
      //  `false`     -- the user turned this sound off in settings. Routine;
      //                 logging it at error level would spam app-audio.log
      //                 on every message for anyone who dislikes the chime.
      //  `undefined` -- `enabled()` is `return this.get()[t]` with no
      //                 fallback, so a persisted `sounds` store written
      //                 before this key existed reads as undefined and
      //                 silently disables a sound the user never touched
      //                 (and whose settings checkbox renders unticked).
      //                 That is a real bug and needs to reach the log.
      const enabled = this.soundState.enabled(sound);
      const message = `[sound] suppressed "${sound}": enabled = ${String(enabled)}`;

      if (enabled === false) {
        console.debug(message);
      } else {
        console.error(`${message} (expected a boolean -- stale sounds store?)`);
      }

      return false;
    }
    switch (sound) {
      case "deafen": {
        this.node = new Audio(deafenSound);
        break;
      }
      case "message": {
        this.node = new Audio(messageSound);
        break;
      }
      case "mute": {
        this.node = new Audio(muteSound);
        break;
      }
      case "ringtoneIncoming": {
        this.node = new Audio(ringtoneIncomingSound);
        break;
      }
      case "ringtoneOutgoing": {
        this.node = new Audio(ringtoneOutgoingSound);
        break;
      }
      case "streamEnd": {
        this.node = new Audio(streamEndSound);
        break;
      }
      case "streamStart": {
        this.node = new Audio(streamStartSound);
        break;
      }
      case "streamViewerJoin": {
        this.node = new Audio(streamViewerJoinSound);
        break;
      }
      case "streamViewerLeave": {
        this.node = new Audio(streamViewerLeaveSound);
        break;
      }
      case "undeafen": {
        this.node = new Audio(undeafenSound);
        break;
      }
      case "unmute": {
        this.node = new Audio(unmuteSound);
        break;
      }
      case "userJoinVoice": {
        this.node = new Audio(userJoinVoiceSound);
        break;
      }
      case "userLeaveVoice": {
        this.node = new Audio(userLeaveVoiceSound);
        break;
      }
      case "userMoved": {
        this.node = new Audio(userMovedSound);
        break;
      }
    }
    const node = this.node;
    this.lastPlayedSound = sound;

    // Play at the level the rest of the app plays at, the way
    // `RoomAudioManager` and the soundboard already do. Clamped to 1
    // because `perceptualGain` deliberately allows boost above 100% for
    // its other callers, which feed gain nodes -- HTMLMediaElement.volume
    // throws outside 0..1, so the boost half of that slider cannot apply
    // here. At 0% output volume these fall silent along with everything
    // else, which is what the slider says it does.
    node.volume = Math.min(1, perceptualGain(this.outputSettings.outputVolume));

    // Successful dispatch is normal operation, not a fault -- console.debug
    // so it shows up in devtools without reaching app-audio.log (the
    // Electron shell only forwards console.error and above to that file).
    console.debug(`[sound] playing "${sound}": ${node.src}`);

    // play() returns a promise that rejects on autoplay-policy blocks, a
    // decode failure, the element being removed, etc. -- previously this was
    // discarded entirely, so a rejection here was completely silent. This is
    // a genuine playback fault, so it goes to console.error to reach
    // app-audio.log.
    const play = () =>
      node.play().catch((err) => {
        console.error(`[sound] play() rejected for "${sound}":`, err);
      });

    // Route to the output device chosen in Stoat instead of whatever the OS
    // default happens to be. Voice audio and the soundboard both honour this
    // setting, so without it notification sounds are the one thing coming
    // out of a different pair of speakers than the rest of the app.
    //
    // `setSinkId` is absent from the TS DOM lib (hence the cast) and from
    // non-Chromium engines, and it rejects for a device that has since been
    // unplugged. In every one of those cases fall back to the default device
    // and still play: a sound on the wrong device beats no sound at all.
    const sinkId = this.outputSettings.preferredAudioOutputDevice;
    const sinkable = node as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };

    if (sinkId && typeof sinkable.setSinkId === "function") {
      sinkable.setSinkId(sinkId).then(play, (err) => {
        console.error(`[sound] setSinkId failed for "${sound}":`, err);
        play();
      });
    } else {
      play();
    }

    return true;
  }
}

const soundContext = createContext(null! as SoundController);

export function SoundContext(props: { children: JSXElement }) {
  const state = useState();

  const controller = new SoundController(state.sounds, state.voice);

  return (
    <soundContext.Provider value={controller}>
      {props.children}
    </soundContext.Provider>
  );
}

export function useSound(): SoundController {
  return useContext(soundContext);
}
