# CLAUDE.md

Read `CONTEXT.md` before changing domain behavior or vocabulary.

Every sound clip added to `public/sounds/` gets **at least 250ms of leading
silence** before it ships, so a slow audio sink can't clip the opening. Measure
what the source already has and top it up to 250ms rather than adding 250ms
blindly — some downloads arrive with their own lead-in, and stacking a second
one delays the sound noticeably. This machine has no mp3 encoder by default:

```sh
brew install lame                                              # once
afconvert -f WAVE -d LEI16 <source>.mp3 /tmp/clip.wav           # CoreAudio decodes mp3
python3 - <<'PY'                                                # stdlib wave, no deps
import wave
PAD = 0.25   # seconds of silence to prepend; subtract what the source already has
with wave.open("/tmp/clip.wav") as r, wave.open("/tmp/clip-padded.wav", "wb") as w:
    w.setparams(r.getparams())
    w.writeframes(b"\0" * int(PAD * r.getframerate()) * r.getnchannels() * r.getsampwidth())
    w.writeframes(r.readframes(r.getnframes()))
PY
lame -b <source bitrate> /tmp/clip-padded.wav public/sounds/<name>.mp3
```

Verify by decoding the result back and finding the first sample above the noise
floor: it should land at ~0.25s.

The only outstanding acceptance work is the Raspberry Pi deployment check in
`.scratch/pr-arcade/issues/07-pi-deployment-setup-walkthrough.md`.
