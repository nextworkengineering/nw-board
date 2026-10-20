import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import { connectedDisplay, readSnapshot } from "./helpers.ts";

let running: { port: number; close: () => Promise<void> } | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(theme?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pr-arcade-theme-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      trackedRepos: [],
      quietHours: { soundStart: "09:00", soundEnd: "18:00" },
      chimes: [],
      ...(theme === undefined ? {} : { theme }),
    }),
  );
  return path;
}

const thursdayAt = (hour: number, minute = 0) => new Date(2026, 7, 13, hour, minute).getTime();
const call = (method: string, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${running!.port}${path}`, { method, headers });
const themes = (messages: any[]) =>
  messages.filter((message) => message.type === "snapshot").map((snapshot) => snapshot.theme);

test.for([
  ["no theme key", undefined, "kernel"],
  ["theme: arcade", "arcade", "arcade"],
])("with %s the snapshot carries the config's Theme", async ([, theme, expected]) => {
  running = await startServer(0, { configPath: config(theme), now: () => thursdayAt(10) });
  const { ws, messages } = await connectedDisplay(running.port);
  await sleep(50);
  ws.close();
  expect(themes(messages)).toEqual([expected]);
});

test.for([["nope"], ["index"], ["../x"], ["Kernel"], [42]])(
  "the server refuses to start when config.theme is %s",
  async ([theme]) => {
    await expect(startServer(0, { configPath: config(theme) })).rejects.toThrow(
      /theme must name a file in public\/themes\//,
    );
  },
);

test("POST /theme?name= swaps the Theme and DELETE /theme puts config.theme back", async () => {
  running = await startServer(0, { configPath: config("arcade"), now: () => thursdayAt(10) });
  const { ws, messages } = await connectedDisplay(running.port);
  await sleep(50);
  expect((await call("POST", "/theme?name=kernel")).status).toBe(204);
  await sleep(50);
  expect((await call("DELETE", "/theme")).status).toBe(204);
  await sleep(50);
  ws.close();
  expect(themes(messages)).toEqual(["arcade", "kernel", "arcade"]);
});

test.for([
  ["?name=nope", 404],
  ["?name=index", 404],
  ["?name=..%2Fkernel", 404],
  ["", 400],
  ["?permanent", 400],
  ["?name=kernel&name=arcade", 400],
])("POST /theme%s names no Theme: %i, nothing broadcast", async ([query, status]) => {
  running = await startServer(0, { configPath: config(), now: () => thursdayAt(10) });
  const { ws, messages } = await connectedDisplay(running.port);
  const response = await call("POST", `/theme${query}`);
  await sleep(50);
  ws.close();
  expect(response.status).toBe(status);
  expect(themes(messages)).toEqual(["kernel"]);
});

test("a proxied request (Funnel adds X-Forwarded-For) cannot touch the Theme", async () => {
  running = await startServer(0, { configPath: config(), now: () => thursdayAt(10) });
  const { ws, messages } = await connectedDisplay(running.port);
  const proxied = { "x-forwarded-for": "1.2.3.4" };
  const post = await call("POST", "/theme?name=arcade", proxied);
  const permanent = await call("POST", "/theme?name=arcade&permanent", proxied);
  const remove = await call("DELETE", "/theme", proxied);
  await sleep(50);
  ws.close();
  expect([post.status, permanent.status, remove.status]).toEqual([403, 403, 403]);
  expect(themes(messages)).toEqual(["kernel"]);
});

test("a Target Hit overrides a hand-set Theme, and midnight returns config.theme in one snapshot", async () => {
  // config.theme is arcade so the hand-set kernel is the odd one out: the Target Hit
  // must replace it, and midnight must not bring it back.
  // 10 ms short of midnight: the scheduler re-arms for what is left until the clock moves.
  let clock = thursdayAt(24) - 10;
  running = await startServer(0, { configPath: config("arcade"), now: () => clock });
  await call("POST", "/theme?name=kernel");
  const { ws, messages } = await connectedDisplay(running.port);
  await sleep(50);
  await call("POST", "/wau-target-hit");
  expect((await readSnapshot(running.port)).theme).toBe("arcade");
  clock = new Date(2026, 7, 14, 0, 0, 30).getTime(); // just past midnight
  await sleep(100);
  ws.close();
  // The replay itself sends no snapshot; its Theme rides the wau-target-hit takeover.
  expect(themes(messages)).toEqual(["kernel", "arcade"]);
});

test("a hand-set Theme comes off at local midnight", async () => {
  let clock = thursdayAt(24) - 10;
  running = await startServer(0, { configPath: config(), now: () => clock });
  await call("POST", "/theme?name=arcade");
  const { ws, messages } = await connectedDisplay(running.port);
  await sleep(50);
  clock = new Date(2026, 7, 14, 0, 0, 30).getTime();
  await sleep(100);
  ws.close();
  // One snapshot at midnight carries both the MVP rollover and config.theme.
  expect(themes(messages)).toEqual(["arcade", "kernel"]);
});

test("?permanent rewrites config.json, beats a Target Hit, and survives a restart", async () => {
  const path = config();
  running = await startServer(0, { configPath: path, now: () => thursdayAt(10) });
  await call("POST", "/wau-target-hit");
  const { ws, messages } = await connectedDisplay(running.port);
  await sleep(50);
  expect((await call("POST", "/theme?name=neobrutal&permanent")).status).toBe(204);
  await sleep(50);
  ws.close();
  expect(themes(messages)).toEqual(["arcade", "neobrutal"]);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved).toEqual({
    trackedRepos: [],
    quietHours: { soundStart: "09:00", soundEnd: "18:00" },
    chimes: [],
    theme: "neobrutal",
  });

  await running.close();
  running = await startServer(0, { configPath: path, now: () => thursdayAt(10) });
  expect((await readSnapshot(running.port)).theme).toBe("neobrutal");
});

test("?permanent naming no Theme is a 404 and leaves config.json alone", async () => {
  const path = config("arcade");
  const before = readFileSync(path, "utf8");
  running = await startServer(0, { configPath: path, now: () => thursdayAt(10) });
  expect((await call("POST", "/theme?name=nope&permanent")).status).toBe(404);
  expect(readFileSync(path, "utf8")).toBe(before);
});
