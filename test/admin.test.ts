import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { startServer } from "../src/server.ts";
import { connectedDisplay, fixture, postAndWatch, readSnapshot } from "./helpers.ts";

type Running = Awaited<ReturnType<typeof startServer>>;
let running: Running | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  trackedRepos: [],
  quietHours: { soundStart: "09:00", soundEnd: "18:00" },
  chimes: ["09:00", "17:00"],
};

/** A temp config.json plus a Sound Library holding one committed clip, builtin.mp3. */
function setup(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pr-arcade-admin-"));
  tempDirs.push(dir);
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ ...BASE, ...extra }, null, 2));
  const soundsDir = join(dir, "sounds");
  mkdirSync(soundsDir);
  writeFileSync(join(soundsDir, "builtin.mp3"), MP3);
  return { configPath, soundsDir };
}

// August 2026: the 13th is a Thursday (getDay() 4).
const at = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 7, day, hour, minute, second).getTime();
const THURSDAY = 13;

/** An ID3 header is all the server's mp3 check reads; the stub normalizer never decodes it. */
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(32)]);
/** Copies instead of normalizing, so tests need neither python3 nor lame. */
const stubNormalize = async (src: string, dest: string) => {
  copyFileSync(src, dest);
  return `${src} -> ${dest}\n  loudness  -20.00 ->  -16.20 dBFS\n`;
};

async function start(
  paths: ReturnType<typeof setup>,
  clock: () => number = () => at(THURSDAY, 10),
  tickMs?: number,
) {
  running = await startServer(0, {
    ...paths,
    now: clock,
    tickMs,
    normalize: stubNormalize,
  });
  return running;
}

const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${running!.adminPort}${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const upload = (name: string, body: Buffer = MP3) =>
  fetch(`http://127.0.0.1:${running!.adminPort}/api/sounds?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "audio/mpeg" },
    body: new Uint8Array(body),
  });
const state = async () => (await api("GET", "/api/state")).json();

test("the admin port answers /api/state; the public port has no /api at all", async () => {
  const paths = setup({ names: { octocat: "Octo" } });
  await start(paths);

  expect(await state()).toEqual({
    you: null,
    theme: { current: "kernel", default: "kernel", all: ["arcade", "kernel", "neobrutal"] },
    quietHours: { soundStart: "09:00", soundEnd: "18:00" },
    chimes: ["09:00", "17:00"],
    names: { octocat: "Octo" },
    sounds: { slots: {}, library: ["builtin.mp3"] },
    schedules: [],
  });

  const signedIn = await api("GET", "/api/state", undefined, { "tailscale-user-login": "mona@example.com" });
  expect((await signedIn.json()).you).toBe("mona@example.com");

  const pub = (method: string, path: string) =>
    fetch(`http://127.0.0.1:${running!.port}${path}`, { method });
  expect((await pub("GET", "/api/state")).status).toBe(404);
  expect((await pub("POST", "/api/theme")).status).toBe(404);
  expect((await pub("POST", "/api/wau-target-hit")).status).toBe(404);
  expect((await pub("PUT", "/api/settings")).status).toBe(404);
});

test.for([
  ["quiet hours not HH:MM", { quietHours: { soundStart: "9am", soundEnd: "18:00" } }],
  ["quiet hours given as a list", { quietHours: { soundStart: ["09:00"], soundEnd: "18:00" } }],
  ["chimes not a list", { chimes: "09:00" }],
  ["a chime out of range", { chimes: ["24:00"] }],
  ["a name that is not a string", { names: { octocat: 7 } }],
  ["names as a list", { names: ["octocat"] }],
  ["a good field next to a bad one", { chimes: ["10:00"], names: null }],
  ["nothing to change", {}],
])("PUT /api/settings with %s is a 400 and leaves config.json alone", async ([, body]) => {
  const paths = setup();
  const before = readFileSync(paths.configPath, "utf8");
  await start(paths);

  const response = await api("PUT", "/api/settings", body);

  expect(response.status).toBe(400);
  expect((await response.json()).error).toEqual(expect.any(String));
  expect(readFileSync(paths.configPath, "utf8")).toBe(before);
  expect((await state()).chimes).toEqual(["09:00", "17:00"]);
});

