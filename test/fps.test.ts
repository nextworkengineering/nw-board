import { afterEach, expect, test, vi } from "vitest";
import { startServer } from "../src/server.ts";
import { configPath } from "./helpers.ts";

let running: { port: number; close: () => Promise<void> } | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
});

test("the kiosk's ?fps line is logged, and Funnel traffic cannot write to the log", async () => {
  running = await startServer(0, { configPath });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const post = (headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${running!.port}/fps`, {
      method: "POST",
      headers,
      body: "60 FPS — V3D — 0 slow / worst 18ms (5s)",
    });
  expect((await post()).status).toBe(204);
  expect((await post({ "x-forwarded-for": "1.2.3.4" })).status).toBe(403);
  expect(log.mock.calls.filter(([line]) => String(line).startsWith("fps:"))).toEqual([
    ["fps: 60 FPS — V3D — 0 slow / worst 18ms (5s)"],
  ]);
});
