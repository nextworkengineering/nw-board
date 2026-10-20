import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import { configPath, connectedDisplay } from "./helpers.ts";

// The board's days are US Central days, on the Pi's clock as in the queries. Pin the
// zone so a "19:30 Central" below is that instant on any machine.
process.env.TZ = "America/Chicago";

let running: { port: number; close: () => Promise<void> } | undefined;
const upstreams: Server[] = [];
const originalToken = process.env.POSTHOG_PERSONAL_API_KEY;

beforeEach(() => {
  process.env.POSTHOG_PERSONAL_API_KEY = "test-posthog-token";
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(
    upstreams.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((done) => server.close(() => done()));
    }),
  );
  if (originalToken === undefined) delete process.env.POSTHOG_PERSONAL_API_KEY;
  else process.env.POSTHOG_PERSONAL_API_KEY = originalToken;
});

const DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
/** A query's one row: 7 days (Sat … Fri) of new WUU, then the week's total. */
const counts = (days: number[]) => [...days, days.reduce((a, b) => a + b, 0)];
/** This week as of Thursday (13 August 2026), Thursday's row `thursday` so far. */
const thursdayWeek = (thursday: number, days: Record<number, number> = {}) =>
  counts([1000, 1001, 1002, 1003, 1004, thursday, 0].map((n, day) => days[day] ?? n));
const LAST_WEEK = [900, 901, 902, 903, 904, 1000, 1000];
/** The week both queries name in their 9th column: its Central Saturday midnight. */
const WEEK_OF_13_AUGUST = "2026-08-08T00:00:00-05:00";

/** Quiet Hours are local time: 13 August 2026 is a Thursday. */
const thursdayAt = (hour: number) => new Date(2026, 7, 13, hour).getTime();

type Asked = { method?: string; url: URL; authorization?: string; body?: any };

/**
 * A stub PostHog: the two HogQL queries answer from `live` / `lastWeek` (8 counts each),
 * then `week_start`, the week PostHog's now() is in; the tiles from `target` / `activation`. Change a field and the next read sees it.
 * `status` answers every call with that status instead (and `retryAfter` with it).
 */
async function posthog() {
  const state = {
    live: thursdayWeek(900) as unknown[],
    lastWeek: counts(LAST_WEEK),
    week_start: WEEK_OF_13_AUGUST as unknown,
    target: 24400 as unknown,
    activation: "4.5%" as unknown,
    status: 200,
    retryAfter: undefined as string | undefined,
    asked: [] as Asked[],
    refused: 0,
    base: "",
  };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const url = new URL(req.url!, "http://x");
    const asked: Asked = { method: req.method, url, authorization: req.headers.authorization };
    if (text) asked.body = JSON.parse(text);
    state.asked.push(asked);
    if (state.status !== 200) {
      state.refused++;
      if (state.retryAfter) res.setHeader("retry-after", state.retryAfter);
      return void res.writeHead(state.status).end();
    }
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/projects/196853/query/") {
      const row = asked.body.name === "board-wuu-live" ? state.live : state.lastWeek;
      return void res.end(JSON.stringify({ columns: [], results: [[...row, state.week_start]] }));
    }
    const ids = url.searchParams.get("tile_ids")!.split(",").map(Number);
    const value = (id: number) => (id === 7119740 ? state.target : state.activation);
    res.end(JSON.stringify({ results: ids.map((id) => ({ id, insight: { result: [[value(id)]] } })) }));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  upstreams.push(server);
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}
type PostHog = Awaited<ReturnType<typeof posthog>>;
const queries = (ph: PostHog, name: string) =>
  ph.asked.filter((asked) => asked.body?.name === name).length;

/** Boot a board reading `ph` every 10 ms (so a change lands at once) at `now`. */
const boot = async (ph: PostHog, now = () => thursdayAt(10), wauIntervalMs = 10) =>
  (running = await startServer(0, { configPath, posthogApiBase: ph.base, now, wauIntervalMs }));

const wauJson = async () => {
  const response = await fetch(`http://127.0.0.1:${running!.port}/wau.json`);
  return response.ok ? response.json() : response.status;
};