test("a settings PUT applies live and survives a restart", async () => {
  const paths = setup({ newsFeedUrl: "https://example.com/feed.xml" });
  await start(paths);
  const settings = {
    quietHours: { soundStart: "08:00", soundEnd: "20:00" },
    chimes: ["08:30", "16:30"],
    names: { octocat: "Octo" },
  };

  expect((await api("PUT", "/api/settings", settings)).status).toBe(204);
  expect(await state()).toMatchObject(settings);

  await running!.close();
  await start(paths);
  expect(await state()).toMatchObject(settings);
  // The keys the console doesn't own come through the rewrite untouched.
  expect(JSON.parse(readFileSync(paths.configPath, "utf8"))).toMatchObject({
    trackedRepos: [],
    newsFeedUrl: "https://example.com/feed.xml",
  });
});

const reminder = {
  id: "standup",
  kind: "reminder",
  text: "Standup in 5",
  sound: null,
  time: "10:00",
  days: [1, 2, 3, 4, 5],
};

test.for([
  ["not a list", { reminder }],
  ["a missing id", [{ ...reminder, id: "" }]],
  ["a repeated id", [reminder, reminder]],
  ["an unknown kind", [{ ...reminder, kind: "party" }]],
  ["empty text", [{ ...reminder, text: "  " }]],
  ["text over 120 characters", [{ ...reminder, text: "x".repeat(121) }]],
  ["a clip not in the library", [{ ...reminder, sound: "uploads/nope.mp3" }]],
  ["a clip outside the library", [{ ...reminder, sound: "../../config.json" }]],
  ["a time that is not HH:MM", [{ ...reminder, time: "10:00pm" }]],
  ["both date and days", [{ ...reminder, date: "2026-08-13" }]],
  ["neither date nor days", [{ ...reminder, days: undefined }]],
  ["a bad date", [{ ...reminder, days: undefined, date: "2026-13-01" }]],
  ["no days", [{ ...reminder, days: [] }]],
  ["a day out of range", [{ ...reminder, days: [7] }]],
  ["a repeated day", [{ ...reminder, days: [1, 1] }]],
])("PUT /api/schedules with %s is a 400 and leaves config.json alone", async ([, body]) => {
  const paths = setup();
  const before = readFileSync(paths.configPath, "utf8");
  await start(paths);

  expect((await api("PUT", "/api/schedules", body)).status).toBe(400);
  expect(readFileSync(paths.configPath, "utf8")).toBe(before);
});

/** Start at `from`, connect a display, move the clock to `to`, and collect what it was pushed. */
async function watch(paths: ReturnType<typeof setup>, from: number, to: number, before?: () => Promise<void>) {
  let clock = from;
  await start(paths, () => clock, 10);
  await before?.();
  const { ws, messages } = await connectedDisplay(running!.port);
  await sleep(50);
  clock = to;
  await sleep(200);
  ws.close();
  return messages.filter((message) => message.type !== "snapshot");
}

test.for([
  ["inside Quiet Hours' sound window is audible", 10, true],
  ["outside it is silent", 20, false],
])("a weekly schedule reaching its minute %s, and fires once", async ([, hour, audible]) => {
  const time = `${hour}:00`;
  const paths = setup({
    schedules: [
      { ...reminder, time },
      { id: "cake", kind: "celebration", text: "Cake!", sound: "builtin.mp3", time, days: [4] },
      // Not today (Thursday is 4).
      { ...reminder, id: "friday", time, days: [5] },
    ],
  });

  // 200ms of 10ms ticks: a schedule that fired per tick would show up many times over.
  const received = await watch(paths, at(THURSDAY, hour as number - 1, 59, 55), at(THURSDAY, hour as number));

  expect(received).toEqual([
    { type: "reminder", text: "Standup in 5", sound: null, audible },
    { type: "scheduled-celebration", text: "Cake!", sound: "sounds/builtin.mp3", audible },
  ]);
});

test("a one-off fires on its date only", async () => {
  const oneOff = (id: string, date: string) => ({ ...reminder, id, text: id, days: undefined, date });
  const paths = setup({ schedules: [oneOff("today", "2026-08-13"), oneOff("tomorrow", "2026-08-14")] });

  const received = await watch(paths, at(THURSDAY, 9, 59, 55), at(THURSDAY, 10));

  expect(received).toEqual([{ type: "reminder", text: "today", sound: null, audible: true }]);
});

