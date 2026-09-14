import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import {
  type PostOptions,
  badConfigPath,
  configPath,
  connectedDisplay,
  fixture,
  mergedBody as rawBody,
  postAndWatch,
  postWebhook,
  readSnapshot as connectAndReadSnapshot,
  SECRET,
  sign,
} from "./helpers.ts";

// Celebration Events are flagged by Quiet Hours, so the default clock is pinned inside
// the sound window (Thursday 2026-08-13, 10:00 local) rather than left to wall time.
const IN_THE_SOUND_WINDOW = new Date(2026, 7, 13, 10, 0).getTime();
const start = (now: () => number = () => IN_THE_SOUND_WINDOW) =>
  startServer(0, { configPath, now });

let running: { port: number; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

test("a signed merged-PR webhook from a Tracked Repo pushes a pr-merged Celebration Event to the display", async () => {
  running = await start();

  const { status, received } = await postAndWatch(running.port);

  expect(status).toBe(204);
  expect(received).toEqual([
    {
      type: "pr-merged",
      repo: "example-org/projects-app",
      number: 42,
      // A merge is credited to whoever pressed the button, not the author (octocat).
      actor: "hubot",
      title: "Add arcade scene renderer",
      audible: true,
      // The default config carries no names map, so nobody is on the roster.
      teammate: false,
    },
  ]);
});

test.for([
  ["a wrong", sign(rawBody, "not-the-webhook-secret")],
  ["a missing", ""],
])(
  "a merged-PR webhook with %s signature is rejected and pushes no Celebration Event",
  async ([, signature]) => {
    running = await start();

    const { status, received } = await postAndWatch(running.port, {
      signature,
    });

    expect(status).toBe(401);
    expect(received).toEqual([]);
  },
);

const merged = JSON.parse(rawBody);

test("a merged-PR webhook with a very long PR description still pushes the Celebration Event", async () => {
  running = await start();
  const body = JSON.stringify({
    ...merged,
    pull_request: { ...merged.pull_request, body: "x".repeat(200_000) },
  });

  const { status, received } = await postAndWatch(running.port, { body });

  expect(status).toBe(204);
  expect(received).toEqual([
    {
      type: "pr-merged",
      repo: "example-org/projects-app",
      number: 42,
      title: "Add arcade scene renderer",
      actor: "hubot",
      audible: true,
      teammate: false,
    },
  ]);
});

test("a merged-PR webhook naming no merger credits the PR author instead", async () => {
  running = await start();
  const body = JSON.stringify({
    ...merged,
    pull_request: { ...merged.pull_request, merged_by: null },
  });

  const { received } = await postAndWatch(running.port, { body });

  expect(received[0].actor).toBe("octocat");
});

const reviewBody = fixture("pull-request-review.json");
const review = JSON.parse(reviewBody);
const commentBody = fixture("issue-comment.json");

test("a review whose submitter carries no login records an empty actor rather than undefined", async () => {
  running = await start();
  const body = JSON.stringify({ ...review, review: { state: "approved" } });

  const { received } = await postAndWatch(running.port, {
    body,
    event: "pull_request_review",
  });

  expect(received).toEqual([
    {
      type: "review-approved",
      repo: "example-org/features",
      number: 7,
      title: "Wire up the Feed",
      actor: "",
      audible: true,
      teammate: false,
    },
  ]);
});

const withPullRequest = (patch: Record<string, unknown>) =>
  JSON.stringify({
    ...merged,
    ...patch,
    pull_request: { ...merged.pull_request, merged: false },
  });

test.for([
  [
    // Ambient, but the one that makes a noise, so it carries the sound flags too.
    "a pr-opened Ambient Event",
    { body: withPullRequest({ action: "opened" }) },
    {
      type: "pr-opened",
      repo: "example-org/projects-app",
      number: 42,
      title: "Add arcade scene renderer",
      actor: "octocat",
      audible: true,
      teammate: false,
    },
  ],
  [
    "a pr-closed Ambient Event",
    { body: withPullRequest({ action: "closed" }) },
    {
      type: "pr-closed",
      repo: "example-org/projects-app",
      number: 42,
      title: "Add arcade scene renderer",
      actor: "octocat",
    },
  ],
  [
    "a review-approved Celebration Event",
    { body: reviewBody, event: "pull_request_review" },
    {
      type: "review-approved",
      repo: "example-org/features",
      number: 7,
      title: "Wire up the Feed",
      // The reviewer, not the PR's author-alice.
      actor: "reviewer-rita",
      audible: true,
      teammate: false,
    },
  ],
  [
    "a changes-requested Ambient Event",
    {
      body: JSON.stringify({
        ...review,
        review: { ...review.review, state: "changes_requested" },
      }),
      event: "pull_request_review",
    },
    {
      type: "changes-requested",
      repo: "example-org/features",
      number: 7,
      title: "Wire up the Feed",
      actor: "reviewer-rita",
    },
  ],
  [
    "a pr-comment Ambient Event",
    { body: commentBody, event: "issue_comment" },
    {
      type: "pr-comment",
      repo: "example-org/content",
      number: 13,
      title: "Load the sprite sheet",
      // The commenter, not the PR's author-alice.
      actor: "commenter-carl",
    },
  ],
])("a signed webhook from a Tracked Repo pushes %s to the display", async ([
  ,
  options,
  expected,
]) => {
  running = await start();

  const { status, received } = await postAndWatch(
    running.port,
    options as PostOptions,
  );

  expect(status).toBe(204);
  expect(received).toEqual([expected]);
});

test.for([
  ["the ping sent when a webhook is registered", { event: "ping", body: '{"zen":"Non-blocking is better than blocking."}' }],
  [
    "a review dismissed rather than submitted",
    { body: JSON.stringify({ ...review, action: "dismissed" }), event: "pull_request_review" },
  ],
  [
    "a comment on an issue that is not a pull request",
    {
      body: '{"action":"created","issue":{"number":9,"title":"Wishlist"},"repository":{"full_name":"example-org/projects-app"}}',
      event: "issue_comment",
    },
  ],
  [
    "a delivery with no pull request at all",
    { body: '{"action":"closed","repository":{"full_name":"example-org/projects-app"}}' },
  ],
])(
  "%s is accepted but pushes no domain event",
  async ([, options]) => {
    running = await start();

    const { status, received } = await postAndWatch(
      running.port,
      options as PostOptions,
    );

    expect(status).toBe(204);
    expect(received).toEqual([]);
  },
);

test("a merged-PR webhook from a repo that is not a Tracked Repo is accepted but pushes no domain event", async () => {
  running = await start();
  const body = JSON.stringify({
    ...merged,
    repository: { full_name: "someone-else/not-our-repo" },
  });

  const { status, received } = await postAndWatch(running.port, { body });

  expect(status).toBe(204);
  expect(received).toEqual([]);
  const snapshot = await connectAndReadSnapshot(running.port);
  expect(snapshot.feed).toEqual([]);
});

test("a display connecting receives a snapshot of the Feed reflecting earlier events", async () => {
  running = await start();
  await postWebhook(running.port);
  await postWebhook(running.port, {
    body: commentBody,
    event: "issue_comment",
  });

  const snapshot = await connectAndReadSnapshot(running.port);

  expect(snapshot).toEqual({
    type: "snapshot",
    // Hubot and Carl have one event each today; hubot's landed first.
    mvp: { names: ["hubot"], count: 1 },
    // #42 was merged, never seen open, so nothing is in flight.
    openPrs: [],
    // No deploy webhook has landed, so the header names nobody in dev.
    devDeploy: null,
    // Snapshot entries carry the server timestamp they were recorded at, so a
    // display can expire them itself rather than restamping them on receipt.
    feed: [
      {
        type: "pr-merged",
        repo: "example-org/projects-app",
        number: 42,
        title: "Add arcade scene renderer",
        actor: "hubot",
        at: IN_THE_SOUND_WINDOW,
      },
      {
        type: "pr-comment",
        repo: "example-org/content",
        number: 13,
        title: "Load the sprite sheet",
        actor: "commenter-carl",
        at: IN_THE_SOUND_WINDOW,
      },
    ],
  });
});

test("an opened PR stays on the board as state until it is merged", async () => {
  running = await start();

  await postWebhook(running.port, { body: withPullRequest({ action: "opened" }) });
  const inFlight = await connectAndReadSnapshot(running.port);
  await postWebhook(running.port);
  const afterMerge = await connectAndReadSnapshot(running.port);

  // An in-flight PR carries its author, so the board can show whose it is.
  expect(inFlight.openPrs).toEqual([
    {
      repo: "example-org/projects-app",
      number: 42,
      title: "Add arcade scene renderer",
      actor: "octocat",
    },
  ]);
  expect(afterMerge.openPrs).toEqual([]);
});

test("a pr-opened delivery reaches a connected display's in-flight list without a reconnect", async () => {
  running = await start();
  const { ws, messages } = await connectedDisplay(running.port);

  await postWebhook(running.port, { body: withPullRequest({ action: "opened" }) });
  await sleep(50);
  ws.close();

  expect(messages.at(-1).openPrs).toEqual([
    {
      repo: "example-org/projects-app",
      number: 42,
      title: "Add arcade scene renderer",
      actor: "octocat",
    },
  ]);
});

const prComment = {
  type: "pr-comment",
  repo: "example-org/content",
  number: 13,
  title: "Load the sprite sheet",
  actor: "commenter-carl",
};

test("a second comment on the same PR is its own Ambient Event rather than a swallowed repeat", async () => {
  running = await start();

  await postWebhook(running.port, { body: commentBody, event: "issue_comment" });
  const { received } = await postAndWatch(running.port, {
    body: commentBody,
    event: "issue_comment",
  });

  expect(received).toEqual([prComment]);
  const snapshot = await connectAndReadSnapshot(running.port);
  const stamped = { ...prComment, at: IN_THE_SOUND_WINDOW };
  expect(snapshot.feed).toEqual([stamped, stamped]);
});

/** The same PR approved by `login`. */
const approvalFrom = (login: string) =>
  JSON.stringify({ ...review, review: { state: "approved", user: { login } } });

test("a second approval of the same PR by another reviewer is its own Celebration Event", async () => {
  running = await start();

  await postWebhook(running.port, {
    body: approvalFrom("reviewer-rita"),
    event: "pull_request_review",
  });
  const { received } = await postAndWatch(running.port, {
    body: approvalFrom("reviewer-raj"),
    event: "pull_request_review",
  });

  expect(received).toMatchObject([{ type: "review-approved", actor: "reviewer-raj" }]);
});

test("the same reviewer approving the same PR twice is still dropped as a repeat", async () => {
  running = await start();

  await postWebhook(running.port, {
    body: approvalFrom("reviewer-rita"),
    event: "pull_request_review",
  });
  const { received } = await postAndWatch(running.port, {
    body: approvalFrom("reviewer-rita"),
    event: "pull_request_review",
  });

  expect(received).toEqual([]);
});

test("a display that reconnects after a dropped socket receives a fresh snapshot", async () => {
  running = await start();
  await postWebhook(running.port);

  const firstSnapshot = await connectAndReadSnapshot(running.port);
  await postWebhook(running.port, {
    body: commentBody,
    event: "issue_comment",
  });
  const secondSnapshot = await connectAndReadSnapshot(running.port);

  expect(firstSnapshot.feed).toHaveLength(1);
  expect(secondSnapshot.feed).toEqual([
    {
      type: "pr-merged",
      repo: "example-org/projects-app",
      number: 42,
      title: "Add arcade scene renderer",
      actor: "hubot",
      at: IN_THE_SOUND_WINDOW,
    },
    {
      type: "pr-comment",
      repo: "example-org/content",
      number: 13,
      title: "Load the sprite sheet",
      actor: "commenter-carl",
      at: IN_THE_SOUND_WINDOW,
    },
  ]);
});

test.for([
  [
    "a review delivery carrying no pull request",
    {
      event: "pull_request_review",
      body: '{"action":"submitted","review":{"state":"approved"},"repository":{"full_name":"example-org/features"}}',
    },
  ],
  [
    "an opened delivery whose pull request is not an object",
    {
      body: '{"action":"opened","pull_request":"nope","repository":{"full_name":"example-org/projects-app"}}',
    },
  ],
  [
    "a PR comment delivery whose issue has no number",
    {
      event: "issue_comment",
      body: '{"action":"created","issue":{"pull_request":{}},"repository":{"full_name":"example-org/content"}}',
    },
  ],
])(
  "%s is accepted, pushes no domain event, and leaves the Feed empty",
  async ([, options]) => {
    running = await start();

    const { status, received } = await postAndWatch(
      running.port,
      options as PostOptions,
    );

    expect(status).toBe(204);
    expect(received).toEqual([]);
    const snapshot = await connectAndReadSnapshot(running.port);
    expect(snapshot.feed).toEqual([]);
  },
);

test("advancing the clock 24 hours past an event expires it from later Feed snapshots", async () => {
  const HOUR = 60 * 60 * 1000;
  const START = Date.parse("2026-08-13T09:00:00Z");
  let clock = START;
  running = await start(() => clock);

  await postWebhook(running.port);
  clock += 23 * HOUR;
  await postWebhook(running.port, {
    body: commentBody,
    event: "issue_comment",
  });
  clock += 1 * HOUR;

  const snapshot = await connectAndReadSnapshot(running.port);

  expect(snapshot.feed).toEqual([
    {
      type: "pr-comment",
      repo: "example-org/content",
      number: 13,
      title: "Load the sprite sheet",
      actor: "commenter-carl",
      at: START + 23 * HOUR,
    },
  ]);
});

test("a signed delivery with a malformed body is rejected without leaking a stack trace", async () => {
  running = await start();

  const response = await postWebhook(running.port, { body: "not json" });

  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("/Users");
});

test.for([
  ["has no Tracked Repo list", "config-missing-tracked-repos.json"],
  ["has a Tracked Repo list that is not a list", "config-tracked-repos-not-a-list.json"],
])("the server refuses to start when the config %s", async ([, file]) => {
  await expect(
    startServer(0, { configPath: badConfigPath(file!) }),
  ).rejects.toThrow(
    /trackedRepos/,
  );
});

test("the server refuses to start without a webhook secret configured", async () => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  try {
    await expect(startServer(0)).rejects.toThrow(/GITHUB_WEBHOOK_SECRET/);
  } finally {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  }
});

