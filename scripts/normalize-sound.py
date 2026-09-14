#!/usr/bin/env python3
"""Prepare a downloaded sound effect for public/sounds/.

Two things every board clip needs, in one pass from the original download so the
result is only one mp3 generation from source:

  * at least LEAD_IN_S of leading silence, so a slow audio sink cannot clip the
    opening — topped up to the target, not added blindly, because most downloads
    arrive with some lead-in of their own;
  * a gain that puts it at TARGET_RMS_DB, so no clip is noticeably louder than
    its neighbours on the board.

Usage:
    python3 scripts/normalize-sound.py ~/Downloads/foo.mp3 public/sounds/foo.mp3

Needs `lame` (brew install lame); macOS `afconvert` does the decoding. Bitrate
defaults to whatever the source used.
"""

import argparse
import math
import re
import struct
import subprocess
import sys
import wave

# The level every clip is normalized to. Chosen as the loudest all three original
# clips reach without a limiter: jetson.mp3 binds it, having the least headroom
# relative to its loudness. Raising this means compressing peaks, which squashes
# the clips and lifts their noise floors — measure before you move it.
TARGET_RMS_DB = -15.81
# The gain is computed on the decoded source, and the mp3 round trip then costs about
# 0.4 dB — so the printed result lands a little under the target. It lands under by the
# same amount every time, and matching the clips to each other is the point.
#
# Leave room for inter-sample peaks that mp3 decoding can push above the PCM peak.
PEAK_CEILING_DB = -1.5
LEAD_IN_S = 0.25
# Treat anything below this as silence when finding where a clip really starts.
FLOOR = 0.005


def decode(src, dst):
    subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", "LEI16", src, dst],
        check=True,
        capture_output=True,
    )


def read(path):
    with wave.open(path) as r:
        params = (r.getframerate(), r.getnchannels(), r.getsampwidth())
        frames = r.getnframes()
        return list(struct.unpack("<%dh" % (frames * params[1]), r.readframes(frames))), params


def db(x):
    return 20 * math.log10(x) if x > 0 else -99.0


def measure(samples, rate, channels):
    """Peak, gated RMS and lead-in. Gating ignores the quiet tail and the silence."""
    mono = [
        (sum(samples[i : i + channels]) / channels) / 32768.0
        for i in range(0, len(samples), channels)
    ]
    peak = max(abs(v) for v in mono)
    block = int(rate * 0.05)
    blocks = [
        b
        for b in (
            sum(v * v for v in mono[i : i + block]) / block
            for i in range(0, len(mono) - block, block)
        )
        if b > 0
    ]
    if not blocks:
        sys.exit("that file is silent")
    loudest = max(blocks)
    kept = [b for b in blocks if b > loudest / 100.0]  # within 20dB of the loudest
    rms = math.sqrt(sum(kept) / len(kept))
    lead = next((i for i, v in enumerate(mono) if abs(v) > FLOOR), 0) / rate
    return db(peak), db(rms), lead


def source_bitrate(path):
    out = subprocess.run(["afinfo", path], capture_output=True, text=True).stdout
    found = re.search(r"bit rate: (\d+) bits", out)
    return round(int(found.group(1)) / 1000) if found else 128


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="the original download, e.g. ~/Downloads/foo.mp3")
    ap.add_argument("dest", help="where it lands, e.g. public/sounds/foo.mp3")
    ap.add_argument("--bitrate", type=int, help="kbps (default: match the source)")
    args = ap.parse_args()

    decode(args.source, "/tmp/normalize-src.wav")
    samples, (rate, channels, width) = read("/tmp/normalize-src.wav")
    peak_db, rms_db, lead = measure(samples, rate, channels)

    gain_db = TARGET_RMS_DB - rms_db
    headroom = PEAK_CEILING_DB - peak_db
    if gain_db > headroom:
        print(
            f"warning: reaching the target needs {gain_db:+.2f} dB but only "
            f"{headroom:+.2f} dB fits under the peak ceiling. Capping — this clip "
            f"will sit {gain_db - headroom:.2f} dB quiet. Limiting would be the fix.",
            file=sys.stderr,
        )
        gain_db = headroom
    factor = 10 ** (gain_db / 20)

    pad = max(0.0, LEAD_IN_S - lead)
    out = [0] * (int(pad * rate) * channels)
    out += [max(-32768, min(32767, int(round(s * factor)))) for s in samples]

    with wave.open("/tmp/normalize-out.wav", "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % len(out), *out))

    bitrate = args.bitrate or source_bitrate(args.source)
    subprocess.run(
        ["lame", "-b", str(bitrate), "--quiet", "/tmp/normalize-out.wav", args.dest],
        check=True,
    )

    decode(args.dest, "/tmp/normalize-check.wav")
    check, (rate2, channels2, _) = read("/tmp/normalize-check.wav")
    new_peak, new_rms, new_lead = measure(check, rate2, channels2)
    print(f"{args.source} -> {args.dest} @ {bitrate}kbps")
    print(f"  loudness {rms_db:7.2f} -> {new_rms:7.2f} dBFS  (target {TARGET_RMS_DB})")
    print(f"  peak     {peak_db:7.2f} -> {new_peak:7.2f} dBFS  (ceiling {PEAK_CEILING_DB})")
    print(f"  lead-in  {lead:7.3f} -> {new_lead:7.3f} s       (target {LEAD_IN_S})")


if __name__ == "__main__":
    main()