test("a schedule PUT through the console is live, and fires alongside a chime at the same minute", async () => {
  const paths = setup();
  const schedule = { ...reminder, time: "17:00" };
  const received = await watch(paths, at(THURSDAY, 16, 59, 55), at(THURSDAY, 17), async () => {
    expect((await api("PUT", "/api/schedules", [schedule])).status).toBe(204);
  });

  expect(received).toEqual([
    { type: "day-chime", at: "17:00", last: true },
    { type: "reminder", text: "Standup in 5", sound: null, audible: true },
  ]);
  expect((await state()).schedules).toEqual([schedule]);
  expect(JSON.parse(readFileSync(paths.configPath, "utf8")).schedules).toEqual([schedule]);
});

test.for([
  ["the first chime is flagged not last", 9, { type: "day-chime", at: "09:00", last: false }],
  ["the latest chime is flagged last", 17, { type: "day-chime", at: "17:00", last: true }],
])("%s", async ([, hour, message]) => {
  const received = await watch(setup(), at(THURSDAY, hour as number - 1, 59, 55), at(THURSDAY, hour as number));
  expect(received).toEqual([message]);
});

test("the last flag follows chime times edited live", async () => {
  const paths = setup();
  const received = await watch(paths, at(THURSDAY, 16, 59, 55), at(THURSDAY, 17), async () => {
    expect((await api("PUT", "/api/settings", { chimes: ["17:00", "18:30"] })).status).toBe(204);
  });
  expect(received).toEqual([{ type: "day-chime", at: "17:00", last: false }]);
});

// The board's fallback for a chime with no flag is "17:00 is the end", so a 17:00
// that is not the latest must say so, or the day ends twice.
test("a middle 17:00 chime carries last:false", async () => {
  const paths = setup({ chimes: ["09:00", "17:00", "18:00"] });
  const received = await watch(paths, at(THURSDAY, 16, 59, 55), at(THURSDAY, 17));
  expect(received).toEqual([{ type: "day-chime", at: "17:00", last: false }]);
});

test("a clock stepped back across a minute that already fired does not fire it again", async () => {
  let clock = at(THURSDAY, 9, 58, 55);
  await start(setup({ chimes: ["09:59", "10:00"] }), () => clock, 10);
  const { ws, messages } = await connectedDisplay(running!.port);
  for (const next of [at(THURSDAY, 9, 59), at(THURSDAY, 10), at(THURSDAY, 9, 59, 30), at(THURSDAY, 10, 0, 10)]) {
    await sleep(80);
    clock = next;
  }
  await sleep(80);
  ws.close();
  expect(messages.filter((m) => m.type !== "snapshot")).toEqual([
    { type: "day-chime", at: "09:59", last: false },
    { type: "day-chime", at: "10:00", last: true },
  ]);
});

test("an upload is normalized into the library and answers with the normalizer's output", async () => {
  const paths = setup();
  await start(paths);

  const response = await upload("airhorn.mp3");

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    path: "uploads/airhorn.mp3",
    // The hidden temp files the normalizer was handed read as the upload and its library path.
    output: "airhorn.mp3 -> uploads/airhorn.mp3\n  loudness  -20.00 ->  -16.20 dBFS\n",
  });
  expect((await state()).sounds.library).toEqual(["builtin.mp3", "uploads/airhorn.mp3"]);
  // Previewable from the console, and no temp files left behind.
  const preview = await api("GET", "/sounds/uploads/airhorn.mp3");
  expect(Buffer.from(await preview.arrayBuffer())).toEqual(MP3);
  expect(readdirSync(join(paths.soundsDir, "uploads"))).toEqual(["airhorn.mp3"]);
  // No overwriting: replacing a clip is delete, then upload.
  expect((await upload("airhorn.mp3")).status).toBe(409);
});

test.for([
  ["a path out of the directory", "../x.mp3"],
  ["upper case", "X.MP3"],
  ["a nested path", "uploads/x.mp3"],
  ["not .mp3", "x.wav"],
  ["no name", ""],
])("an upload named with %s is a 400 and writes nothing", async ([, name]) => {
  const paths = setup();
  await start(paths);
  expect((await upload(name)).status).toBe(400);
  expect(existsSync(join(paths.soundsDir, "uploads"))).toBe(false);
  expect(readdirSync(paths.soundsDir)).toEqual(["builtin.mp3"]);
});

