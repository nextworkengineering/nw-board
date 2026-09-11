import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import { SECRET } from "./helpers.ts";

process.env.GITHUB_WEBHOOK_SECRET = SECRET;

let running: { port: number; close: () => Promise<void> } | undefined;
const upstreams: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(
    upstreams.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function upstream(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  upstreams.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed.xml`;
}

function config(newsFeedUrl?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pr-arcade-news-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      trackedRepos: [],
      quietHours: { soundStart: "09:00", soundEnd: "18:00" },
      chimes: [],
      ...(newsFeedUrl === undefined ? {} : { newsFeedUrl }),
    }),
  );
  return path;
}

test("the news route proxies the configured XML feed unchanged", async () => {
  const xml = `<?xml version="1.0"?><rss><channel><item><title>AI ships</title></item></channel></rss>`;
  const url = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(xml);
  });
  running = await startServer(0, { configPath: config(url) });

  const response = await fetch(`http://127.0.0.1:${running.port}/news.xml`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/xml/);
  expect(await response.text()).toBe(xml);
});

test("the news route cannot be pointed at a URL from the request", async () => {
  let unconfiguredFeedCalled = false;
  const configuredUrl = await upstream((_req, res) => res.end("<rss>configured</rss>"));
  const unconfiguredUrl = await upstream((_req, res) => {
    unconfiguredFeedCalled = true;
    res.end("<rss>unconfigured</rss>");
  });
  running = await startServer(0, { configPath: config(configuredUrl) });

  const response = await fetch(
    `http://127.0.0.1:${running.port}/news.xml?url=${encodeURIComponent(unconfiguredUrl)}`,
  );

  expect(await response.text()).toBe("<rss>configured</rss>");
  expect(unconfiguredFeedCalled).toBe(false);
});

test("the news route is disabled when no feed is configured", async () => {
  running = await startServer(0, { configPath: config() });

  expect((await fetch(`http://127.0.0.1:${running.port}/news.xml`)).status).toBe(404);
});

test.for(["not a URL", "file:///tmp/feed.xml"])(
  "the server rejects invalid news feed URL %s",
  async (url) => {
    await expect(startServer(0, { configPath: config(url) })).rejects.toThrow(
      /newsFeedUrl must be an http\(s\) URL/,
    );
  },
);

test("the news route maps an upstream error to 502", async () => {
  const url = await upstream((_req, res) => {
    res.writeHead(503);
    res.end("no");
  });
  running = await startServer(0, { configPath: config(url) });

  expect((await fetch(`http://127.0.0.1:${running.port}/news.xml`)).status).toBe(502);
});

test("the news route rejects an oversized upstream response", async () => {
  const url = await upstream((_req, res) => res.end("x".repeat(1024 * 1024 + 1)));
  running = await startServer(0, { configPath: config(url) });

  expect((await fetch(`http://127.0.0.1:${running.port}/news.xml`)).status).toBe(502);
});

test("the news route times out a stalled upstream", async () => {
  const url = await upstream(async (_req, res) => {
    await sleep(100);
    res.end("late");
  });
  running = await startServer(0, {
    configPath: config(url),
    newsTimeoutMs: 10,
  });

  expect((await fetch(`http://127.0.0.1:${running.port}/news.xml`)).status).toBe(502);
});
