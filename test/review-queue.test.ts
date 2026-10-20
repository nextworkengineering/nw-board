import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import { connectedDisplay, readSnapshot } from "./helpers.ts";

// The Review Queue is read off the GitHub API, so like backfill.test.ts this file sets
// a token — always pointed at the stub base below, never api.github.com.
process.env.GITHUB_TOKEN = "test-pat";

let running: { port: number; close: () => Promise<void> } | undefined;
const stubs: Server[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(stubs.splice(0).map((s) => new Promise((done) => s.close(done))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in GitHub API: `handler` answers each request (copied from backfill.test.ts). */
async function stubGitHubApi(handler: (url: string) => unknown) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(handler(req.url!) ?? []));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  stubs.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function config(reviewers: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pr-arcade-review-queue-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      trackedRepos: ["example-org/projects-app", "example-org/features"],
      quietHours: { soundStart: "09:00", soundEnd: "18:00" },
      chimes: ["09:00", "17:00"],
      names: { "brandon-nextwork": "Brandon" },
      reviewers,
    }),
  );
  return path;
}

const openPr = (number: number, ...requested: string[]) => ({
  number,
  title: `PR ${number}`,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  user: { login: "author-alice" },
  requested_reviewers: requested.map((login) => ({ login })),
});

/** Open PRs per Tracked Repo; closed lists and reviews are empty. */
const openPrsApi = (open: Record<string, unknown[]>) =>
  stubGitHubApi((url) => {
    if (!url.includes("state=open")) return [];
    return Object.entries(open).find(([repo]) => url.includes(`/${repo}/`))?.[1] ?? [];
  });

test("a requested review lists the PR under the reviewer's display name, and an idle reviewer is listed empty", async () => {
  const base = await openPrsApi({
    "example-org/projects-app": [openPr(12, "brandon-nextwork"), openPr(3, "brandon-nextwork")],
    "example-org/features": [openPr(7, "brandon-nextwork")],
  });
  running = await startServer(0, {
    configPath: config(["brandon-nextwork", "loheth-nextwork"]),
    githubApiBase: base,
  });

  expect((await readSnapshot(running.port)).reviewQueue).toEqual([
    { reviewer: "Brandon", prs: [3, 7, 12] },
    { reviewer: "loheth-nextwork", prs: [] },
  ]);
});

test("a review requested of an unconfigured login is ignored", async () => {
  const base = await openPrsApi({
    "example-org/projects-app": [openPr(5, "someone-else"), openPr(6, "loheth-nextwork")],
  });
  running = await startServer(0, { configPath: config(["loheth-nextwork"]), githubApiBase: base });

  expect((await readSnapshot(running.port)).reviewQueue).toEqual([
    { reviewer: "loheth-nextwork", prs: [6] },
  ]);
});

test("a reviewer dropping off a PR is broadcast on the next reconcile", async () => {
  const open = [openPr(9, "brandon-nextwork")];
  const base = await openPrsApi({ "example-org/projects-app": open });
  running = await startServer(0, {
    configPath: config(["brandon-nextwork"]),
    githubApiBase: base,
    reconcileMs: 10,
  });
  const { ws, messages } = await connectedDisplay(running.port);
  await sleep(50);
  expect(messages[0].reviewQueue).toEqual([
    { reviewer: "Brandon", prs: [9] },
  ]);

  // The request was withdrawn (or the review submitted); no webhook tells the board.
  open[0] = openPr(9);
  await sleep(100);
  ws.close();

  const snapshots = messages.filter((message) => message.type === "snapshot");
  expect(snapshots.length).toBeGreaterThan(1);
  expect(snapshots.at(-1).reviewQueue).toEqual([{ reviewer: "Brandon", prs: [] }]);
});

test("a reviewers config that is not a list of logins stops the server from starting", async () => {
  await expect(startServer(0, { configPath: config("brandon-nextwork") })).rejects.toThrow(
    /reviewers must be a list of GitHub logins/,
  );
});

test("renaming a reviewer in the Admin Console reaches the board at once", async () => {
  const base = await openPrsApi({ "example-org/projects-app": [openPr(4, "loheth-nextwork")] });
  running = await startServer(0, { configPath: config(["loheth-nextwork"]), githubApiBase: base });
  const { ws, messages } = await connectedDisplay(running.port);
  await sleep(50);

  const response = await fetch(`http://127.0.0.1:${(running as any).adminPort}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ names: { "loheth-nextwork": "Loheth" } }),
  });
  expect(response.status).toBe(204);
  await sleep(50);
  ws.close();

  expect(messages.at(-1).reviewQueue).toEqual([{ reviewer: "Loheth", prs: [4] }]);
});