test.for([
  ["a WAV", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(32)])],
  ["AAC (ADTS)", Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0])],
  ["an empty body", Buffer.alloc(0)],
])("uploading %s is a 400", async ([, body]) => {
  const paths = setup();
  await start(paths);
  expect((await upload("x.mp3", body as Buffer)).status).toBe(400);
  expect(existsSync(join(paths.soundsDir, "uploads"))).toBe(false);
});

test("an MPEG frame with no ID3 tag is accepted", async () => {
  await start(setup());
  expect((await upload("bare.mp3", Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]))).status).toBe(201);
});

test("a failing normalizer is a 422 carrying its complaint, and adds nothing", async () => {
  const paths = setup();
  running = await startServer(0, {
    ...paths,
    normalize: async () => {
      throw new Error("lame: not an mp3");
    },
  });
  const response = await upload("broken.mp3");
  expect(response.status).toBe(422);
  expect((await response.json()).error).toMatch(/lame: not an mp3/);
  expect(readdirSync(join(paths.soundsDir, "uploads"))).toEqual([]);
});

test("a slot assignment is saved and rides the snapshot; null puts the default back", async () => {
  const paths = setup();
  await start(paths);
  await upload("airhorn.mp3");
  const { ws, messages } = await connectedDisplay(running!.port);

  const assign = { "pr-merged": "uploads/airhorn.mp3", "day-chime": "builtin.mp3" };
  expect((await api("PUT", "/api/sound-slots", assign)).status).toBe(204);
  expect((await api("PUT", "/api/sound-slots", { "day-chime": null })).status).toBe(204);
  await sleep(50);
  ws.close();

  expect(messages.filter((m) => m.type === "snapshot").map((m) => m.sounds)).toEqual([
    {},
    { "pr-merged": "sounds/uploads/airhorn.mp3", "day-chime": "sounds/builtin.mp3" },
    { "pr-merged": "sounds/uploads/airhorn.mp3" },
  ]);
  expect(JSON.parse(readFileSync(paths.configPath, "utf8")).sounds).toEqual({
    "pr-merged": "uploads/airhorn.mp3",
  });

  await running!.close();
  await start(paths);
  expect((await readSnapshot(running!.port)).sounds).toEqual({
    "pr-merged": "sounds/uploads/airhorn.mp3",
  });
});

test.for([
  ["an unknown slot", { "pr-closed": "builtin.mp3" }],
  ["a clip not in the library", { "pr-merged": "uploads/nope.mp3" }],
  ["a path out of the library", { "pr-merged": "../themes/kernel.js" }],
  ["a list", ["builtin.mp3"]],
])("assigning %s is a 400 and leaves config.json alone", async ([, body]) => {
  const paths = setup();
  const before = readFileSync(paths.configPath, "utf8");
  await start(paths);
  expect((await api("PUT", "/api/sound-slots", body)).status).toBe(400);
  expect(readFileSync(paths.configPath, "utf8")).toBe(before);
});

test("an upload cannot be deleted while a slot or a schedule uses it", async () => {
  const paths = setup();
  await start(paths);
  await upload("gong.mp3");
  const file = join(paths.soundsDir, "uploads", "gong.mp3");

  await api("PUT", "/api/sound-slots", { "pr-opened": "uploads/gong.mp3" });
  const bySlot = await api("DELETE", "/api/sounds/uploads/gong.mp3");
  expect(bySlot.status).toBe(409);
  expect((await bySlot.json()).error).toMatch(/pr-opened/);

  await api("PUT", "/api/sound-slots", { "pr-opened": null });
  await api("PUT", "/api/schedules", [{ ...reminder, sound: "uploads/gong.mp3" }]);
  expect((await api("DELETE", "/api/sounds/uploads/gong.mp3")).status).toBe(409);
  expect(existsSync(file)).toBe(true);

  await api("PUT", "/api/schedules", []);
  expect((await api("DELETE", "/api/sounds/uploads/gong.mp3")).status).toBe(204);
  expect(existsSync(file)).toBe(false);
  expect((await api("DELETE", "/api/sounds/uploads/gong.mp3")).status).toBe(404);
  // The committed clips are not deletable at all, and a traversal never names a file.
  expect((await api("DELETE", "/api/sounds/builtin.mp3")).status).toBe(404);
  expect((await api("DELETE", "/api/sounds/uploads/..%2Fbuiltin.mp3")).status).toBe(400);
  expect(existsSync(join(paths.soundsDir, "builtin.mp3"))).toBe(true);
});

