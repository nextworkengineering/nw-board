import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import {
  badConfigPath,
  configPath,
  connectedDisplay,
  fixture,
  postWebhook,
  readSnapshot,
} from "./helpers.ts";

const merged = fixture("pull-request-merged.json"); // hubot merged projects-app#42
const review = fixture("pull-request-review.json"); // reviewer-rita on features#7
const comment = fixture("issue-comment.json"); // commenter-carl on content#13
const changesRequested = JSON.stringify({
  ...JSON.parse(review),
  review: { state: "changes_requested", user: { login: "reviewer-rita" } },
});

const start = (now?: () => number) => startServer(0, { configPath, now });

let running: { port: number; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

// Merges by other actors, built from the merged fixture.
const mergeBy = (number: number, login: string) =>
  JSON.stringify({
    ...JSON.parse(merged),
    pull_request: {
      ...JSON.parse(merged).pull_request,
      number,
      merged_by: { login },
    },
  });

test("today's MVP is the Actor with the most PR merges — other event types don't count", async () => {
  running = await start();

  // Rita racks up reviews, Carl comments twice; none of it counts.
  await postWebhook(running.port, { body: comment, event: "issue_comment" });
  await postWebhook(running.port, { body: comment, event: "issue_comment" });
  await postWebhook(running.port, { body: review, event: "pull_request_review" });
  await postWebhook(running.port, { body: changesRequested, event: "pull_request_review" });
  await postWebhook(running.port, { body: merged }); // hubot
  await postWebhook(running.port, { body: merged }); // repeat: dropped, counts once
  await postWebhook(running.port, { body: mergeBy(43, "hubot") });
  await postWebhook(running.port, { body: mergeBy(44, "octocat") });

  expect((await readSnapshot(running.port)).mvp).toEqual({
    names: ["hubot"],
    count: 2,
  });
});

test("events from before local midnight do not count toward today's MVP", async () => {
  let clock = new Date(2026, 7, 13, 23, 0, 0).getTime(); // Thursday, late
  running = await start(() => clock);

  await postWebhook(running.port, { body: merged }); // hubot, yesterday
  clock = new Date(2026, 7, 14, 9, 30, 0).getTime(); // Friday morning
  await postWebhook(running.port, { body: mergeBy(43, "octocat") });

  // Yesterday's merge is still inside the 24h Feed, but the MVP only counts today.
  expect((await readSnapshot(running.port)).mvp).toEqual({
    names: ["octocat"],
    count: 1,
  });
});

test("a day with no merges has no MVP, however busy it was otherwise", async () => {
  running = await start();
  expect((await readSnapshot(running.port)).mvp).toBe(null);

  await postWebhook(running.port, { body: comment, event: "issue_comment" });
  await postWebhook(running.port, { body: review, event: "pull_request_review" });
  expect((await readSnapshot(running.port)).mvp).toBe(null);
});

test("a tie for today's MVP names every contender, ordered by first merge", async () => {
  running = await start();

  await postWebhook(running.port, { body: merged }); // hubot
  await postWebhook(running.port, { body: mergeBy(44, "octocat") });
  await postWebhook(running.port, { body: mergeBy(45, "monalisa") });

  expect((await readSnapshot(running.port)).mvp).toEqual({
    names: ["hubot", "octocat", "monalisa"],
    count: 1,
  });
});

test("pulling ahead of an accumulated tie clears the other contenders", async () => {
  running = await start();

  await postWebhook(running.port, { body: merged }); // hubot ×1
  await postWebhook(running.port, { body: mergeBy(44, "octocat") });
  await postWebhook(running.port, { body: mergeBy(45, "octocat") });

  expect((await readSnapshot(running.port)).mvp).toEqual({
    names: ["octocat"],
    count: 2,
  });
});

test.for([
  ["a Celebration Event", { body: merged }, { names: ["hubot"], count: 1 }],
  ["an Ambient Event", { body: comment, event: "issue_comment" }, null],
])("%s delivery carries the updated MVP to a connected display", async ([, options, mvp]) => {
  running = await start();
  const { ws, messages } = await connectedDisplay(running.port);

  await postWebhook(running.port, options as any);
  await sleep(50);
  ws.close();

  // The MVP after the delivery, without the display having to reconnect.
  expect(messages.at(-1).mvp).toEqual(mvp);
});

test("a display left connected across local midnight is pushed the reset MVP", async () => {
  let clock = new Date(2026, 7, 13, 23, 30, 0).getTime(); // Thursday, late
  running = await startServer(0, { configPath, now: () => clock, tickMs: 10 });
  await postWebhook(running.port, { body: merged });
  const { ws, messages } = await connectedDisplay(running.port);

  clock = new Date(2026, 7, 14, 0, 30, 0).getTime(); // just past midnight
  await sleep(100);
  ws.close();

  const snapshots = messages.filter((m) => m.type === "snapshot");
  // The snapshot sent on connect, then exactly one for the day rolling over —
  // not one per tick.
  expect(snapshots.map((s) => s.mvp)).toEqual([{ names: ["hubot"], count: 1 }, null]);
});

test("the MVP is named by the config names map, not the raw login", async () => {
  running = await startServer(0, { configPath: badConfigPath("config-with-names.json") });

  await postWebhook(running.port, { body: merged }); // merged_by hubot -> "Botty"

  expect((await readSnapshot(running.port)).mvp).toEqual({ names: ["Botty"], count: 1 });
});

test("the board shows a team member's first name from the config names map, and the raw login when unmapped", async () => {
  const named = badConfigPath("config-with-names.json");
  running = await startServer(0, { configPath: named });

  await postWebhook(running.port, { body: merged }); // merged_by hubot -> "Botty"
  await postWebhook(running.port, { body: comment, event: "issue_comment" }); // commenter-carl unmapped

  const snapshot = await readSnapshot(running.port);
  expect(snapshot.feed.map((e: any) => [e.type, e.actor])).toEqual([
    ["pr-merged", "Botty"],
    ["pr-comment", "commenter-carl"],
  ]);
});
