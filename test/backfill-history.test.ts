import { expect, test, vi } from "vitest";
import { createHistory } from "../src/backfill.ts";
import { startOfWeek } from "../src/clock.ts";

// Friday afternoon: the week (from Monday 00:00) is older than the Feed's 24h.
const NOW = Date.parse("2026-08-14T17:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(ms).toISOString();
const ago = (ms: number) => at(NOW - ms);
const REPO = "example-org/projects-app";

/** A fake GitHub GET answering from `routes` by path; anything unrouted is an empty list. */
function fakeGet(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    const answer = routes[path];
    if (answer instanceof Error) throw answer;
    return answer ?? [];
  };
  return { get, asked };
}
const OPEN = `${REPO}/pulls?state=open&per_page=100`;
const CLOSED = `${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
const reviews = (n: number) => `${REPO}/pulls/${n}/reviews`;

const history = (routes: Record<string, unknown>, now = NOW, repos = [REPO]) => {
  const fake = fakeGet(routes);
  return { ...fake, ...createHistory({ get: fake.get, now: () => now, repos }) };
};

test("maps the PR lists and reviews to opened, merged, closed and approved, oldest first", async () => {
  const { backfill } = history({
    [OPEN]: [
      { number: 1, title: "Open", created_at: ago(5 * HOUR), updated_at: ago(HOUR), user: { login: "olly" } },
    ],
    [CLOSED]: [
      {
        number: 2,
        title: "Merged",
        created_at: ago(30 * HOUR),
        updated_at: ago(2 * HOUR),
        closed_at: ago(2 * HOUR),
        merged_at: ago(2 * HOUR),
        // The list API carries no merged_by, so the author stands in.
        user: { login: "mia" },
      },
      {
        number: 3,
        title: "Abandoned",
        created_at: ago(4 * HOUR),
        updated_at: ago(3 * HOUR),
        closed_at: ago(3 * HOUR),
        merged_at: null,
        user: { login: "cal" },
      },
    ],
    [reviews(1)]: [
      { state: "APPROVED", submitted_at: ago(HOUR), user: { login: "rita" } },
      { state: "CHANGES_REQUESTED", submitted_at: ago(90 * MINUTE), user: { login: "rita" } },
    ],
  });

  const event = (type: string, number: number, title: string, actor: string) => ({
    type,
    repo: REPO,
    number,
    title,
    actor,
  });
  expect(await backfill()).toEqual([
    // #2 opened 30h ago: outside the Feed's 24h but inside the week, so Backfill reads it.
    { at: NOW - 30 * HOUR, event: event("pr-opened", 2, "Merged", "mia") },
    { at: NOW - 5 * HOUR, event: event("pr-opened", 1, "Open", "olly") },
    { at: NOW - 4 * HOUR, event: event("pr-opened", 3, "Abandoned", "cal") },
    { at: NOW - 3 * HOUR, event: event("pr-closed", 3, "Abandoned", "cal") },
    { at: NOW - 2 * HOUR, event: event("pr-merged", 2, "Merged", "mia") },
    { at: NOW - HOUR, event: event("review-approved", 1, "Open", "rita") },
  ]);
});

test("events from every repo come back in one oldest-first order", async () => {
  const other = "example-org/features";
  const { backfill } = history(
    {
      [OPEN]: [{ number: 1, title: "Later", created_at: ago(HOUR) }],
      [`${other}/pulls?state=open&per_page=100`]: [
        { number: 1, title: "Earlier", created_at: ago(2 * HOUR) },
      ],
    },
    NOW,
    [REPO, other],
  );

  expect((await backfill()).map(({ event }) => `${event.repo}#${event.title}`)).toEqual([
    `${other}#Earlier`,
    `${REPO}#Later`,
  ]);
});

test("Backfill reaches back to the week start; nothing older, and nothing undated", async () => {
  const monday = startOfWeek(NOW);
  const { backfill } = history({
    [OPEN]: [
      { number: 1, title: "Last week", created_at: at(monday - HOUR) },
      { number: 2, title: "Monday", created_at: at(monday + HOUR) },
      { number: 3, title: "Undated" },
    ],
  });

  expect((await backfill()).map(({ event }) => event.title)).toEqual(["Monday"]);
});

