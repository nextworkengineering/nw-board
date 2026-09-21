import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import { configPath } from "./helpers.ts";

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
    upstreams.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
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
const dashboard = () => ({
  results: [
    tile(7119738, [[5906]]),
    tile(7119740, [[17518]]),
    tile(7122309, [["33.7%"]]),
    tile(10992630, [["4.5%"]]),
    tile(
      7119735,
      Array.from({ length: 7 }, (_, day) => [`Day ${day + 1}`, 1000 + day, 900 + day]),
    ),
  ],
});

test("the WAU route requests and normalizes the five saved dashboard tiles", async () => {
  let request: { url?: string; authorization?: string; accept?: string } = {};
  const base = await upstream((req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(dashboard()));
  });
  running = await startServer(0, { configPath, posthogApiBase: base });

  const response = await fetch(`http://127.0.0.1:${running.port}/wau.json`);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(request.authorization).toBe("Bearer test-posthog-token");
  expect(request.accept).toBe("application/json");
  const url = new URL(request.url!, base);
  expect(url.pathname).toBe("/api/projects/196853/dashboards/1468050/run_insights/");
  expect(url.searchParams.get("tile_ids")).toBe(
    "7119738,7119740,7122309,10992630,7119735",
  );
  expect(url.searchParams.get("refresh")).toBe("blocking");
  expect(url.searchParams.get("output_format")).toBe("json");
  expect(body).toEqual({
    fetchedAt: expect.any(String),
    currentWau: 5906,
    targetWau: 17518,
    targetPercent: 33.7,
    activationPercent: 4.5,
    daily: Array.from({ length: 7 }, (_, day) => ({
      day: day + 1,
      current: 1000 + day,
      previous: 900 + day,
    })),
  });
  expect(JSON.stringify(body)).not.toContain("test-posthog-token");
});

test("the WAU route is unavailable without a PostHog credential", async () => {
  delete process.env.POSTHOG_PERSONAL_API_KEY;
  running = await startServer(0, { configPath });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(503);
});

test("the WAU route maps an upstream error to 502", async () => {
  const base = await upstream((_req, res) => {
    res.writeHead(503);
    res.end("no");
  });
  running = await startServer(0, { configPath, posthogApiBase: base });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(502);
});

test("the WAU route times out a stalled upstream", async () => {
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

test("the WAU route rejects an oversized upstream response", async () => {
  const base = await upstream((_req, res) => res.end("x".repeat(1024 * 1024 + 1)));
  running = await startServer(0, { configPath, posthogApiBase: base });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(502);
});

test.each([
  ["malformed", { results: "nope" }],
  ["missing a required tile", { results: dashboard().results.slice(1) }],
  [
    "missing a daily result",
    {
      results: dashboard().results.map((item) =>
        item.id === 7119735 ? tile(7119735, item.insight.result.slice(0, 6)) : item,
      ),
    },
  ],
])("the WAU route rejects %s PostHog data", async (_name, body) => {
  const base = await upstream((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  running = await startServer(0, { configPath, posthogApiBase: base });

  expect((await fetch(`http://127.0.0.1:${running.port}/wau.json`)).status).toBe(502);
});
