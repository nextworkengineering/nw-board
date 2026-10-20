import { expect, test } from "vitest";
import type { DomainEvent } from "../src/backfill.ts";
import { createBoard } from "../src/board.ts";

// Thursday 2026-08-13, local time, so these hold in whatever zone the suite runs in.
const at = (h: number, min = 0, day = 13) => new Date(2026, 7, day, h, min).getTime();
const HOUR = 60 * 60 * 1000;

const merge = (number: number, actor: string): DomainEvent => ({
  type: "pr-merged",
  repo: "example-org/projects-app",
  number,
  title: `PR ${number}`,
  actor,
});

/** A board on a clock the test moves, counting the changes it tells. */
function board({ clock = at(10), names = {} as Record<string, string>, theme = "kernel" } = {}) {
  const state = { clock, names, changes: 0 };
  const it = createBoard({ now: () => state.clock, names: () => state.names, theme });
  it.onChange(() => state.changes++);
  return Object.assign(state, { it });
}

test("record does not mutate the event: the display name goes on a copy", () => {
  const b = board({ names: { hubot: "Botty" } });
  const event = merge(42, "hubot");
  const shown = b.it.record(event, at(10));

  expect(event.actor).toBe("hubot");
  expect(shown).toEqual({ ...event, actor: "Botty" });
  expect(b.it.snapshot().feed).toEqual([{ ...event, actor: "Botty", at: at(10) }]);
});

test("a rename keeps the day's Feed as it was recorded, and dedups approvals by login", () => {
  const b = board({ names: { "reviewer-rita": "Rita" } });
  const approval = { ...merge(7, "reviewer-rita"), type: "review-approved" };
  expect(b.it.record(approval, at(10))).toMatchObject({ actor: "Rita" });

  b.names = { "reviewer-rita": "Margarita" };
  // A redelivery after the rename is still the same approval.
  expect(b.it.record({ ...approval }, at(10, 5))).toBe(null);
  expect(b.it.snapshot().feed.map((e) => e.actor)).toEqual(["Rita"]);
});

test("a repeat of a Backfillable event is dropped and tells nobody; an Ambient repeat is new", () => {
  const b = board();
  expect(b.it.record(merge(42, "hubot"), at(10))).not.toBe(null);
  expect(b.it.record(merge(42, "hubot"), at(10, 1))).toBe(null);
  const comment = { ...merge(42, "carl"), type: "pr-comment" };
  expect(b.it.record(comment, at(10, 2))).not.toBe(null);
  expect(b.it.record({ ...comment }, at(10, 3))).not.toBe(null);
  expect(b.changes).toBe(3);
});

test("an undateable event is never recorded", () => {
  const b = board();
  expect(b.it.record(merge(42, "hubot"), NaN)).toBe(null);
  expect(b.it.snapshot().feed).toEqual([]);
  expect(b.changes).toBe(0);
});

test("the Feed keeps time order when an older event arrives late, so it still expires", () => {
  const b = board({ clock: at(12) });
  b.it.record(merge(1, "a"), at(11));
  // Reconcile recovering something from yesterday, after newer entries.
  b.it.record(merge(2, "b"), at(12) - 23 * HOUR);
  b.it.record(merge(3, "c"), at(11, 30));
  expect(b.it.snapshot().feed.map((e) => e.number)).toEqual([2, 1, 3]);

  // 24 h after the late one happened it leaves, without waiting for the newer ones.
  b.clock = at(12) + HOUR;
  expect(b.it.snapshot().feed.map((e) => e.number)).toEqual([1, 3]);
});

test("the MVP counts today's merges only, names every Actor tied, by first merge of the day", () => {
  const b = board({ clock: at(12), names: { hubot: "Botty" } });
  expect(b.it.snapshot().mvp).toBe(null);

  b.it.record(merge(1, "octocat"), at(9, 0, 12)); // yesterday: in the Feed, not the crown
  b.it.record(merge(2, "hubot"), at(9));
  b.it.record({ ...merge(3, "carl"), type: "pr-comment" }, at(9, 30));
  b.it.record(merge(4, ""), at(9, 45)); // GitHub named nobody: can't wear it
  b.it.record(merge(5, "octocat"), at(10));
  expect(b.it.snapshot().mvp).toEqual({ names: ["Botty", "octocat"], count: 1 });

  // A late merge from earlier today moves its Actor to the front of the tie.
  b.it.record(merge(6, "rita"), at(8));
  expect(b.it.snapshot().mvp).toEqual({ names: ["rita", "Botty", "octocat"], count: 1 });
  b.it.record(merge(7, "octocat"), at(11));
  expect(b.it.snapshot().mvp).toEqual({ names: ["octocat"], count: 2 });
});

test("In Dev is roster-only and never moves backwards", () => {
  const b = board({ names: { "reviewer-rita": "Rita", hubot: "Botty" } });
  expect(b.it.recordDeploy("dependabot[bot]", at(9), "r", 1)).toBe(false);
  expect(b.it.recordDeploy("reviewer-rita", at(9), "r", 2)).toBe(true);
  expect(b.it.recordDeploy("hubot", at(8), "r", 3)).toBe(false);
  expect(b.it.recordDeploy("hubot", NaN, "r", 4)).toBe(false);
  expect(b.it.snapshot().devDeploy).toEqual({ actor: "Rita", at: at(9), repo: "r", run: 2 });
  expect(b.changes).toBe(1);
});

test("a live Theme lasts until local midnight; last write wins, permanent included", () => {
  const b = board({ clock: at(22), theme: "kernel" });
  b.it.setTheme("arcade");
  expect(b.it.theme()).toEqual({ current: "arcade", default: "kernel" });

  b.it.setTheme("neobrutal", { permanent: true });
  expect(b.it.theme()).toEqual({ current: "neobrutal", default: "neobrutal" });

  b.it.setTheme("arcade");
  b.it.clearTheme();
  expect(b.it.snapshot().theme).toBe("neobrutal");

  b.it.setTheme("arcade");
  b.clock = at(0, 0, 14);
  expect(b.it.snapshot().theme).toBe("neobrutal");
  expect(b.changes).toBe(5);
});

test("a silent Theme change is worn but tells nobody — the Target Hit's takeover already did", () => {
  const b = board();
  b.it.setTheme("arcade", { silent: true });
  expect(b.it.snapshot().theme).toBe("arcade");
  expect(b.changes).toBe(0);
});

test("onChange: midnight always tells once; a Theme expiring off midnight tells once", () => {
  const b = board({ clock: at(23) });
  b.it.rollover();
  expect(b.changes).toBe(1);

  b.it.setTheme("arcade");
  b.it.expireTheme(); // not yet
  expect(b.changes).toBe(2);
  b.clock = at(0, 1, 14); // a clock that jumped past midnight
  b.it.expireTheme();
  b.it.expireTheme();
  expect(b.changes).toBe(3);
  expect(b.it.theme().current).toBe("kernel");
});

test("onChange inside a batch is told once, after the batch, and only if something changed", () => {
  const b = board();
  const told: string[] = [];
  b.it.onChange(() => told.push("snapshot"));
  b.it.batch(() => {
    b.it.record(merge(1, "a"), at(9));
    b.it.record(merge(2, "b"), at(9, 30));
    told.push("event");
  });
  expect(told).toEqual(["event", "snapshot"]);

  b.it.batch(() => b.it.record(merge(1, "a"), at(9))); // a repeat: nothing changed
  expect(told).toEqual(["event", "snapshot"]);
});
