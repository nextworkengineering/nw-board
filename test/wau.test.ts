import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import { configPath, connectedDisplay } from "./helpers.ts";

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

async function upstream(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  upstreams.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const tile = (id: number, result: unknown[]) => ({ id, insight: { result } });
// The saved insight labels rows by weekday of the Sat–Fri cycle and carries a
// daily-target column the board does not use.
const DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
/** `rows` overrides a day's [current, previous] by index (Sat=0 … Fri=6). */
const dashboard = (
  targetPercent = "33.7%",
  rows: Record<number, number[]> = {},
  currentWau = 5906,
  targetWau = 17518,
) => ({
  results: [
    tile(7119738, [[currentWau]]),
    tile(7119740, [[targetWau]]),
    tile(7122309, [[targetPercent]]),
    tile(10992630, [["4.5%"]]),
    tile(
      7119735,
      DAYS.map((label, day) => [label, ...(rows[day] ?? [1000 + day, 900 + day]), 2503]),
    ),
  ],
});

test("the WUU route answers from PostHog's cache and refreshes it in the background", async () => {
  const requests: { url?: string; authorization?: string; accept?: string }[] = [];
  const base = await upstream((req, res) => {
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(dashboard()));
  });
  running = await startServer(0, { configPath, posthogApiBase: base, now: () => thursdayAt(10) });

  const response = await fetch(`http://127.0.0.1:${running.port}/wau.json`);
  const body = await response.json();
  while (requests.length < 2) await sleep(5);

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const urls = requests.map((request) => new URL(request.url!, base));
  expect(urls.map((url) => url.searchParams.get("refresh")).sort()).toEqual([
    "blocking",
    "force_cache",
  ]);
  for (const [index, url] of urls.entries()) {
    expect(requests[index].authorization).toBe("Bearer test-posthog-token");
    expect(requests[index].accept).toBe("application/json");
    expect(url.pathname).toBe("/api/projects/196853/dashboards/1468050/run_insights/");
    expect(url.searchParams.get("tile_ids")).toBe(
      "7119738,7119740,7122309,10992630,7119735",
    );
    expect(url.searchParams.get("output_format")).toBe("json");
  }
  expect(body).toEqual({
    fetchedAt: expect.any(String),
    currentWau: 5906,
    targetWau: 17518,
    targetPercent: 33.7,
    activationPercent: 4.5,
    daily: DAYS.map((label, day) => ({
      day: day + 1,
      label,
      current: 1000 + day,
      previous: 900 + day,
    })),
    today: 5,
    // Thursday 10:00 is 5 + 10/24 days in: 5906 WUU against 17518 × 5.4167 / 7 ≈ 13556.
    onTarget: "far-behind",
  });
  expect(JSON.stringify(body)).not.toContain("test-posthog-token");
});

/** The On Target light for a read served at `at` (Thursday noon by default). */
async function onTargetAt(read: ReturnType<typeof dashboard>, at = thursdayAt(12)) {
  const base = await upstream((req, res) => {
    if (new URL(req.url!, "http://x").searchParams.get("refresh") === "blocking") return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(read));
  });
  running = await startServer(0, { configPath, posthogApiBase: base, now: () => at });
  return (await (await fetch(`http://127.0.0.1:${running.port}/wau.json`)).json()).onTarget;
}

// Thursday noon is 5.5 days into the Sat–Fri cycle: a 7000 target expects 5500 by now.
test.each([
  [5500, 7000, "on"],
  [4950, 7000, "on"],
  [4949, 7000, "behind"],
  [3850, 7000, "behind"],
  [3849, 7000, "far-behind"],
  [0, 0, "on"],
])("%i WUU against a %i target at Thursday noon is %s", async (current, target, expected) => {
  expect(await onTargetAt(dashboard(undefined, {}, current, target))).toBe(expected);
});

// Monday noon is 60 of the week's 168 hours: a 10000 target expects ≈ 3571 by now.
test.each([
  [2000, "far-behind"],
  [3300, "on"],
])("%i WUU against a 10000 target at Monday noon is %s", async (current, expected) => {
  expect(await onTargetAt(dashboard(undefined, {}, current, 10000), new Date(2026, 7, 10, 12).getTime())).toBe(expected);
});

test("a slow PostHog recompute does not hold up the WUU route", async () => {
  const base = await upstream((req, res) => {
    // The background refresh never answers; the cached read does.
    if (new URL(req.url!, "http://x").searchParams.get("refresh") === "blocking") return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(dashboard()));
  });
  running = await startServer(0, { configPath, posthogApiBase: base, posthogTimeoutMs: 1000 });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(200);
});

test("only one PostHog recompute runs at a time", async () => {
  let warms = 0;
  const base = await upstream((req, res) => {
    if (new URL(req.url!, "http://x").searchParams.get("refresh") === "blocking") {
      warms += 1;
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(dashboard()));
  });
  running = await startServer(0, { configPath, posthogApiBase: base });

  await fetch(`http://127.0.0.1:${running.port}/wau.json`);
  await fetch(`http://127.0.0.1:${running.port}/wau.json`);
  await sleep(50);

  expect(warms).toBe(1);
});

