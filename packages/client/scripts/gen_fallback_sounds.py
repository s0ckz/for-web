"""
Synthesise Stoat's UI notification sounds.

Every sample here is generated from first principles -- no sampled or
downloaded audio -- so the output carries no third-party licence and is
safe to commit to a public repository. Re-run this script to regenerate
or retune the whole set:

    python scripts/gen_fallback_sounds.py scripts/assets_fallback/sounds

Run from `packages/client`. Requires numpy and ffmpeg (libvorbis).

Design
------
One timbre for the whole family: a fundamental plus a quiet second
harmonic, fast attack, exponential decay. That keeps every sound
recognisably part of the same app rather than a bag of unrelated beeps.

Meaning is carried by *contour* and *register*, not by timbre:

  rising   = something arrived / opened / turned on
  falling  = something left / closed / turned off

  high register  = incidental (stream viewers coming and going)
  mid register   = voice channel membership
  low register   = your own audio state (mute, deafen)
  three notes    = a notable event worth looking up for (a stream)

All pitches are drawn from a C major pentatonic set, so any two sounds
that happen to overlap during a busy call still agree with each other.
"""

import numpy as np
import subprocess
import sys
from pathlib import Path

SR = 48_000
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
OUT.mkdir(parents=True, exist_ok=True)

# C major pentatonic, two octaves
G4, C5, D5, E5, G5, A5, C6 = 392.00, 523.25, 587.33, 659.26, 783.99, 880.00, 1046.50

# name: (notes, per-note seconds, overlap gap, peak amplitude)
#
# Amplitude is a deliberate editorial choice, not a normalisation artefact:
# sounds that fire often or incidentally sit quieter than sounds that mark
# a real event, so a busy channel does not become exhausting.
SOUNDS = {
    # --- voice channel membership: mid register, perfect fifth ---
    "user_join_voice":     ([C5, G5],         0.26, 0.085, 0.63),
    "user_leave_voice":    ([G5, C5],         0.26, 0.085, 0.63),
    "user_moved":          ([C5, D5],         0.22, 0.075, 0.55),

    # --- your own mic: shorter, tighter, a third apart ---
    "unmute":              ([C5, E5],         0.18, 0.060, 0.55),
    "mute":                ([E5, C5],         0.18, 0.060, 0.55),

    # --- your own ears: an octave down, so deafen reads heavier than mute ---
    "undeafen":            ([G4, C5],         0.24, 0.080, 0.60),
    "deafen":              ([C5, G4],         0.24, 0.080, 0.60),

    # --- a stream starting or ending: three notes, worth looking up for ---
    "stream_start":        ([C5, E5, G5],     0.20, 0.070, 0.68),
    "stream_end":          ([G5, E5, C5],     0.20, 0.070, 0.68),

    # --- someone watching your stream: high and quiet, purely incidental ---
    "stream_viewer_join":  ([A5, C6],         0.16, 0.055, 0.42),
    "stream_viewer_leave": ([C6, A5],         0.16, 0.055, 0.42),
}


def note(freq: float, dur: float) -> np.ndarray:
    """One voiced note: fundamental + quiet 2nd harmonic, plucked envelope."""
    t = np.linspace(0.0, dur, int(SR * dur), endpoint=False)

    wave = np.sin(2 * np.pi * freq * t) + 0.18 * np.sin(2 * np.pi * 2 * freq * t)

    # Fast attack so it feels responsive to the event that triggered it;
    # exponential decay so the tail ducks under conversation instead of
    # competing with it.
    env = np.exp(-4.5 * t / dur)

    attack = int(SR * 0.006)
    env[:attack] *= np.linspace(0.0, 1.0, attack)

    # An abrupt cut on a still-decaying sine clicks; fade the last few ms.
    fade = int(SR * 0.008)
    env[-fade:] *= np.linspace(1.0, 0.0, fade)

    return wave * env


def build(notes: list[float], dur: float, gap: float, peak: float) -> np.ndarray:
    """Overlap the notes so they read as one gesture, not separate beeps."""
    buf = np.zeros(int(SR * gap) * (len(notes) - 1) + int(SR * dur) + 1)

    for i, freq in enumerate(notes):
        voice = note(freq, dur)
        start = int(SR * gap) * i
        # Later notes lean slightly louder: the gesture lands on its last
        # note, which is the one carrying the up/down meaning.
        buf[start : start + len(voice)] += voice * (0.82 + 0.18 * i / max(len(notes) - 1, 1))

    return buf / np.max(np.abs(buf)) * peak


def write(name: str, samples: np.ndarray) -> int:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    path = OUT / f"{name}.ogg"

    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
            "-c:a", "libvorbis", "-q:a", "3", str(path),
        ],
        input=pcm,
        check=True,
    )
    return path.stat().st_size


for name, (notes, dur, gap, peak) in SOUNDS.items():
    samples = build(notes, dur, gap, peak)
    size = write(name, samples)
    print(f"{name:22} {len(samples) / SR:.3f}s  {size:5} bytes  peak {20 * np.log10(peak):.1f} dBFS")
