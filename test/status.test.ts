import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import { configPath } from "./helpers.ts";

let running: { port: number; close: () => Promise<void> } | undefined;
const upstreams: Server[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(
    upstreams.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

async function upstream(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  upstreams.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/status.json`;
}

const json = (body: unknown) => upstream((_req, res) => res.end(JSON.stringify(body)));
const statuspage = (indicator: string, description: string) =>
  json({ status: { indicator, description } });

const CLOUD_RUN = "9D7d2iNBQWN24zc1VamE";

async function readStatus(statusUrls: object, statusTimeoutMs?: number) {
  running = await startServer(0, { configPath, statusUrls, statusTimeoutMs });
  const response = await fetch(`http://127.0.0.1:${running.port}/status.json`);
  return { response, body: await response.json() };
}

test("the status route reports every service operational", async () => {
  const { response, body } = await readStatus({
    github: await statuspage("none", "All Systems Operational"),
    sentry: await statuspage("none", "All Systems Operational"),
    gcp: await json([]),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(Number.isNaN(Date.parse(body.fetchedAt))).toBe(false);
  expect(body.services).toEqual([
    { name: "GITHUB", level: "ok", text: "OPERATIONAL" },
    { name: "SENTRY", level: "ok", text: "OPERATIONAL" },
    { name: "GCP", level: "ok", text: "OPERATIONAL" },
  ]);
});

test.for([
  ["minor", "minor"],
  ["critical", "major"],
  ["maintenance", "minor"],
])("a Statuspage indicator %s shows as %s", async ([indicator, level]) => {
  const { body } = await readStatus({
    github: await statuspage(indicator, "Partial System Outage"),
    sentry: await statuspage("none", "All Systems Operational"),
    gcp: await json([]),
  });

  expect(body.services[0]).toEqual({ name: "GITHUB", level, text: "PARTIAL SYSTEM OUTAGE" });
});

test("GCP counts only open incidents on our products that reach our regions", async () => {
  const product = (id: string) => ({ affected_products: [{ title: "x", id }] });
  const regions = (...ids: string[]) => ({
    currently_affected_locations: ids.map((id) => ({ title: id, id })),
  });
  const ignored = [
    { ...product(CLOUD_RUN), ...regions(), severity: "high", end: "2026-10-01T00:00:00Z" },
    { ...product("someOtherProductId"), ...regions(), severity: "high" },
    { ...product(CLOUD_RUN), ...regions("europe-west2"), severity: "high" },
    // Recovered but not yet ended: GCP empties the current locations first.
    { ...product(CLOUD_RUN), ...regions(), severity: "high" },
  ];
  const global = {
    ...product(CLOUD_RUN),
    ...regions("asia-south2", "global"),
    severity: "high",
    status_impact: "SERVICE_OUTAGE",
  };
  // Two boards over the same Statuspage stubs; only the second GCP feed adds the global one.
  const urls = {
    github: await statuspage("none", "All Systems Operational"),
    sentry: await statuspage("none", "All Systems Operational"),
  };
  const quiet = await readStatus({ ...urls, gcp: await json(ignored) });
  expect(quiet.body.services[2]).toEqual({
    name: "GCP",
    level: "ok",
    text: "OPERATIONAL",
  });
  await running?.close();

  const loud = await readStatus({ ...urls, gcp: await json([...ignored, global]) });
  expect(loud.body.services[2]).toEqual({ name: "GCP", level: "major", text: "SERVICE OUTAGE" });
  await running?.close();

  // One of our regions counts, and the worst severity names the row, not the newest.
  const regional = [
    { ...product(CLOUD_RUN), ...regions("us-central1"), severity: "low", status_impact: "SERVICE_INFORMATION" },
    { ...product(CLOUD_RUN), ...regions("us-east1"), severity: "medium", status_impact: "SERVICE_DISRUPTION" },
  ];
  const minor = await readStatus({ ...urls, gcp: await json(regional) });
  expect(minor.body.services[2]).toEqual({ name: "GCP", level: "minor", text: "SERVICE DISRUPTION" });
});

test("one failing status page shows only its row unavailable", async () => {
  const { response, body } = await readStatus({
    github: await statuspage("none", "All Systems Operational"),
    sentry: await upstream((_req, res) => {
      res.writeHead(500);
      // A parseable body, so only the status code can make this row unavailable.
      res.end(JSON.stringify({ status: { indicator: "none", description: "fine" } }));
    }),
    gcp: await json([]),
  });

  expect(response.status).toBe(200);
  expect(body.services.map((service: any) => service.level)).toEqual(["ok", "unknown", "ok"]);
  expect(body.services[1]).toEqual({ name: "SENTRY", level: "unknown", text: "UNAVAILABLE" });
});

test("a stalled status page times out to unavailable", async () => {
  const { body } = await readStatus(
    {
      github: await statuspage("none", "All Systems Operational"),
      sentry: await statuspage("none", "All Systems Operational"),
      gcp: await upstream(async (_req, res) => {
        await sleep(100);
        res.end("[]");
      }),
    },
    10,
  );

  expect(body.services[2]).toEqual({ name: "GCP", level: "unknown", text: "UNAVAILABLE" });
});