test.each([
  ["an upstream error", (res: import("node:http").ServerResponse) => res.writeHead(500).end()],
  [
    "a missing tile",
    (res: import("node:http").ServerResponse) =>
      res.end(JSON.stringify({ results: dashboard().results.slice(0, 1) })),
  ],
])("the WUU route keeps the last good numbers through %s", async (_name, fail) => {
  let broken = false;
  const base = await upstream((req, res) => {
    if (new URL(req.url!, "http://x").searchParams.get("refresh") === "blocking") return;
    res.setHeader("content-type", "application/json");
    if (broken) fail(res);
    else res.end(JSON.stringify(dashboard()));
  });
  running = await startServer(0, { configPath, posthogApiBase: base });

  const good = await (await fetch(`http://127.0.0.1:${running.port}/wau.json`)).json();
  broken = true;
  const after = await fetch(`http://127.0.0.1:${running.port}/wau.json`);

  expect(after.status).toBe(200);
  expect(await after.json()).toEqual(good);
});

test("the WUU route is unavailable without a PostHog credential", async () => {
  delete process.env.POSTHOG_PERSONAL_API_KEY;
  running = await startServer(0, { configPath });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(503);
});

test("the WUU route maps an upstream error to 502", async () => {
  const base = await upstream((_req, res) => {
    res.writeHead(503);
    res.end("no");
  });
  running = await startServer(0, { configPath, posthogApiBase: base });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(502);
});

test("the WUU route times out a stalled upstream", async () => {
  const base = await upstream(async (_req, res) => {
    await sleep(100);
    res.end(JSON.stringify(dashboard()));
  });
  running = await startServer(0, {
    configPath,
    posthogApiBase: base,
    posthogTimeoutMs: 10,
  });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(502);
});

test("the WUU route rejects an oversized upstream response", async () => {
  const base = await upstream((_req, res) => res.end("x".repeat(1024 * 1024 + 1)));
  running = await startServer(0, { configPath, posthogApiBase: base });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(502);
});

