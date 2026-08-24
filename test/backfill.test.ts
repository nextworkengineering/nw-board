import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import {
  configPath,
  connectedDisplay,
  postWebhook,
  readSnapshot as connectAndReadSnapshot,
} from "./helpers.ts";

// Backfill is the one thing that talks to the GitHub API, so it is the one test file
// that sets a token — always pointed at the stub base below, never api.github.com.
process.env.GITHUB_TOKEN = "test-pat";

// Friday, so "three days ago" is still inside the current week (Mon 00:00).
const NOW = Date.parse("2026-08-14T17:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let running: { port: number; close: () => Promise<void> } | undefined;
const stubs: Server[] = [];
afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(
    stubs.splice(0).map((s) => new Promise((done) => s.close(done))),
  );
});

/** A stand-in GitHub API: `handler` answers each request, `requests` records them. */
async function stubGitHubApi(handler: (url: string) => unknown) {
  const requests: { url: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url!, authorization: req.headers.authorization });
    const body = handler(req.url!);
    if (typeof body === "number") {
      res.writeHead(body);
      res.end("no");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body ?? []));
  });
  await new Promise<void>((listening) =>
    server.listen(0, "127.0.0.1", listening),
  );
  stubs.push(server);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, requests };
}

const start = (githubApiBase: string) =>
  startServer(0, { configPath, now: () => NOW, githubApiBase });

/** Answers for one Tracked Repo; the other Tracked Repos have nothing. */
const onlyProjectsApp =
  (open: unknown[], closed: unknown[]) => (url: string) => {
    if (!url.includes("/example-org/projects-app/")) return [];
    return url.includes("state=open") ? open : closed;
  };

test("a display connecting right after boot receives a snapshot of the backfilled open and merged PRs", async () => {
  const api = await stubGitHubApi(
    onlyProjectsApp(
      [
        {
          number: 1,
          title: "Open one",
          created_at: ago(2 * HOUR),
          user: { login: "octocat" },
        },
      ],
      [
        {
          number: 2,
          title: "Merged one",
          updated_at: ago(HOUR),
          merged_at: ago(HOUR),
          user: { login: "author-alice" },
        },
        {
          number: 3,
          title: "Abandoned one",
          updated_at: ago(3 * HOUR),
          merged_at: null,
          user: { login: "author-alice" },
        },
      ],
    ),
  );

  running = await start(api.base);

  const snapshot = await connectAndReadSnapshot(running!.port);
  // Backfilled entries keep the GitHub timestamps they actually happened at.
  expect(snapshot.feed).toEqual([
    {
      type: "pr-opened",
      repo: "example-org/projects-app",
      number: 1,
      title: "Open one",
      actor: "octocat",
      at: NOW - 2 * HOUR,
    },
    {
      type: "pr-merged",
      repo: "example-org/projects-app",
      number: 2,
      title: "Merged one",
      // The list API returns no merged_by, so Backfill credits the author.
      actor: "author-alice",
      at: NOW - HOUR,
    },
  ]);
  expect(api.requests[0]!.authorization).toContain("test-pat");
});

const mergedEvent = {
  type: "pr-merged",
  repo: "example-org/projects-app",
  number: 42,
  title: "Add arcade scene renderer",
  actor: "hubot",
};

test.for([
  // Nothing listens on port 1, so the request is refused outright.
  ["refuses the connection", async () => "http://127.0.0.1:1"],
  ["answers with a 500", async () => (await stubGitHubApi(() => 500)).base],
  [
    "answers with something that is not JSON",
    async () => (await stubGitHubApi(() => "<html>rate limited</html>")).base,
  ],
])(
  "a Backfill against a GitHub API that %s leaves the server running and serving live webhooks",
  async ([, apiBase]) => {
    running = await start(await (apiBase as () => Promise<string>)());

    const response = await postWebhook(running!.port);
    expect(response.status).toBe(204);
    const snapshot = await connectAndReadSnapshot(running!.port);
    expect(snapshot.feed).toEqual([{ ...mergedEvent, at: NOW }]);
  },
);

test("a webhook for a PR that Backfill already recorded does not duplicate the Feed entry", async () => {
  const api = await stubGitHubApi(
    onlyProjectsApp(
      [],
      [
        {
          number: 42,
          title: "Add arcade scene renderer",
          updated_at: ago(HOUR),
          merged_at: ago(HOUR),
          user: { login: "octocat" },
        },
      ],
    ),
  );
  running = await start(api.base);

  await postWebhook(running!.port);

  // Backfill got there first, so the entry keeps the merge time GitHub reported —
  // and its author stand-in for the actor, rather than the webhook's merger.
  const snapshot = await connectAndReadSnapshot(running!.port);
  expect(snapshot.feed).toEqual([
    { ...mergedEvent, actor: "octocat", at: NOW - HOUR },
  ]);
});