/** Poll until `check` holds: waits for the board to do something, not for a guess at how long. */
async function until(check: () => unknown, what: string) {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Change PostHog, then wait for the display's push of today's row reading `current`. */
async function step(ph: PostHog, messages: any[], live: number[], today = 5) {
  ph.live = live;
  await until(
    () => messages.some((m) => m.type === "wau" && m.wau.daily[today].current === live[today]),
    `a push of ${live[today]}`,
  );
}
const hits = (messages: any[]) => messages.filter((m) => m.type === "wau-target-hit");

test("the WUU route serves the cached reading, from narrow Central-day HogQL", async () => {
  const ph = await posthog();
  await boot(ph, () => thursdayAt(10), 60_000);
  // The boot read: both queries, both tiles from cache, and the hourly recompute.
  await until(() => ph.asked.length === 5, "the boot read");

  const response = await fetch(`http://127.0.0.1:${running!.port}/wau.json`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const live = thursdayWeek(900);
  expect(await response.json()).toEqual({
    fetchedAt: new Date(thursdayAt(10)).toISOString(),
    currentWau: live[7],
    targetWau: 24400,
    // round(5910 * 100 / 24400, 1), as tile 7122309 computes it.
    targetPercent: 24.2,
    activationPercent: 4.5,
    daily: DAYS.map((label, day) => ({
      day: day + 1,
      label,
      current: live[day],
      previous: LAST_WEEK[day],
    })),
    today: 5,
    // Thursday 10:00 is 5 + 10/24 days in: 5910 against 24400 × 5.4167 / 7 ≈ 18881.
    onTarget: "far-behind",
    stale: false,
  });
  // Served from the reading: no request reached PostHog.
  await wauJson();
  expect(ph.asked).toHaveLength(5);

  for (const asked of ph.asked) expect(asked.authorization).toBe("Bearer test-posthog-token");
  const posts = ph.asked.filter((asked) => asked.method === "POST");
  expect(posts.map((asked) => asked.body.name).sort()).toEqual(["board-wuu-last-week", "board-wuu-live"]);
  for (const { url, body } of posts) {
    expect(url.pathname).toBe("/api/projects/196853/query/");
    expect(body).toMatchObject({ query: { kind: "HogQLQuery" }, refresh: "force_blocking" });
    expect(body.query.query).toContain("toStartOfDay(toTimeZone(now(), 'America/Chicago'))");
    expect(body.query.query).toContain("WHERE event = '$pageview'");
  }
  const tiles = ph.asked
    .filter((asked) => asked.method === "GET")
    .map(({ url }) => `${url.searchParams.get("tile_ids")} ${url.searchParams.get("refresh")}`);
  expect(tiles.sort()).toEqual(["10992630 force_cache", "7119740 force_cache", "7119740,10992630 blocking"]);
  for (const asked of ph.asked.filter((asked) => asked.method === "GET")) {
    expect(asked.url.pathname).toBe("/api/projects/196853/dashboards/1468050/run_insights/");
    expect(asked.url.searchParams.get("output_format")).toBe("json");
  }
});

test("Target Hit fires with no display connected", async () => {
  const ph = await posthog();
  await boot(ph);
  ph.live = thursdayWeek(1001);
  await until(async () => (await wauJson()).daily[5].current === 1001, "the crossing read");

  // Nobody watched it happen, yet the board put the Arcade Theme on for the day.
  const { ws, messages } = await connectedDisplay(running!.port);
  await until(() => messages.length, "the snapshot");
  ws.close();
  expect(messages[0]).toMatchObject({ type: "snapshot", theme: "arcade" });
  expect(messages[0].wau.daily[5]).toEqual({ day: 6, label: "Thursday", current: 1001, previous: 1000 });
});

test("today's crossing is broadcast as a Target Hit, once a day", async () => {
  const ph = await posthog();
  await boot(ph);
  const { ws, messages } = await connectedDisplay(running!.port);
  // Drawing level is not beating it; the dip and second crossing celebrate nothing.
  for (const thursday of [1000, 1001, 990, 1010]) await step(ph, messages, thursdayWeek(thursday));
  ws.close();
  expect(hits(messages)).toEqual([
    { type: "wau-target-hit", audible: true, label: "Thursday", current: 1001, previous: 1000 },
  ]);
});

test("picks the Central-day row at 19:30 Central", async () => {
  // 00:30Z Friday by UTC, so a UTC day (the old dashboard's) would be Friday's row.
  const at = Date.parse("2026-08-14T00:30:00Z");
  expect(new Date(at).getHours()).toBe(19);
  const ph = await posthog();
  await boot(ph, () => at);
  const { ws, messages } = await connectedDisplay(running!.port);
  await step(ph, messages, thursdayWeek(1001));
  ws.close();
  expect(messages[0].wau.today).toBe(5);
  expect(hits(messages)).toMatchObject([{ label: "Thursday", current: 1001, previous: 1000 }]);
});

test("a boot already ahead stays quiet", async () => {
  const ph = await posthog();
  ph.live = thursdayWeek(1001);
  await boot(ph);
  const { ws, messages } = await connectedDisplay(running!.port);
  await step(ph, messages, thursdayWeek(1002));
  ws.close();
  expect(hits(messages)).toEqual([]);
  expect(messages[0]).toMatchObject({ type: "snapshot", theme: "kernel" });
});

test("another weekday's row beating last week does not fire", async () => {
  const ph = await posthog();
  await boot(ph);
  const { ws, messages } = await connectedDisplay(running!.port);
  ph.live = thursdayWeek(900, { 4: 1100 });
  await until(() => messages.some((m) => m.type === "wau" && m.wau.daily[4].current === 1100), "a push");
  ws.close();
  expect(hits(messages)).toEqual([]);
});

test("the next day's crossing celebrates again, against that day's last week", async () => {
  let clock = thursdayAt(10);
  const ph = await posthog();
  await boot(ph, () => clock);
  const { ws, messages } = await connectedDisplay(running!.port);
  await step(ph, messages, thursdayWeek(1001));
  // Last week's row is read once a day, however many reads the day has.
  expect(queries(ph, "board-wuu-last-week")).toBe(1);

  ph.live = thursdayWeek(1001, { 6: 0 });
  clock = new Date(2026, 7, 14, 10).getTime(); // Friday
  await step(ph, messages, thursdayWeek(1001, { 6: 1001 }), 6);
  ws.close();
  expect(queries(ph, "board-wuu-last-week")).toBe(2);
  expect(hits(messages)).toMatchObject([{ label: "Thursday" }, { label: "Friday" }]);
});

test("Saturday's first reading already ahead celebrates: the last reading was last week's", async () => {
  let clock = new Date(2026, 7, 14, 23).getTime(); // Friday night, Saturday's row last week's
  const ph = await posthog();
  ph.live = counts([1100, 1001, 1002, 1003, 1004, 1005, 1006]);
  await boot(ph, () => clock);
  const { ws, messages } = await connectedDisplay(running!.port);
  clock = new Date(2026, 7, 15, 10).getTime(); // Saturday: a new week
  ph.week_start = "2026-08-15T00:00:00-05:00";
  ph.lastWeek = counts([1000, 1001, 1002, 1003, 1004, 1005, 1006]);
  await step(ph, messages, counts([1001, 0, 0, 0, 0, 0, 0]), 0);
  ws.close();
  expect(hits(messages)).toMatchObject([{ label: "Saturday", current: 1001, previous: 1000 }]);
});

test("a Target Hit in Quiet Hours is flagged silent", async () => {
  const ph = await posthog();
  await boot(ph, () => thursdayAt(22));
  const { ws, messages } = await connectedDisplay(running!.port);
  await step(ph, messages, thursdayWeek(1001));
  ws.close();
  expect(hits(messages)).toMatchObject([{ type: "wau-target-hit", audible: false }]);
});

test("a 429 keeps the last good reading", async () => {
  const ph = await posthog();
  await boot(ph);
  const good = await wauJson();
  ph.status = 429;
  ph.retryAfter = "60";
  // With the clock frozen, each read after boot is the live query alone.
  await until(() => ph.refused, "a 429");
  const limitedAt = queries(ph, "board-wuu-live");
  // Ten reads' worth of ticks: none asks PostHog again inside the Retry-After.
  await sleep(100);
  expect(queries(ph, "board-wuu-live")).toBe(limitedAt);
  expect(await wauJson()).toEqual(good);
});

test("wau is pushed over the websocket", async () => {
  const ph = await posthog();
  await boot(ph);
  const { ws, messages } = await connectedDisplay(running!.port);
  await until(() => messages.length, "the snapshot");
  expect(messages[0].wau).toEqual(await wauJson());

  await step(ph, messages, thursdayWeek(950));
  const pushes = () => messages.filter((m) => m.type === "wau");
  expect(pushes()).toEqual([{ type: "wau", wau: await wauJson() }]);
  // Reads of the same numbers are no news.
  const read = queries(ph, "board-wuu-live");
  await until(() => queries(ph, "board-wuu-live") >= read + 3, "three more reads");
  ws.close();
  expect(pushes()).toHaveLength(1);
});

test("a failed target or activation read keeps the last good value", async () => {
  let clock = thursdayAt(10);
  const ph = await posthog();
  await boot(ph, () => clock);
  const { ws, messages } = await connectedDisplay(running!.port);
  ph.target = "n/a";
  ph.activation = null;
  clock += 60 * 60 * 1000; // both tiles due again
  await step(ph, messages, thursdayWeek(950));
  ws.close();
  expect(messages.at(-1).wau).toMatchObject({ targetWau: 24400, activationPercent: 4.5 });
});

test("the WUU route is unavailable without a PostHog credential", async () => {
  delete process.env.POSTHOG_PERSONAL_API_KEY;
  running = await startServer(0, { configPath });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(503);
  const { ws, messages } = await connectedDisplay(running.port);
  await until(() => messages.length, "the snapshot");
  ws.close();
  expect(messages[0].wau).toBeNull();
});

test.each([
  ["an upstream error", (ph: PostHog) => (ph.status = 503)],
  ["a query row that is not 8 counts", (ph: PostHog) => (ph.live = [1, 2, 3])],
  ["a non-numeric count", (ph: PostHog) => (ph.live = [...thursdayWeek(900).slice(0, 7), "n/a"])],
  ["a query row with no week", (ph: PostHog) => (ph.week_start = null)],
  ["no target yet", (ph: PostHog) => (ph.target = null)],
  ["no activation rate yet", (ph: PostHog) => (ph.activation = "n/a")],
  // PostHog's Friday already counting: its week or day is not the board's.
  ["new WUU on a day after today", (ph: PostHog) => (ph.live = thursdayWeek(900, { 6: 5 }))],
])("the WUU route is 502 until a reading lands: %s", async (_name, breakIt) => {
  const ph = await posthog();
  breakIt(ph);
  await boot(ph, undefined, 60_000);

  expect(await wauJson()).toBe(502);
  const { ws, messages } = await connectedDisplay(running!.port);
  await until(() => messages.length, "the snapshot");
  ws.close();
  expect(messages[0].wau).toBeNull();
});

test("a stalled or oversized PostHog answer is no reading", async () => {
  const stalled = createServer(() => {});
  const oversized = createServer((_req, res) => res.end("x".repeat(1024 * 1024 + 1)));
  for (const server of [stalled, oversized]) {
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    upstreams.push(server);
    const posthogApiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    running = await startServer(0, { configPath, posthogApiBase, posthogTimeoutMs: 50 });
    expect(await wauJson()).toBe(502);
    await running.close();
    running = undefined;
  }
});

test("a loopback POST replays the Target Hit", async () => {
  running = await startServer(0, { configPath, now: () => thursdayAt(10) });
  const { ws, messages } = await connectedDisplay(running.port);
  const response = await fetch(`http://127.0.0.1:${running.port}/wau-target-hit`, {
    method: "POST",
  });
  await sleep(50);
  ws.close();
  expect(response.status).toBe(204);
  expect(messages.filter((message) => message.type === "wau-target-hit")).toEqual([
    { type: "wau-target-hit", audible: true },
  ]);
});

test("a replay after a read carries today's row", async () => {
  const ph = await posthog();
  await boot(ph);
  const { ws, messages } = await connectedDisplay(running!.port);
  await fetch(`http://127.0.0.1:${running!.port}/wau-target-hit`, { method: "POST" });
  await until(() => hits(messages).length, "the replay");
  ws.close();
  expect(hits(messages)).toEqual([
    { type: "wau-target-hit", audible: true, label: "Thursday", current: 900, previous: 1000 },
  ]);
});

test("a proxied POST (Funnel adds X-Forwarded-For) cannot replay the Target Hit", async () => {
  running = await startServer(0, { configPath, now: () => thursdayAt(10) });
  const { ws, messages } = await connectedDisplay(running.port);
  const response = await fetch(`http://127.0.0.1:${running.port}/wau-target-hit`, {
    method: "POST",
    headers: { "x-forwarded-for": "1.2.3.4" },
  });
  await sleep(50);
  ws.close();
  expect(response.status).toBe(403);
  expect(messages.filter((message) => message.type === "wau-target-hit")).toEqual([]);
});

test("a display connecting after a Target Hit is told the board wears the Arcade Theme", async () => {
  running = await startServer(0, { configPath, now: () => thursdayAt(10) });
  const before = await connectedDisplay(running.port);
  await fetch(`http://127.0.0.1:${running.port}/wau-target-hit`, { method: "POST" });
  const after = await connectedDisplay(running.port);
  await sleep(50);
  before.ws.close();
  after.ws.close();
  expect(before.messages[0]).toMatchObject({ type: "snapshot", theme: "kernel" });
  expect(after.messages[0]).toMatchObject({ type: "snapshot", theme: "arcade" });
});

test("the Arcade Theme ends at local midnight with one fresh snapshot", async () => {
  // Thursday, 10 ms short of midnight: the scheduler re-arms for what is left until the clock moves.
  let clock = new Date(2026, 7, 14).getTime() - 10;
  running = await startServer(0, { configPath, now: () => clock });
  await fetch(`http://127.0.0.1:${running.port}/wau-target-hit`, { method: "POST" });
  const { ws, messages } = await connectedDisplay(running.port);
  await sleep(50);
  clock = new Date(2026, 7, 14, 0, 0, 30).getTime(); // just past midnight
  await sleep(100);
  ws.close();
  const snapshots = messages.filter((message) => message.type === "snapshot");
  expect(snapshots.map((snapshot) => snapshot.theme)).toEqual(["arcade", "kernel"]);
});