test("an unsigned webhook with no Content-Type is rejected and pushes no Celebration Event", async () => {
  running = await start();

  const { status, received } = await postAndWatch(running.port, {
    contentType: "",
    signature: "",
  });

  expect(status).toBe(401);
  expect(received).toEqual([]);
});

// The last human to deploy to dev: a successful run of the configured workflow,
// shown on the Feed header rather than in the Feed.
const deployRun = (change: (run: any) => void = () => {}) => {
  const payload = JSON.parse(fixture("workflow-run-dev-deploy.json"));
  change(payload.workflow_run);
  return JSON.stringify(payload);
};
const startWithNames = () =>
  startServer(0, {
    configPath: badConfigPath("config-with-names.json"),
    now: () => IN_THE_SOUND_WINDOW,
  });

test("a successful dev deploy names its triggering teammate on the next snapshot", async () => {
  running = await startWithNames();

  const status = (await postWebhook(running.port, {
    body: deployRun(),
    event: "workflow_run",
  })).status;
  const snapshot = await connectAndReadSnapshot(running.port);

  expect(status).toBe(204);
  // The display name from the names map, not the login.
  expect(snapshot.devDeploy).toEqual({ actor: "Rita", at: Date.parse("2026-08-13T09:41:00Z"), repo: "example-org/projects-app", run: 42 });
  // A deploy is not a Feed event.
  expect(snapshot.feed).toEqual([]);
});

test.for([
  ["a failed run", deployRun((run) => (run.conclusion = "failure"))],
  ["a run of another workflow", deployRun((run) => (run.path = ".github/workflows/env-prod.yaml"))],
  ["a run triggered off the roster", deployRun((run) => (run.triggering_actor = { login: "dependabot[bot]" }))],
])("%s names nobody in dev", async ([, body]) => {
  running = await startWithNames();

  await postWebhook(running.port, { body: body as string, event: "workflow_run" });

  expect((await connectAndReadSnapshot(running.port)).devDeploy).toBe(null);
});

test("an older dev deploy delivered late does not replace a newer one", async () => {
  running = await startWithNames();

  await postWebhook(running.port, { body: deployRun(), event: "workflow_run" });
  await postWebhook(running.port, {
    body: deployRun((run) => {
      run.updated_at = "2026-08-13T08:00:00Z";
      run.triggering_actor = { login: "hubot" };
    }),
    event: "workflow_run",
  });

  expect((await connectAndReadSnapshot(running.port)).devDeploy?.actor).toBe("Rita");
});
