# Fallback notification sounds

These are the sounds the client ships when the private brand asset pack
(`packages/client/assets`) is unavailable — which is **every CI build**, since
`.gitmodules` marks that submodule `update = none`. `scripts/copyAssets.mjs`
symlinks this directory into `public/assets` instead.

So in practice this is not a fallback at all: it is what users actually hear.

## Do not replace these with silence

Every file here except `message_sound.ogg` was once a one-second silent
placeholder — 13 identical files measuring −91.0 dB, the 16-bit noise floor.
The effect was that no notification sound in Stoat had ever worked, and because
a silent file plays perfectly successfully, nothing ever errored or logged.
It looked like a code bug for a long time before anyone measured the audio.

If you add a sound key, add real audio for it here too. To check a file is not
silent:

```
ffmpeg -i user_join_voice.ogg -af volumedetect -f null -
```

`max_volume` should be somewhere around −8 to −3 dB. `−91.0 dB` means silence.

## Where these came from

The 11 UI sounds are synthesised from first principles by
[`../gen_fallback_sounds.py`](../gen_fallback_sounds.py) — no sampled or
downloaded audio, so nothing here carries a third-party licence and this
repository can stay public. Run that script to retune or regenerate them; it
documents the design (contour and register carry the meaning, one timbre
family across the set).

`ringtone_incoming.ogg` and `ringtone_outgoing.ogg` are **still silent
placeholders.** They are long musical loops in the real pack, a different
design problem from short UI chimes, and were deliberately left for separate
work. `message_sound.ogg` is real audio inherited from upstream.
