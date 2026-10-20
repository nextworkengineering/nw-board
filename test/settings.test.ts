import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createSettings, type Patch, type Settings } from "../src/settings.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const BASE = {
  trackedRepos: ["example-org/features"],
  quietHours: { soundStart: "09:00", soundEnd: "18:00" },
  chimes: ["09:00", "17:00"],
};

const reminder = { id: "standup", kind: "reminder", text: "Standup in 5", sound: null, time: "10:00", days: [1, 2, 3, 4, 5] };

/** A Settings Store over a temp config.json, its Sound Library holding builtin.mp3 only. */
function store(config: Record<string, unknown> = BASE) {
  const dir = mkdtempSync(join(tmpdir(), "pr-arcade-settings-"));
  dirs.push(dir);
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const applied: Partial<Settings>[] = [];
  const settings = createSettings({
    configPath,
    config,
    inLibrary: (path) => path === "builtin.mp3",
    onApply: (patch) => applied.push(patch),
  });
  const onDisk = () => JSON.parse(readFileSync(configPath, "utf8"));
  return { settings, applied, configPath, onDisk };
}

test("boot fills the optional settings in", () => {
  expect(store().settings.current()).toEqual({
    theme: "kernel",
    quietHours: { soundStart: "09:00", soundEnd: "18:00" },
    chimes: ["09:00", "17:00"],
    names: {},
    sounds: {},
    schedules: [],
  });
});

test.for<[string, Patch, Partial<Settings>]>([
  ["a permanent Theme", { theme: "neobrutal" }, { theme: "neobrutal" }],
  [
    "Quiet Hours, trimmed to its two times",
    { quietHours: { soundStart: "08:00", soundEnd: "20:00", extra: 1 } },
    { quietHours: { soundStart: "08:00", soundEnd: "20:00" } },
  ],
  ["Day Chimes", { chimes: ["08:30"] }, { chimes: ["08:30"] }],
  ["names", { names: { octocat: "Octo" } }, { names: { octocat: "Octo" } }],
  ["a sound slot", { sounds: { "pr-merged": "builtin.mp3" } }, { sounds: { "pr-merged": "builtin.mp3" } }],
  [
    "schedules, normalized",
    { schedules: [{ ...reminder, sound: undefined, stray: true }] },
    { schedules: [reminder as Settings["schedules"][number]] },
  ],
])("every write persists and notifies: %s", ([, patch, expected]) => {
  const { settings, applied, onDisk } = store();

  settings.patch(patch);

  expect(onDisk()).toEqual({ ...BASE, ...expected });
  expect(settings.current()).toMatchObject(expected);
  expect(applied).toEqual([expected]);
});

test("sound slots patch slot by slot; null puts a default back", () => {
  const { settings, applied, onDisk } = store({ ...BASE, sounds: { "day-chime": "builtin.mp3" } });

  settings.patch({ sounds: { "pr-merged": "builtin.mp3" } });
  settings.patch({ sounds: { "day-chime": null } });

  expect(settings.current().sounds).toEqual({ "pr-merged": "builtin.mp3" });
  expect(onDisk().sounds).toEqual({ "pr-merged": "builtin.mp3" });
  expect(applied.map(({ sounds }) => sounds)).toEqual([
    { "day-chime": "builtin.mp3", "pr-merged": "builtin.mp3" },
    { "pr-merged": "builtin.mp3" },
  ]);
});

