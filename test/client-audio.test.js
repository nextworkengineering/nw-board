import { expect, test, vi } from "vitest";
import { createAudioPlayer } from "../public/audio.js";

function audioContext(startState = "running") {
  const starts = [];
  const context = {
    state: startState,
    currentTime: 10,
    sampleRate: 10,
    destination: {},
    resume: vi.fn(async () => {
      // A microtask boundary makes the old check-immediately-after-resume bug fail.
      await Promise.resolve();
      context.state = "running";
    }),
    createOscillator: () => ({
      type: "square",
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect() {
        return this;
      },
      start: (at) => starts.push(at),
      stop: vi.fn(),
    }),
    createGain: () => ({
      gain: {
        value: 0,
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect() {
        return this;
      },
    }),
    createBuffer: (_channels, frames) => ({
      getChannelData: () => new Float32Array(frames),
    }),
    createBufferSource: () => ({
      buffer: undefined,
      connect() {
        return this;
      },
      start: vi.fn(),
    }),
  };
  const AudioContext = vi.fn(function AudioContext() {
    return context;
  });
  return { AudioContext, context, starts };
}

test("the first jingle waits for a suspended AudioContext to resume", async () => {
  const { AudioContext, context, starts } = audioContext("suspended");
  const player = createAudioPlayer({ AudioContext, warn: vi.fn() });

  await expect(player.play("pr-merged", false)).resolves.toBe(true);

  expect(context.resume).toHaveBeenCalledOnce();
  expect(starts.length).toBeGreaterThan(0);
});

test("a missing recorded clip falls back to a jingle on the same event", async () => {
  const { AudioContext, context, starts } = audioContext("suspended");
  const Audio = vi.fn(function Audio() {
    return { volume: 1, play: vi.fn().mockRejectedValue(new Error("404")) };
  });
  const player = createAudioPlayer({ AudioContext, Audio, warn: vi.fn() });

  await expect(player.play("review-approved", true)).resolves.toBe(true);

  expect(Audio).toHaveBeenCalledWith("sounds/omg.mp3");
  expect(context.resume).toHaveBeenCalledOnce();
  expect(starts.length).toBeGreaterThan(0);
});

test("a playable recorded clip does not create a synthesis context", async () => {
  const { AudioContext } = audioContext();
  const clip = { volume: 1, play: vi.fn().mockResolvedValue(undefined) };
  const Audio = vi.fn(function Audio() {
    return clip;
  });
  const player = createAudioPlayer({ AudioContext, Audio, warn: vi.fn() });

  await expect(player.play("pr-merged", true)).resolves.toBe(true);

  expect(clip.volume).toBe(0.8);
  expect(AudioContext).not.toHaveBeenCalled();
});

test.for([
  ["day-start", "sounds/oh-my-gosh.mp3"],
  ["day-chime", "sounds/super-mario-end.mp3"],
])("the %s clip falls back to the bell when the file is missing", async ([name, file]) => {
  const { AudioContext, starts } = audioContext("suspended");
  const Audio = vi.fn(function Audio() {
    return { volume: 1, play: vi.fn().mockRejectedValue(new Error("404")) };
  });
  const player = createAudioPlayer({ AudioContext, Audio, warn: vi.fn() });

  await expect(player.play(name)).resolves.toBe(true);

  expect(Audio).toHaveBeenCalledWith(file);
  expect(starts.length).toBeGreaterThan(0);
});