test("the theme set through the console is broadcast, and permanent rewrites config.theme", async () => {
  const paths = setup();
  await start(paths);
  const { ws, messages } = await connectedDisplay(running!.port);
  await sleep(50);

  expect((await api("POST", "/api/theme", { name: "arcade" })).status).toBe(204);
  expect((await api("DELETE", "/api/theme")).status).toBe(204);
  expect((await api("POST", "/api/theme", { name: "neobrutal", permanent: true })).status).toBe(204);
  expect((await api("POST", "/api/theme", { name: "nope" })).status).toBe(404);
  expect((await api("POST", "/api/theme", { name: "index" })).status).toBe(404);
  expect((await api("POST", "/api/theme", {})).status).toBe(400);
  await sleep(50);
  ws.close();

  expect(messages.filter((m) => m.type === "snapshot").map((m) => m.theme)).toEqual([
    "kernel",
    "arcade",
    "kernel",
    "neobrutal",
  ]);
  expect((await state()).theme).toMatchObject({ current: "neobrutal", default: "neobrutal" });
  expect(JSON.parse(readFileSync(paths.configPath, "utf8")).theme).toBe("neobrutal");
});

test("Replay Target Hit through the console takes the board over", async () => {
  await start(setup());
  const { ws, messages } = await connectedDisplay(running!.port);
  expect((await api("POST", "/api/wau-target-hit", {})).status).toBe(204);
  await sleep(50);
  ws.close();
  expect(messages).toContainEqual(expect.objectContaining({ type: "wau-target-hit", audible: true }));
});

test("a cross-site page cannot write through a tailnet user's browser", async () => {
  const paths = setup();
  const before = readFileSync(paths.configPath, "utf8");
  await start(paths);
  const crossSite = { "sec-fetch-site": "cross-site" };
  expect((await api("POST", "/api/wau-target-hit", undefined, crossSite)).status).toBe(403);
  expect((await api("PUT", "/api/settings", { chimes: [] }, crossSite)).status).toBe(403);
  expect(readFileSync(paths.configPath, "utf8")).toBe(before);
  // The console's own page is same-origin.
  expect((await api("PUT", "/api/settings", { chimes: [] }, { "sec-fetch-site": "same-origin" })).status).toBe(204);
});

test("every admin write is logged with the Tailscale user", async () => {
  await start(setup());
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    await api("DELETE", "/api/theme", undefined, { "tailscale-user-login": "mona@example.com" });
    await api("DELETE", "/api/theme");
  } finally {
    console.log = log;
  }
  expect(lines).toEqual([
    "admin: mona@example.com cleared the live theme",
    "admin: local cleared the live theme",
  ]);
});

test.for([
  ["a slot naming something that is not a path", { sounds: { "pr-merged": 7 } }, /sounds\.pr-merged/],
  ["a malformed schedule", { schedules: [{ ...reminder, kind: "party" }] }, /schedules\[0\]/],
])("the server refuses to start with %s", async ([, extra, message]) => {
  await expect(startServer(0, { ...setup(extra as Record<string, unknown>) })).rejects.toThrow(
    message as RegExp,
  );
});

test("a clip deleted by hand while assigned only warns at boot: the slot defaults, the schedule goes quiet", async () => {
  const paths = setup();
  await start(paths);
  await upload("gong.mp3");
  await api("PUT", "/api/sound-slots", { "pr-merged": "uploads/gong.mp3", "day-chime": "builtin.mp3" });
  await api("PUT", "/api/schedules", [{ ...reminder, sound: "uploads/gong.mp3" }]);
  await running!.close();
  unlinkSync(join(paths.soundsDir, "uploads", "gong.mp3"));

  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (line: string) => warnings.push(line);
  try {
    await start(paths);
  } finally {
    console.warn = warn;
  }

  expect(warnings.slice(0, 2)).toEqual([
    expect.stringMatching(/sounds\.pr-merged: uploads\/gong\.mp3/),
    expect.stringMatching(/schedules\[0\]: uploads\/gong\.mp3/),
  ]);
  const { sounds, schedules } = await state();
  expect(sounds.slots).toEqual({ "day-chime": "builtin.mp3" });
  expect(schedules).toEqual([{ ...reminder, sound: null }]);
  // An API write still refuses the missing clip.
  expect((await api("PUT", "/api/sound-slots", { "pr-merged": "uploads/gong.mp3" })).status).toBe(400);
});