test.for<[string, Patch, RegExp]>([
  ["a Theme that is no file", { theme: "nope" }, /theme must name a file/],
  ["a Theme out of the directory", { theme: "../x" }, /theme must name a file/],
  ["Quiet Hours not HH:MM", { quietHours: { soundStart: "9am", soundEnd: "18:00" } }, /quietHours/],
  ["a chime out of range", { chimes: ["24:00"] }, /chimes/],
  ["a name that is not a string", { names: { octocat: 7 } }, /names\.octocat/],
  ["names as null", { names: null }, /names must be/],
  ["an unknown slot", { sounds: { "pr-closed": "builtin.mp3" } }, /pr-closed is not one of/],
  ["a clip not in the library", { sounds: { "pr-merged": "uploads/gone.mp3" } }, /not in the Sound Library/],
  ["a malformed schedule", { schedules: [{ ...reminder, kind: "party" }] }, /schedules\[0\]: kind/],
  ["a schedule's clip not in the library", { schedules: [{ ...reminder, sound: "uploads/gone.mp3" }] }, /schedules\[0\]/],
  ["more than 100 schedules", { schedules: Array.from({ length: 101 }, (_, i) => ({ ...reminder, id: `r${i}` })) }, /at most 100/],
  ["a good field beside a bad one", { chimes: ["10:00"], names: [] }, /names must be/],
])("a write with %s is a 400: nothing persisted, nothing notified", ([, patch, message]) => {
  const { settings, applied, configPath } = store();
  const before = readFileSync(configPath, "utf8");
  const current = settings.current();

  expect(() => settings.patch(patch)).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(message) }));

  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect(settings.current()).toBe(current);
  expect(applied).toEqual([]);
});

test("a write keeps the keys it does not own, and hand-edits made since boot", () => {
  const { settings, configPath, onDisk } = store();
  writeFileSync(configPath, JSON.stringify({ ...BASE, newsFeedUrl: "https://example.com/feed.xml", theme: "arcade" }));

  settings.patch({ chimes: ["08:00"] });

  expect(onDisk()).toEqual({ ...BASE, chimes: ["08:00"], newsFeedUrl: "https://example.com/feed.xml", theme: "arcade" });
});

test("a config.json that cannot be read applies nothing", () => {
  const { settings, applied, configPath } = store();
  writeFileSync(configPath, "{ hand-edited, broken");

  expect(() => settings.patch({ chimes: ["08:00"] })).toThrow(SyntaxError);

  expect(settings.current().chimes).toEqual(["09:00", "17:00"]);
  expect(applied).toEqual([]);
});

test("boot runs the same checks, naming the file", () => {
  expect(() => store({ ...BASE, chimes: "09:00" })).toThrow(/config\.json: chimes must be a list/);
  expect(() => store({ ...BASE, quietHours: undefined })).toThrow(/config\.json: quietHours/);
  expect(() => store({ ...BASE, names: null })).toThrow(/config\.json: names must be/);
  expect(() => store({ ...BASE, theme: "nope" })).toThrow(/config\.json: theme must name a file/);
  expect(() => store({ ...BASE, schedules: [{ ...reminder, kind: "party" }] })).toThrow(/config\.json: schedules\[0\]/);
});

test("at boot a clip gone from the library and a list over 100 only warn; a write still refuses them", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { settings } = store({
    ...BASE,
    sounds: { "pr-merged": "uploads/gone.mp3", "day-chime": "builtin.mp3" },
    schedules: Array.from({ length: 101 }, (_, i) => ({ ...reminder, id: `r${i}`, sound: i ? null : "uploads/gone.mp3" })),
  });

  expect(settings.current().sounds).toEqual({ "day-chime": "builtin.mp3" });
  expect(settings.current().schedules).toHaveLength(100);
  expect(settings.current().schedules[0]!.sound).toBeNull();
  expect(warn.mock.calls.map(([line]) => line)).toEqual([
    expect.stringMatching(/sounds\.pr-merged: uploads\/gone\.mp3 is not in the Sound Library, ignoring it/),
    expect.stringMatching(/more than 100 schedules, keeping the first 100/),
    expect.stringMatching(/schedules\[0\]: uploads\/gone\.mp3 is not in the Sound Library, ignoring it/),
  ]);
  expect(() => settings.patch({ sounds: { "pr-merged": "uploads/gone.mp3" } })).toThrow(/not in the Sound Library/);
});
