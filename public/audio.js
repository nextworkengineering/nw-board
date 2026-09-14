// Browser audio for the board. Kept separate from the Pixi scene so the async
// autoplay/device recovery path can be exercised without starting a renderer.

function dayChime(tone) {
  [659, 880, 1319, 880].forEach((freq, i) =>
    tone(freq, i * 0.28, 0.7, { type: "triangle", gain: 0.09 }),
  );
  tone(330, 0.84, 1.2, { type: "triangle", gain: 0.05 });
}

const JINGLE_NOTES = {
  "pr-merged": (tone, noise) => {
    [523, 659, 784, 1047].forEach((freq, i) => tone(freq, i * 0.09, 0.1));
    tone(1047, 0.36, 0.5, { gain: 0.12 });
    tone(1568, 0.36, 0.5, { type: "triangle", gain: 0.07 });
    tone(2093, 0.9, 0.6, { type: "triangle", gain: 0.06 });
    noise(0.36, 0.35, 0.05);
  },
  "review-approved": (tone, noise) => {
    tone(784, 0, 0.12, { gain: 0.11 });
    tone(1175, 0.12, 0.32, { gain: 0.11 });
    [1175, 1568].forEach((freq, i) =>
      tone(freq, 0.16 + i * 0.1, 0.28, { type: "triangle", gain: 0.06 }),
    );
    noise(0, 0.12, 0.04);
  },
  // The one Ambient Event with a voice: a rocket-launch blip matching its feed
  // animation, mixed under the takeover jingles so opening a PR doesn't shout.
  "pr-opened": (tone, noise) => {
    tone(392, 0, 0.3, { type: "triangle", gain: 0.07, slideTo: 880 });
    tone(880, 0.26, 0.16, { type: "triangle", gain: 0.05 });
    noise(0, 0.22, 0.03);
  },
  "day-chime": dayChime,
  // Start of day has its own clip; without the file it falls back to the same bell.
  "day-start": dayChime,
};

const SAMPLES = {
  "pr-merged": "sounds/jetson.mp3",
  "review-approved": "sounds/omg.mp3",
  "pr-opened": "sounds/metrooo.mp3",
  "day-start": "sounds/oh-my-gosh.mp3",
  "day-chime": "sounds/super-mario-end.mp3",
};

/**
 * How long an Ambient Event sound silences the next one. Unlike the takeovers, which
 * serialize behind a 5s scene, an ambient sound has no visual to queue against — so a
 * batch of PRs opened at once (dependabot, a stacked-PR push) would stack clips on top
 * of each other. The burst makes the noise once and the rest animate silently: dropping
 * beats queueing here, because 20 queued clips would still be playing long after the
 * feed moved on. Roughly the length of the longest ambient clip.
 */
const AMBIENT_COOLDOWN_MS = 1500;

/**
 * Build the board's audio player. Dependencies are injectable because the failure
 * that matters happens between Web APIs: Audio.play() rejects, AudioContext starts
 * suspended, and resume() changes its state asynchronously.
 */
export function createAudioPlayer({
  AudioContext: AudioContextImpl = globalThis.AudioContext,
  Audio: AudioImpl = globalThis.Audio,
  random = Math.random,
  warn = console.warn,
  now = Date.now,
} = {}) {
  let audio;
  let lastAmbientAt = -Infinity;

  async function ready() {
    try {
      // A closed context cannot be resumed. This also gives a replaced HDMI sink a
      // fresh context instead of retaining the destination from an earlier device.
      if (!audio || audio.state === "closed") audio = new AudioContextImpl();
      // resume() is asynchronous. Checking state before it settles drops precisely
      // the first sound after kiosk startup, which is usually the human smoke test.
      if (audio.state === "suspended") await audio.resume();
      return audio.state === "running";
    } catch (error) {
      warn("board audio is unavailable", error);
      return false;
    }
  }

  function tone(freq, start, length, { type = "square", gain = 0.1, slideTo } = {}) {
    const at = audio.currentTime + start;
    const oscillator = audio.createOscillator();
    const volume = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(freq, at);
    if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, at + length);
    volume.gain.setValueAtTime(gain, at);
    // Fade each note out; a hard stop on a square wave clicks.
    volume.gain.exponentialRampToValueAtTime(0.001, at + length);
    oscillator.connect(volume).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + length);
  }

  /** White noise through a decaying envelope: the 8-bit sparkle/percussion voice. */
  function noise(start, length, gain = 0.07) {
    const frames = Math.ceil(audio.sampleRate * length);
    const buffer = audio.createBuffer(1, frames, audio.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++)
      samples[i] = (random() * 2 - 1) * (1 - i / frames) ** 2;
    const source = audio.createBufferSource();
    source.buffer = buffer;
    const volume = audio.createGain();
    volume.gain.value = gain;
    source.connect(volume).connect(audio.destination);
    source.start(audio.currentTime + start);
  }

  async function fallback(name) {
    const jingle = JINGLE_NOTES[name];
    if (!jingle || !(await ready())) return false;
    jingle(tone, noise);
    return true;
  }

  async function play(name, teammate = true) {
    if (!SAMPLES[name] || !teammate) return fallback(name);
    try {
      const clip = new AudioImpl(SAMPLES[name]);
      clip.volume = 0.8;
      await clip.play();
      return true;
    } catch {
      // Missing optional clips and autoplay failures both use the generated jingle.
      // Awaiting fallback means this event itself survives a suspended context.
      return fallback(name);
    }
  }

  /**
   * The Ambient Event sound path. The server's flags decide whether there is a sound
   * at all — no `audible` means Quiet Hours, or an event type that is simply silent —
   * and the cooldown decides whether this one is the sound the burst gets.
   *
   * Resolves to whether a sound started, so a caller can tell "throttled" from "played".
   */
  async function playAmbient(event) {
    if (!event?.audible) return false;
    if (now() - lastAmbientAt < AMBIENT_COOLDOWN_MS) return false;
    // Stamped before the await, not after: two events arriving in the same tick would
    // both pass an end-of-play check and stack anyway, which is the bug being fixed.
    lastAmbientAt = now();
    return play(event.type, event.teammate !== false);
  }

  return { play, playAmbient, resume: ready };
}

const player = createAudioPlayer();
export const play = player.play;
export const playAmbient = player.playAmbient;
export const resumeAudio = player.resume;
