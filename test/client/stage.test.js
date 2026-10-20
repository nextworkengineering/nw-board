import { expect, test } from "vitest";
import { createStage } from "../../public/stage.js";

/** sessionStorage's three calls over a Map; survives "reloads" by being reused. */
function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

/**
 * A stage whose scenes never finish on their own: `shown` records what reached the
 * screen, in order, and `finish()` ends whatever is on it now.
 */
function board({ theme = "kernel", storage = memoryStorage() } = {}) {
  const shown = [];
  const reloads = [];
  let done;
  const stage = createStage({
    runScene: (takeover, finish) => {
      shown.push(takeover.type);
      done = finish;
    },
    reload: (name) => reloads.push(name),
    storage,
    theme,
  });
  const banner = (name) =>
    stage.banner((finish) => {
      shown.push(name);
      done = finish;
    });
  const finish = () => {
    const end = done;
    done = undefined;
    end();
  };
  return { stage, banner, finish, shown, reloads, storage };
}

test("takeovers and banners interleave, one on screen at a time", () => {
  const { stage, banner, finish, shown } = board();

  stage.takeover("pr-merged");
  stage.takeover("review-approved");
  banner("09:00 chime");
  banner("standup reminder");
  // The first merge holds the screen; everything else waits.
  expect(shown).toEqual(["pr-merged"]);

  // A banner that waited out a takeover goes before further takeovers, and a
  // takeover that waited out a banner goes before further banners.
  finish();
  expect(shown).toEqual(["pr-merged", "09:00 chime"]);
  finish();
  expect(shown).toEqual(["pr-merged", "09:00 chime", "review-approved"]);
  finish();
  expect(shown).toEqual(["pr-merged", "09:00 chime", "review-approved", "standup reminder"]);
  finish();

  // Clear stage: the next occasion starts at once.
  stage.takeover("pr-merged");
  expect(shown.at(-1)).toBe("pr-merged");
});

test("a takeover carries its event and audible flag to the scene", () => {
  const seen = [];
  const stage = createStage({
    runScene: (takeover) => seen.push(takeover),
    reload: () => {},
    storage: memoryStorage(),
    theme: "kernel",
  });
  const event = { type: "pr-merged", number: 7 };

  stage.takeover("pr-merged", event, true);

  expect(seen).toEqual([{ type: "pr-merged", event, audible: true }]);
});

test("defers a theme reload while the stage is busy, until everything queued has played", () => {
  const { stage, banner, finish, shown, reloads } = board();

  stage.takeover("pr-merged");
  stage.takeover("review-approved");
  banner("09:00 chime");
  stage.wantTheme("neobrutal");
  expect(reloads).toEqual([]);

  finish(); // merge -> chime
  finish(); // chime -> approval
  expect(reloads).toEqual([]);
  finish(); // nothing left
  expect(shown).toEqual(["pr-merged", "09:00 chime", "review-approved"]);
  expect(reloads).toEqual(["neobrutal"]);
});

test("a theme switch on a clear stage reloads at once; this page's own theme never does", () => {
  const { stage, reloads } = board({ theme: "neobrutal" });

  stage.wantTheme("neobrutal");
  expect(reloads).toEqual([]);

  stage.wantTheme("kernel");
  expect(reloads).toEqual(["kernel"]);
});

test("a switch called off before it happened stays put", () => {
  const { stage, finish, reloads } = board();

  stage.takeover("pr-merged");
  stage.wantTheme("neobrutal");
  stage.wantTheme("kernel");
  finish();

  expect(reloads).toEqual([]);
});

test("a Target Hit survives a reload into the Arcade Theme", () => {
  const storage = memoryStorage();
  const data = { type: "wau-target-hit", label: "Monday", current: 2214, previous: 2103, audible: true };

  // On the kernel theme the Target Hit is held and the page reloads into arcade.
  const before = board({ storage });
  before.stage.targetHit(data);
  expect(before.shown).toEqual([]);
  expect(before.reloads).toEqual(["arcade"]);
  // The key and shape outlive a deploy, so they must not change.
  expect(JSON.parse(storage.getItem("pending-celebration"))).toEqual(data);

  // The arcade page plays it once, from the reload, and only once.
  const seen = [];
  const after = createStage({
    runScene: (takeover) => seen.push(takeover),
    reload: () => {},
    storage,
    theme: "arcade",
  });
  after.playHeld();
  after.playHeld();
  expect(seen).toEqual([{ type: "wau-target-hit", event: data, audible: true }]);
  expect(storage.getItem("pending-celebration")).toBeNull();
});

test("a held Target Hit waits out a takeover before the reload", () => {
  const { stage, finish, shown, reloads, storage } = board();

  stage.takeover("pr-merged");
  stage.targetHit({ type: "wau-target-hit", audible: false });
  expect(reloads).toEqual([]);
  expect(storage.getItem("pending-celebration")).not.toBeNull();

  finish();
  expect(shown).toEqual(["pr-merged"]);
  expect(reloads).toEqual(["arcade"]);
});

test("a Target Hit already in arcade plays at once and cancels a switch away", () => {
  const { stage, finish, shown, reloads, storage } = board({ theme: "arcade" });

  stage.takeover("pr-merged");
  stage.wantTheme("kernel");
  stage.targetHit({ type: "wau-target-hit", audible: true });
  expect(storage.items.size).toBe(0);

  finish();
  expect(shown).toEqual(["pr-merged", "wau-target-hit"]);
  finish();
  expect(reloads).toEqual([]);
});
