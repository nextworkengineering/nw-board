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

Needs `lame` for both encoding and decoding: `brew install lame` on macOS,
`sudo apt install lame` on the Pi. Bitrate defaults to whatever the source used,
read from its mp3 frame headers. The Admin Console runs this on every upload.
"""

import argparse
import math
import struct
import subprocess
import sys
import tempfile
import wave

# The level every clip is normalized to. Chosen as the loudest all three original
# clips reach without a limiter: jetson.mp3 binds it, having the least headroom
# relative to its loudness. Raising this means compressing peaks, which squashes
# the clips and lifts their noise floors — measure before you move it. That choice was
# made on unweighted RMS; K-weighted, omg.mp3 and yo-pierre.mp3 sit at -15.3 and -16.0,
# either side of it, so the target carried over unchanged.
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
# The longest clip accepted. Every sample is held in Python lists, several times over,
# so memory grows with length: a 4-minute song peaked at 4.5 GB, more than a Pi has.
# A board clip is a few seconds; 30 s leaves room for a long fanfare.
MAX_SECONDS = 30


def decode(src, dst):
    subprocess.run(
        ["lame", "--decode", "--quiet", src, dst],  # 16-bit PCM WAV
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


def k_weight(x, rate):
    """ITU BS.1770 K-weighting: the ear hears bass as quieter than plain RMS says,
    so an unweighted RMS match leaves bassy clips sounding quiet (mustard.mp3 sat
    ~3 dB under its neighbours). Shelf boost above ~1.7 kHz, then a 38 Hz high-pass."""
    k = math.tan(math.pi * 1681.974450955533 / rate)
    vh = 10 ** (3.999843853973347 / 20)
    vb, q = vh**0.4996667741545416, 0.7071752369554196
    a0 = 1 + k / q + k * k
    shelf = (
        ((vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0),
        (2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0),
    )
    k, q = math.tan(math.pi * 38.13547087602444 / rate), 0.5003270373238773
    a0 = 1 + k / q + k * k
    highpass = ((1, -2, 1), (2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0))
    for (b0, b1, b2), (a1, a2) in (shelf, highpass):
        y, x1, x2, y1, y2 = [], 0.0, 0.0, 0.0, 0.0
        for v in x:
            o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2, x1, y2, y1 = x1, v, y1, o
            y.append(o)
        x = y
    return x


def measure(samples, rate, channels):
    """Peak, gated K-weighted RMS and lead-in. Gating ignores the quiet tail and the silence."""
    mono = [
        (sum(samples[i : i + channels]) / channels) / 32768.0
        for i in range(0, len(samples), channels)
    ]
    peak = max(abs(v) for v in mono)
    weighted = k_weight(mono, rate)
    block = int(rate * 0.05)
    blocks = [
        b
        for b in (
            sum(v * v for v in weighted[i : i + block]) / block
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


# Layer III bitrates (kbps) by header index, for MPEG1 and for MPEG2/2.5.
KBPS = {
    3: (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),
    2: (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
}
# Sample rates by header index, keyed by the version bits (3 MPEG1, 2 MPEG2, 0 MPEG2.5).
RATES = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}


def source_bitrate(path):
    """kbps of the first MPEG Layer III frame, past any ID3v2 tag. A VBR file opens
    with a Xing frame whose own bitrate means nothing, so average over the file from
    its frame and byte counts instead. 128 if no frame can be found."""
    with open(path, "rb") as f:
        data = f.read()
    start = 0
    if data[:3] == b"ID3" and len(data) >= 10:
        size = 0
        for b in data[6:10]:
            size = size << 7 | b & 0x7F
        start = 10 + size + (10 if data[5] & 0x10 else 0)
    for i in range(start, len(data) - 3):
        if data[i] != 0xFF or data[i + 1] & 0xE0 != 0xE0:
            continue
        version, layer = data[i + 1] >> 3 & 3, data[i + 1] >> 1 & 3
        index, rate_index = data[i + 2] >> 4, data[i + 2] >> 2 & 3
        if version == 1 or layer != 1 or index in (0, 15) or rate_index == 3:
            continue
        mono = data[i + 3] >> 6 == 3
        side = (17 if mono else 32) if version == 3 else (9 if mono else 17)
        tag = data[i + 4 + side : i + 20 + side]
        if len(tag) == 16 and tag[:4] == b"Xing" and tag[7] & 3 == 3:
            frames, size = struct.unpack(">II", tag[8:16])
            seconds = frames * (1152 if version == 3 else 576) / RATES[version][rate_index]
            if seconds:
                return round(size * 8 / seconds / 1000)
        return KBPS[3 if version == 3 else 2][index]
    return 128


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="the original download, e.g. ~/Downloads/foo.mp3")
    ap.add_argument("dest", help="where it lands, e.g. public/sounds/foo.mp3")
    ap.add_argument("--bitrate", type=int, help="kbps (default: match the source)")
    args = ap.parse_args()

    tmp = tempfile.TemporaryDirectory()
    src_wav, out_wav, check_wav = (f"{tmp.name}/{n}.wav" for n in ("src", "out", "check"))

    decode(args.source, src_wav)
    # Checked from the header, before a single sample is read into memory.
    with wave.open(src_wav) as r:
        seconds = r.getnframes() / r.getframerate()
    if seconds > MAX_SECONDS:
        tmp.cleanup()
        sys.exit(f"{args.source} is {seconds:.0f} s long; clips are capped at {MAX_SECONDS} s")
    samples, (rate, channels, width) = read(src_wav)
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

    with wave.open(out_wav, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % len(out), *out))

    bitrate = args.bitrate or source_bitrate(args.source)
    subprocess.run(
        ["lame", "-b", str(bitrate), "--quiet", out_wav, args.dest],
        check=True,
    )

    decode(args.dest, check_wav)
    check, (rate2, channels2, _) = read(check_wav)
    new_peak, new_rms, new_lead = measure(check, rate2, channels2)
    print(f"{args.source} -> {args.dest} @ {bitrate}kbps")
    print(f"  loudness {rms_db:7.2f} -> {new_rms:7.2f} dBFS  (target {TARGET_RMS_DB})")
    print(f"  peak     {peak_db:7.2f} -> {new_peak:7.2f} dBFS  (ceiling {PEAK_CEILING_DB})")
    print(f"  lead-in  {lead:7.3f} -> {new_lead:7.3f} s       (target {LEAD_IN_S})")


if __name__ == "__main__":
    main()
