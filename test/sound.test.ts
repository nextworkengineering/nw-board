import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import {
  badConfigPath,
  configPath,
  connectedDisplay,
  fixture,
  mergedBody,
  postAndWatch,
} from "./helpers.ts";

const merged = JSON.parse(mergedBody);
const openedBody = JSON.stringify({
  ...merged,
  action: "opened",
  pull_request: { ...merged.pull_request, merged: false },
});
const closedBody = JSON.stringify({
  ...merged,
  action: "closed",
  pull_request: { ...merged.pull_request, merged: false },
});

/**
 * Quiet Hours and Day Chimes are local-time rules, so the clock the tests drive is
 * built in local time. August 2026: the 13th is a Thursday, the 15th a Saturday.
 */
const at = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 7, day, hour, minute, second).getTime();
const THURSDAY = 13;
const SATURDAY = 15;

let running: { port: number; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

test.for([
  ["inside the sound window on a weekday is flagged audible", at(THURSDAY, 10, 0), true],
  ["before the sound window opens is flagged silent", at(THURSDAY, 8, 59), false],
  ["after the sound window closes is flagged silent", at(THURSDAY, 18, 0), false],
  ["at night on a weekday is flagged silent", at(THURSDAY, 22, 30), false],
  ["on a weekend inside the hours is flagged silent", at(SATURDAY, 10, 0), false],
])(
  "a Celebration Event delivered %s",
  async ([, clock, audible]) => {
    running = await startServer(0, { configPath, now: () => clock as number });

    const { received } = await postAndWatch(running.port, { body: mergedBody });

    expect(received).toEqual([
      {
        type: "pr-merged",
        repo: "example-org/projects-app",
        number: 42,
        title: "Add arcade scene renderer",
        actor: "hubot",
        audible,
        teammate: false,
      },
    ]);
  },
);

test.for([
  ["on the names map is flagged a teammate", "reviewer-rita", "Rita", true],
  ["not on the names map is not", "stranger-sam", "stranger-sam", false],
])("a Celebration Event from someone %s", async ([, login, actor, teammate]) => {
  running = await startServer(0, {
    configPath: badConfigPath("config-with-names.json"),
    now: () => at(THURSDAY, 10, 0),
  });

  const body = JSON.stringify({
    ...JSON.parse(fixture("pull-request-review.json")),
    review: { state: "approved", user: { login } },
  });
  const { received } = await postAndWatch(running.port, {
    body,
    event: "pull_request_review",
  });

  // The recorded clip is for teammates; an unmapped actor falls back to the jingle.
  expect(received).toMatchObject([{ type: "review-approved", actor, teammate }]);
});

test("a silent Ambient Event carries no audible flag even inside the sound window", async () => {
  running = await startServer(0, {
    configPath,
    now: () => at(THURSDAY, 10, 0),
  });

  const { received } = await postAndWatch(running.port, { body: closedBody });

  expect(received).toEqual([
    {
      type: "pr-closed",
      repo: "example-org/projects-app",
      number: 42,
      title: "Add arcade scene renderer",
      actor: "octocat",
    },
  ]);
});

/**
 * pr-opened is Ambient but audible: it must carry the same flags a Celebration does,
 * or the board has no way to know whether Quiet Hours silenced it.
 */
test.for([
  ["inside the sound window is flagged audible", at(THURSDAY, 10, 0), true],
  ["outside the sound window is flagged silent", at(THURSDAY, 22, 30), false],
  ["on a weekend is flagged silent", at(SATURDAY, 10, 0), false],
])("an opened PR delivered %s", async ([, clock, audible]) => {
  running = await startServer(0, { configPath, now: () => clock as number });

  const { received } = await postAndWatch(running.port, { body: openedBody });

  expect(received).toEqual([
    {
      type: "pr-opened",
      repo: "example-org/projects-app",
      number: 42,
      title: "Add arcade scene renderer",
      actor: "octocat",
      audible,
      teammate: false,
    },
  ]);
});

/**
 * Boot 10 ms before `next`, move the mutable clock to it, and collect what the display
 * was pushed. While the clock holds just short of the minute the scheduler re-arms for
 * the 10 ms left, so it lands moments after the move.
 */
async function watchClock(next: number) {
  let current = next - 10;
  running = await startServer(0, {
    configPath,
    now: () => current,
  });
  const { ws, messages } = await connectedDisplay(running.port);
  current = next;
  await sleep(200);
  ws.close();
  return messages.filter((message) => message.type !== "snapshot");
}

// Which minutes chime, and the `last` flag, are dueAt's (test/scheduler.test.ts); these
// check the config's chimes reach a connected display.
test.for([
  ["the start of the workday", at(THURSDAY, 9, 0), { at: "09:00", last: false }],
  // The latest configured chime is flagged, so the board ends the day on it.
  ["the end of the workday", at(THURSDAY, 17, 0), { at: "17:00", last: true }],
])(
  "the clock reaching %s on a weekday pushes exactly one Day Chime",
  async ([, after, chime]) => {
    const received = await watchClock(after as number);

    // Once, though the scheduler woke every 10ms on the way to the minute.
    expect(received).toEqual([{ type: "day-chime", ...(chime as object) }]);
  },
);

test.for([
  ["a Quiet Hours window that is not HH:MM", "config-bad-quiet-hours.json", /quietHours/],
  ["a chime list that is not a list", "config-chimes-not-a-list.json", /chimes/],
])("the server refuses to start when the config has %s", async ([, file, message]) => {
  await expect(
    startServer(0, { configPath: badConfigPath(file as string) }),
  ).rejects.toThrow(message as RegExp);
});