test("more than 100 schedules is a 400", async () => {
  await start(setup());
  const many = Array.from({ length: 101 }, (_, i) => ({ ...reminder, id: `r${i}` }));
  expect((await api("PUT", "/api/schedules", many)).status).toBe(400);
  expect((await api("PUT", "/api/schedules", many.slice(0, 100))).status).toBe(204);
});

test("a second upload while one is normalizing is a 429", async () => {
  const paths = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const normalizing = new Promise<void>((resolve) => (started = resolve));
  running = await startServer(0, {
    ...paths,
    normalize: async (src, dest) => {
      started();
      await gate;
      return stubNormalize(src, dest);
    },
  });

  const first = upload("one.mp3");
  await normalizing;
  const second = await upload("two.mp3");
  expect(second.status).toBe(429);
  expect((await second.json()).error).toEqual(expect.any(String));
  release();
  expect((await first).status).toBe(201);
  // Free again once the first is done.
  expect((await upload("three.mp3")).status).toBe(201);
});

test("an Admin Console port already in use leaves the board running", async () => {
  const squatter = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => squatter.once("listening", resolve));
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (line: string) => warnings.push(line);
  try {
    running = await startServer(0, { ...setup(), adminPort: (squatter.address() as { port: number }).port });
  } finally {
    console.warn = warn;
    squatter.close();
  }
  expect(warnings).toContainEqual(expect.stringMatching(/^Admin Console not started: .*EADDRINUSE/));
  expect((await fetch(`http://127.0.0.1:${running.port}/celebrations`)).status).toBe(200);
  expect((await readSnapshot(running.port)).type).toBe("snapshot");
});

test.for([
  ["a replay", "/api/wau-target-hit"],
  ["an upload", "/api/sounds?name=x.mp3"],
  ["a settings write", "/api/settings"],
])("%s sent as text/plain (a CORS-simple request) is a 415", async ([, path]) => {
  const paths = setup();
  const before = readFileSync(paths.configPath, "utf8");
  await start(paths);
  const response = await fetch(`http://127.0.0.1:${running!.adminPort}${path}`, {
    method: path === "/api/settings" ? "PUT" : "POST",
    headers: { "content-type": "text/plain" },
    body: path === "/api/settings" ? JSON.stringify({ chimes: [] }) : new Uint8Array(MP3),
  });
  expect(response.status).toBe(415);
  expect(readFileSync(paths.configPath, "utf8")).toBe(before);
  expect(existsSync(join(paths.soundsDir, "uploads"))).toBe(false);
});

test("a redelivered approval stays deduped after its reviewer is renamed", async () => {
  const paths = setup({ trackedRepos: ["example-org/features"], names: { "reviewer-rita": "Rita" } });
  await start(paths);
  const approval = (login: string) => ({
    event: "pull_request_review",
    body: JSON.stringify({
      ...JSON.parse(fixture("pull-request-review.json")),
      review: { state: "approved", user: { login } },
    }),
  });

  const first = await postAndWatch(running!.port, approval("reviewer-rita"));
  expect(first.received).toMatchObject([{ type: "review-approved", actor: "Rita" }]);
  expect((await api("PUT", "/api/settings", { names: { "reviewer-rita": "Margarita" } })).status).toBe(204);
  expect((await postAndWatch(running!.port, approval("reviewer-rita"))).received).toEqual([]);
  expect((await readSnapshot(running!.port)).feed).toHaveLength(1);

  // A login that names an Object.prototype key is still just a login.
  const odd = await postAndWatch(running!.port, approval("constructor"));
  expect(odd.received).toMatchObject([{ type: "review-approved", actor: "constructor", teammate: false }]);
});