test("a Monday-morning Backfill still reaches 24h back into last week", async () => {
  const MONDAY = Date.parse("2026-08-24T17:00:00Z");
  const sunday = at(new Date(MONDAY).setHours(0, 0, 0, 0) - HOUR);
  const { backfill } = history(
    { [OPEN]: [{ number: 1, title: "Sunday", created_at: sunday }] },
    MONDAY,
  );

  expect((await backfill()).map(({ event }) => event.title)).toEqual(["Sunday"]);
});

test("Reconcile never reaches back past Monday 00:00, when the dedup set forgets last week", async () => {
  const midnight = new Date(Date.parse("2026-08-24T17:00:00Z")).setHours(0, 0, 0, 0);
  const { reconcile } = history(
    {
      [OPEN]: [
        { number: 1, title: "Sunday", created_at: at(midnight - HOUR) },
        { number: 2, title: "Monday", created_at: at(midnight + MINUTE) },
      ],
    },
    midnight + 10 * MINUTE,
  );

  expect((await reconcile()).map(({ event }) => event.title)).toEqual(["Monday"]);
});

test("Reconcile covers the last 24h, leaving the last 2 minutes to their webhooks", async () => {
  const { reconcile } = history({
    [OPEN]: [
      { number: 1, title: "Two days ago", created_at: ago(48 * HOUR) },
      { number: 2, title: "This morning", created_at: ago(5 * HOUR) },
      { number: 3, title: "Just now", created_at: ago(30 * 1000) },
    ],
  });

  expect((await reconcile()).map(({ event }) => event.title)).toEqual(["This morning"]);
});

test("Reconcile refetches reviews only for PRs touched in the last 30 minutes", async () => {
  const { reconcile, asked } = history({
    [OPEN]: [
      { number: 1, title: "Touched", created_at: ago(5 * HOUR), updated_at: ago(10 * MINUTE) },
      { number: 2, title: "Untouched", created_at: ago(5 * HOUR), updated_at: ago(2 * HOUR) },
    ],
    [reviews(1)]: [{ state: "APPROVED", submitted_at: ago(10 * MINUTE), user: { login: "rita" } }],
    [reviews(2)]: [{ state: "APPROVED", submitted_at: ago(2 * HOUR), user: { login: "rita" } }],
  });

  const found = await reconcile();
  expect(asked).toEqual([OPEN, CLOSED, reviews(1)]);
  expect(found.filter(({ event }) => event.type === "review-approved")).toEqual([
    {
      at: NOW - 10 * MINUTE,
      event: { type: "review-approved", repo: REPO, number: 1, title: "Touched", actor: "rita" },
    },
  ]);
});

test("the closed list is read only down to the first PR updated before the window", async () => {
  const { backfill, asked } = history({
    [CLOSED]: [
      { number: 1, title: "Recent", updated_at: ago(HOUR), closed_at: ago(HOUR) },
      { number: 2, title: "Old", updated_at: ago(10 * 24 * HOUR), closed_at: ago(HOUR) },
    ],
  });

  // #2's closed_at is a lie the scan never reaches: the list is newest-updated first.
  expect((await backfill()).map(({ event }) => event.title)).toEqual(["Recent"]);
  expect(asked).not.toContain(reviews(2));
});

test("a repo that errors loses its own history; a PR whose reviews error loses only its approvals", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const broken = "example-org/features";
    const { backfill } = history(
      {
        [`${broken}/pulls?state=open&per_page=100`]: new Error("GitHub API 404"),
        [OPEN]: [{ number: 1, title: "Open", created_at: ago(HOUR), updated_at: ago(HOUR) }],
        [reviews(1)]: new Error("GitHub API 502"),
      },
      NOW,
      [broken, REPO],
    );

    expect((await backfill()).map(({ event }) => `${event.repo}#${event.type}`)).toEqual([
      `${REPO}#pr-opened`,
    ]);
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      `Backfill failed for ${broken}, its history is live-only for now: Error: GitHub API 404`,
      `Backfill skipped reviews for ${REPO}#1: Error: GitHub API 502`,
    ]);
  } finally {
    warn.mockRestore();
  }
});
