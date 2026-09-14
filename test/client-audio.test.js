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
  // Ambient but audible: it needs a jingle of its own, or a missing file is silence.
  ["pr-opened", "sounds/metrooo.mp3"],
])("the %s clip falls back to a jingle when the file is missing", async ([name, file]) => {
  const { AudioContext, starts } = audioContext("suspended");
  const Audio = vi.fn(function Audio() {
    return { volume: 1, play: vi.fn().mockRejectedValue(new Error("404")) };
  });
  const player = createAudioPlayer({ AudioContext, Audio, warn: vi.fn() });

  await expect(player.play(name)).resolves.toBe(true);

  expect(Audio).toHaveBeenCalledWith(file);
  expect(starts.length).toBeGreaterThan(0);
});

// --------------------------------------------------------------------------------
// playAmbient: the Ambient Event sound path. Everything a pr-opened does between the
// wire and a noise lives here, so this is where the wire flags and the burst
// cooldown are pinned.
// --------------------------------------------------------------------------------

/** A player whose clock the test drives, plus a record of every clip it constructed. */
function ambientPlayer(startAt = 1000) {
  let clock = startAt;
  const clips = [];
  const { AudioContext, starts } = audioContext();
  const Audio = vi.fn(function Audio(src) {
    clips.push(src);
    return { volume: 1, play: vi.fn().mockResolvedValue(undefined) };
  });
  const player = createAudioPlayer({
    AudioContext,
    Audio,
    warn: vi.fn(),
    now: () => clock,
  });
  return { player, clips, starts, tick: (ms) => (clock += ms) };
}

const opened = (extra) => ({ type: "pr-opened", ...extra });

test("an audible pr-opened plays its clip", async () => {
  const { player, clips } = ambientPlayer();

  await expect(player.playAmbient(opened({ audible: true, teammate: true }))).resolves.toBe(
    true,
  );

  expect(clips).toEqual(["sounds/metrooo.mp3"]);
});

test.for([
  ["no audible flag at all — a silent Ambient Event", {}],
  ["audible false — Quiet Hours", { audible: false }],
])("a pr-opened with %s makes no sound", async ([, flags]) => {
  const { player, clips, starts } = ambientPlayer();

  await expect(player.playAmbient(opened(flags))).resolves.toBe(false);

  expect(clips).toEqual([]);
  // Not even the jingle: a silenced event is silent, not quietly downgraded.
  expect(starts).toEqual([]);
});

test("an audible pr-opened from someone off the roster gets the jingle, not the clip", async () => {
  const { player, clips, starts } = ambientPlayer();

  await expect(
    player.playAmbient(opened({ audible: true, teammate: false })),
  ).resolves.toBe(true);

  expect(clips).toEqual([]);
  expect(starts.length).toBeGreaterThan(0);
});

test("a burst of opened PRs makes the noise once", async () => {
  const { player, clips } = ambientPlayer();

  // Five PRs landing in the same tick — a dependabot batch or a stacked-PR push.
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      player.playAmbient(opened({ audible: true, teammate: true })),
    ),
  );

  expect(results).toEqual([true, false, false, false, false]);
  expect(clips).toEqual(["sounds/metrooo.mp3"]);
});

test("the cooldown expires, so a later PR is heard again", async () => {
  const { player, clips, tick } = ambientPlayer();

  await player.playAmbient(opened({ audible: true, teammate: true }));
  tick(1499);
  await expect(player.playAmbient(opened({ audible: true, teammate: true }))).resolves.toBe(
    false,
  );
  tick(1);
  await expect(player.playAmbient(opened({ audible: true, teammate: true }))).resolves.toBe(
    true,
  );

  expect(clips).toEqual(["sounds/metrooo.mp3", "sounds/metrooo.mp3"]);
});

test("a flagged event with no clip and no jingle is silent rather than a crash", async () => {
  const { player, clips, starts } = ambientPlayer();

  // pr-comment has neither a SAMPLE nor a JINGLE. Only a hand-typed arcade.event()
  // can reach this, but it must not throw when it does.
  await expect(
    player.playAmbient({ type: "pr-comment", audible: true, teammate: true }),
  ).resolves.toBe(false);

  expect(clips).toEqual([]);
  expect(starts).toEqual([]);
});

test("the takeover path is not throttled by the ambient cooldown", async () => {
  const { player, clips } = ambientPlayer();

  await player.playAmbient(opened({ audible: true, teammate: true }));
  // Celebrations serialize behind their 5s scene; they must not also inherit this gate.
  await expect(player.play("pr-merged", true)).resolves.toBe(true);

  expect(clips).toEqual(["sounds/metrooo.mp3", "sounds/jetson.mp3"]);
});