test("a redelivered webhook for a merge Backfill recorded more than 24 hours ago is dropped", async () => {
  const api = await stubGitHubApi(
    onlyProjectsApp(
      [],
      [
        {
          number: 42,
          title: "Add arcade scene renderer",
          updated_at: ago(72 * HOUR),
          merged_at: ago(72 * HOUR),
        },
      ],
    ),
  );
  running = await start(api.base);

  // The Backfilled merge is three days old, so it is already outside the 24h Feed;
  // the dedup set outlives the Feed by a week, so the redelivery must not re-record it
  // (which would stamp a three-day-old merge as happening now).
  const backfilled = await connectAndReadSnapshot(running!.port);
  const { ws, messages } = await connectedDisplay(running!.port);
  await postWebhook(running!.port);
  await sleep(50);
  ws.close();

  expect(backfilled.feed).toEqual([]);
  expect(messages.filter((m) => m.type !== "snapshot")).toEqual([]);
  const after = await connectAndReadSnapshot(running!.port);
  expect(after.feed).toEqual([]);
  expect(after.mvp).toBe(null);
});

test("Backfilled events older than 24 hours are kept out of the Feed snapshot", async () => {
  const api = await stubGitHubApi(
    onlyProjectsApp(
      [
        {
          number: 1,
          title: "Stale open one",
          created_at: ago(72 * HOUR),
          user: { login: "stale-sam" },
        },
      ],
      [
        {
          number: 2,
          title: "Merged on Tuesday",
          updated_at: ago(72 * HOUR),
          merged_at: ago(72 * HOUR),
          user: { login: "author-alice" },
        },
        {
          number: 3,
          title: "Merged an hour ago",
          updated_at: ago(HOUR),
          merged_at: ago(HOUR),
          user: { login: "author-alice" },
        },
      ],
    ),
  );

  running = await start(api.base);

  const snapshot = await connectAndReadSnapshot(running!.port);
  expect(snapshot.feed).toEqual([
    {
      type: "pr-merged",
      repo: "example-org/projects-app",
      number: 3,
      title: "Merged an hour ago",
      actor: "author-alice",
      at: NOW - HOUR,
    },
  ]);
  // The open PR is state, not a 24h event: it stays on the board however old it is,
  // carrying its author.
  expect(snapshot.openPrs).toEqual([
    {
      repo: "example-org/projects-app",
      number: 1,
      title: "Stale open one",
      actor: "stale-sam",
    },
  ]);
});

test("Backfilled approvals reach the Feed, but reviews alone make no MVP", async () => {
  const DAY = 24 * HOUR;
  const api = await stubGitHubApi((url) => {
    if (!url.includes("/example-org/projects-app/")) return [];
    if (url.includes("/pulls/7/reviews"))
      return [
        // Last week's approval: too old for both the Feed and today's MVP.
        {
          state: "APPROVED",
          submitted_at: ago(10 * DAY),
          user: { login: "old-olive" },
        },
        {
          state: "APPROVED",
          submitted_at: ago(2 * HOUR),
          user: { login: "reviewer-rita" },
        },
        {
          state: "CHANGES_REQUESTED",
          submitted_at: ago(HOUR),
          user: { login: "reviewer-rita" },
        },
      ];
    if (url.includes("state=open"))
      return [
        {
          number: 7,
          title: "Wire up the Feed",
          created_at: ago(3 * HOUR),
          updated_at: ago(HOUR),
          // Rita opened it too, so her count only reaches 2 if the approval counts.
          user: { login: "reviewer-rita" },
        },
      ];
    return [];
  });

  running = await start(api.base);

  const snapshot = await connectAndReadSnapshot(running!.port);
  // Rita opened and approved today, but the crown is merges-only.
  expect(snapshot.mvp).toBe(null);
  expect(snapshot.feed).toEqual([
    {
      type: "pr-opened",
      repo: "example-org/projects-app",
      number: 7,
      title: "Wire up the Feed",
      actor: "reviewer-rita",
      at: NOW - 3 * HOUR,
    },
    {
      type: "review-approved",
      repo: "example-org/projects-app",
      number: 7,
      title: "Wire up the Feed",
      actor: "reviewer-rita",
      at: NOW - 2 * HOUR,
    },
  ]);
});