test.each([
  ["malformed", { results: "nope" }],
  [
    "non-numeric daily",
    {
      results: dashboard().results.map((item) =>
        item.id === 7119735 ? tile(7119735, [["Saturday", "n/a", 1, 2503]]) : item,
      ),
    },
  ],
  ["missing a required tile", { results: dashboard().results.slice(1) }],
  [
    "missing a daily result",
    {
      results: dashboard().results.map((item) =>
        item.id === 7119735 ? tile(7119735, item.insight.result.slice(0, 6)) : item,
      ),
    },
  ],
])("the WUU route rejects %s PostHog data", async (_name, body) => {
  const base = await upstream((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  running = await startServer(0, { configPath, posthogApiBase: base });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(502);
});

/** Quiet Hours are local time: 13 August 2026 is a Thursday. */
const thursdayAt = (hour: number) => new Date(2026, 7, 13, hour).getTime();

/** A read whose Thursday row (today on `thursdayAt`) is `current` against `previous`. */
const thursday = (current: number, previous: number, percent?: string) =>
  dashboard(percent, { 5: [current, previous] });

/** Serve each PostHog read the next dashboard, and collect what the board hears. */
async function targetHits(reads: ReturnType<typeof dashboard>[], now = () => thursdayAt(10)) {
  const base = await upstream((req, res) => {
    if (new URL(req.url!, "http://x").searchParams.get("refresh") === "blocking") return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(reads.shift()));
  });
  running = await startServer(0, { configPath, posthogApiBase: base, now });
  const { ws, messages } = await connectedDisplay(running.port);
  while (reads.length) await fetch(`http://127.0.0.1:${running.port}/wau.json`);
  await sleep(50);
  ws.close();
  return messages.filter((message) => message.type === "wau-target-hit");
}

test("today's new WUU beating the same weekday last week is broadcast as a Target Hit", async () => {
  expect(await targetHits([thursday(900, 1000), thursday(1001, 1000)])).toEqual([
    { type: "wau-target-hit", audible: true, label: "Thursday", current: 1001, previous: 1000 },
  ]);
});

test("a first read already beating last week is no crossing", async () => {
  expect(await targetHits([thursday(1001, 1000), thursday(1002, 1000)])).toEqual([]);
});

test("staying ahead of last week celebrates only the one crossing", async () => {
  expect(
    await targetHits([thursday(900, 1000), thursday(1001, 1000), thursday(1050, 1000)]),
  ).toHaveLength(1);
});

test("drawing level with last week is not beating it", async () => {
  expect(await targetHits([thursday(900, 1000), thursday(1000, 1000)])).toEqual([]);
});

test("another weekday's row beating last week does not fire", async () => {
  const behind = { 5: [900, 1000] };
  expect(
    await targetHits([
      dashboard(undefined, { ...behind, 4: [900, 1000] }),
      dashboard(undefined, { ...behind, 4: [1100, 1000] }),
    ]),
  ).toEqual([]);
});

test("dipping back and crossing again the same day celebrates once", async () => {
  expect(
    await targetHits([
      thursday(900, 1000),
      thursday(1001, 1000),
      thursday(990, 1000),
      thursday(1010, 1000),
    ]),
  ).toHaveLength(1);
});

test("the next day's crossing celebrates again", async () => {
  const reads = [
    dashboard(undefined, { 5: [900, 1000], 6: [0, 1000] }),
    dashboard(undefined, { 5: [1001, 1000], 6: [0, 1000] }),
    dashboard(undefined, { 5: [1001, 1000], 6: [0, 1000] }),
    dashboard(undefined, { 5: [1001, 1000], 6: [1001, 1000] }),
  ];
  // The clock is read once a read is served: the first two land on Thursday, the last two on Friday.
  const now = () => (reads.length >= 2 ? thursdayAt(10) : new Date(2026, 7, 14, 10).getTime());
  expect(await targetHits(reads, now)).toMatchObject([{ label: "Thursday" }, { label: "Friday" }]);
});

test("Saturday's crossing fires even though last cycle's Saturday was ahead", async () => {
  // Friday's read still holds last cycle, whose Saturday beat the one before; the
  // first Saturday read is already ahead (PostHog's cache lags) and should celebrate.
  const reads = [dashboard(undefined, { 0: [1100, 1000] }), dashboard(undefined, { 0: [1001, 1000] })];
  const now = () =>
    reads.length >= 1 ? new Date(2026, 7, 14, 23).getTime() : new Date(2026, 7, 15, 10).getTime();
  expect(await targetHits(reads, now)).toMatchObject([{ label: "Saturday", current: 1001 }]);
});

test("the weekly target reaching 100% is no longer a Target Hit", async () => {
  expect(
    await targetHits([thursday(900, 1000, "95%"), thursday(900, 1000, "100%")]),
  ).toEqual([]);
});

test("a Target Hit in Quiet Hours is flagged silent", async () => {
  expect(
    await targetHits([thursday(900, 1000), thursday(1001, 1000)], () => thursdayAt(22)),
  ).toMatchObject([{ type: "wau-target-hit", audible: false }]);
});

test("a slow read of older cache landing after the crossing does not replace it", async () => {
  // Read 2 asks first but answers last, with the cache from before the crossing; read 4
  // fails, so it serves whatever the route kept.
  const reads: [ReturnType<typeof dashboard> | undefined, number][] = [
    [thursday(900, 1000), 0],
    [thursday(950, 1000), 200],
    [thursday(1001, 1000), 0],
    [undefined, 0],
  ];
  const base = await upstream((req, res) => {
    if (new URL(req.url!, "http://x").searchParams.get("refresh") === "blocking") return;
    const [read, delay] = reads.shift()!;
    setTimeout(() => {
      if (!read) return res.writeHead(500).end();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(read));
    }, delay);
  });
  running = await startServer(0, { configPath, posthogApiBase: base, now: () => thursdayAt(10) });
  const { ws, messages } = await connectedDisplay(running.port);
  const wau = () => fetch(`http://127.0.0.1:${running!.port}/wau.json`);
  await wau();
  const slow = wau();
  await sleep(50);
  await wau();
  await slow;
  const kept = await (await wau()).json();
  await sleep(50);
  ws.close();
  expect(messages.filter((message) => message.type === "wau-target-hit")).toHaveLength(1);
  expect(kept.daily[5].current).toBe(1001);
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
  await targetHits([thursday(900, 1000)]);
  const { ws, messages } = await connectedDisplay(running!.port);
  await fetch(`http://127.0.0.1:${running!.port}/wau-target-hit`, { method: "POST" });
  await sleep(50);
  ws.close();
  expect(messages.filter((message) => message.type === "wau-target-hit")).toEqual([
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

test("a PostHog crossing also puts the board in the Arcade Theme", async () => {
  await targetHits([thursday(900, 1000), thursday(1001, 1000)]);
  const { ws, messages } = await connectedDisplay(running!.port);
  await sleep(50);
  ws.close();
  expect(messages[0]).toMatchObject({ type: "snapshot", theme: "arcade" });
});

test("the Arcade Theme ends at local midnight with one fresh snapshot", async () => {
  let clock = new Date(2026, 7, 13, 23, 30).getTime(); // Thursday, late
  running = await startServer(0, { configPath, now: () => clock, tickMs: 10 });
  await fetch(`http://127.0.0.1:${running.port}/wau-target-hit`, { method: "POST" });
  const { ws, messages } = await connectedDisplay(running.port);
  await sleep(50);
  clock = new Date(2026, 7, 14, 0, 0, 30).getTime(); // just past midnight
  await sleep(100);
  ws.close();
  const snapshots = messages.filter((message) => message.type === "snapshot");
  expect(snapshots.map((snapshot) => snapshot.theme)).toEqual(["arcade", "kernel"]);
});