test("a Backfilled PR with no usable timestamp does not freeze Feed expiry", async () => {
  const api = await stubGitHubApi(
    onlyProjectsApp(
      // No created_at at all: nothing to place it in the 24h window with.
      [{ number: 1, title: "Undated open one" }],
      [
        {
          number: 3,
          title: "Merged an hour ago",
          updated_at: ago(HOUR),
          merged_at: ago(HOUR),
        },
      ],
    ),
  );
  let clock = NOW;
  running = await startServer(0, {
    configPath,
    now: () => clock,
    githubApiBase: api.base,
  });

  clock = NOW + 48 * HOUR;

  // The undated entry must not sit at the head of the Feed blocking every expiry
  // behind it — two days on, nothing from before the boot is left.
  expect((await connectAndReadSnapshot(running!.port)).feed).toEqual([]);
});

test("a missing GITHUB_TOKEN skips Backfill instead of crashing the server", async () => {
  const api = await stubGitHubApi(
    onlyProjectsApp(
      [{ number: 1, title: "Open one", created_at: ago(HOUR) }],
      [],
    ),
  );
  delete process.env.GITHUB_TOKEN;
  try {
    running = await start(api.base);
  } finally {
    process.env.GITHUB_TOKEN = "test-pat";
  }

  expect((await postWebhook(running!.port)).status).toBe(204);
  const snapshot = await connectAndReadSnapshot(running!.port);
  expect(snapshot.feed).toEqual([{ ...mergedEvent, at: NOW }]);
  expect(api.requests).toEqual([]);
});

test("a Tracked Repo the token cannot read loses only its own history, not the whole board", async () => {
  const { base } = await stubGitHubApi((url) => {
    // The PAT was never granted `features`: GitHub answers 404 for it.
    if (url.includes("/example-org/features/")) return 404;
    if (url.includes("/example-org/projects-app/pulls?state=closed"))
      return [
        {
          number: 2359,
          title: "Upgrade Gemini models",
          user: { login: "krishna" },
          updated_at: ago(2 * HOUR),
          merged_at: ago(2 * HOUR),
        },
      ];
    return [];
  });
  running = await start(base);

  // projects-app's merge from earlier today must survive features' 404.
  const snapshot = await connectAndReadSnapshot(running.port);
  expect(snapshot.feed).toEqual([
    {
      type: "pr-merged",
      repo: "example-org/projects-app",
      number: 2359,
      title: "Upgrade Gemini models",
      actor: "krishna",
      at: NOW - 2 * HOUR,
    },
  ]);
});

test("a merge Backfilled from earlier today counts toward the MVP", async () => {
  const api = await stubGitHubApi((url) => {
    if (url.includes("state=closed") && url.includes("/projects-app/"))
      return [
        {
          number: 9,
          title: "Ship the ticker",
          user: { login: "merge-mike" },
          updated_at: ago(2 * HOUR),
          merged_at: ago(2 * HOUR),
        },
      ];
    return [];
  });
  running = await start(api.base);

  expect((await connectAndReadSnapshot(running!.port)).mvp).toEqual({
    names: ["merge-mike"],
    count: 1,
  });
});

test("a Monday-morning boot still backfills the Feed's last 24h from before the week started", async () => {
  // Monday noon local: the week began hours ago, so most of the Feed's 24h window
  // sits in last week. Derived from local midnight so the gap holds in any timezone.
  const MONDAY = Date.parse("2026-08-24T17:00:00Z");
  const beforeTheWeek = new Date(MONDAY).setHours(0, 0, 0, 0) - HOUR;
  const api = await stubGitHubApi(
    onlyProjectsApp(
      [],
      [
        {
          number: 9,
          title: "Merged on Sunday",
          updated_at: new Date(beforeTheWeek).toISOString(),
          merged_at: new Date(beforeTheWeek).toISOString(),
          user: { login: "author-alice" },
        },
      ],
    ),
  );

  running = await startServer(0, {
    configPath,
    now: () => MONDAY,
    githubApiBase: api.base,
  });

  const snapshot = await connectAndReadSnapshot(running!.port);
  expect(snapshot.feed).toEqual([
    {
      type: "pr-merged",
      repo: "example-org/projects-app",
      number: 9,
      title: "Merged on Sunday",
      actor: "author-alice",
      at: beforeTheWeek,
    },
  ]);
});
