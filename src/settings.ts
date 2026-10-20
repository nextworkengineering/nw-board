import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Schedule } from "./scheduler.ts";

/**
 * The Settings Store: what the Admin Console (and a permanent Theme switch on the Pi)
 * can change, and the only writer of config.json. Boot and every write run the same
 * checks, so nothing a write saves can stop the next boot. A write goes patch →
 * validate → persist → apply → `onApply`, which the server wires to Board State so
 * every write reaches the displays as a fresh snapshot.
 */

/**
 * A complaint about config, whether it came from config.json at boot or from an
 * Admin Console write. The status is what the admin API answers with; at boot it
 * is ignored and the server simply refuses to start.
 */
export const invalid = (complaint: string) => Object.assign(new Error(complaint), { status: 400 });

/** "09:00" -> 540 minutes past local midnight. Anything else is a config error. */
export function minutesOfDay(value: unknown, complaint: string) {
  // A string check, not String(value): ["09:00"] would otherwise pass and be saved.
  const match = typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw invalid(complaint);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * A Theme — the board's whole look — is a file in public/themes/. The pattern keeps
 * a name from walking out of the directory; index.js is the loader, not a look.
 */
export const THEMES_DIR = fileURLToPath(new URL("../public/themes/", import.meta.url));
export const isTheme = (name: unknown): name is string =>
  typeof name === "string" &&
  /^[a-z0-9-]+$/.test(name) &&
  name !== "index" &&
  existsSync(`${THEMES_DIR}${name}.js`);

/**
 * The slots a clip can be assigned to — the board's SAMPLES keys in public/audio.js.
 * An unassigned slot plays the client's built-in default.
 */
const SLOTS = [
  "pr-merged",
  "review-approved",
  "pr-opened",
  "day-start",
  "day-chime",
  "wau-target-hit",
];

// Every tick scans the whole list and every save logs it, so keep it a list a person
// could have typed. Only a hand-edit can exceed it at boot, which keeps the first 100.
const MAX_SCHEDULES = 100;

export type Settings = {
  /** config.theme: the Theme worn whenever no live override holds. */
  theme: string;
  /** Quiet Hours: sound is allowed on weekdays between these two local times only. */
  quietHours: { soundStart: string; soundEnd: string };
  /** Day Chimes: local "HH:MM" times, weekdays only. */
  chimes: string[];
  /** GitHub login -> first name shown on the board. An unmapped login displays as-is. */
  names: Record<string, string>;
  /** Sound slot -> Sound Library path, assigned slots only. */
  sounds: Record<string, string>;
  /** Reminders and Scheduled Celebrations. */
  schedules: Schedule[];
};

/**
 * A write: any subset of the settings, unchecked. Each field present replaces its whole
 * value, except `sounds`, which patches slot by slot: a path assigns that slot, null
 * puts its default back, and a slot not named keeps what it has.
 */
export type Patch = { [Key in keyof Settings]?: unknown };

export function createSettings({
  configPath,
  config,
  inLibrary,
  onApply,
}: {
  configPath: string;
  /** config.json as read at boot. */
  config: Record<string, any>;
  /** Whether a path names a clip in the Sound Library, as the disk has it now. */
  inLibrary: (path: unknown) => boolean;
  /** Told each write's checked fields once they are saved and current. */
  onApply: (applied: Partial<Settings>) => void;
}) {
  // At boot (`boot` true) a path missing from the disk — a clip deleted by hand while
  // assigned — only warns and is dropped: a throw there would be a systemd restart loop.
  // A write still 400s on it, so a typo never gets saved.
  const missing = (boot: boolean, path: unknown, complaint: string) => {
    if (!boot || typeof path !== "string") throw invalid(complaint);
    console.warn(`${configPath}: ${complaint}, ignoring it`);
  };

  const parseTheme = (value: unknown) => {
    if (!isTheme(value)) throw invalid(`theme must name a file in public/themes/, e.g. "kernel"`);
    return value;
  };

  const parseQuietHours = (value: any) => {
    const complaint = `quietHours must be {"soundStart":"HH:MM","soundEnd":"HH:MM"}`;
    minutesOfDay(value?.soundStart, complaint);
    minutesOfDay(value?.soundEnd, complaint);
    return { soundStart: value.soundStart as string, soundEnd: value.soundEnd as string };
  };

  const parseChimes = (value: unknown) => {
    const complaint = `chimes must be a list of "HH:MM"`;
    if (!Array.isArray(value)) throw invalid(complaint);
    for (const chime of value) minutesOfDay(chime, complaint);
    return value as string[];
  };

  const parseNames = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw invalid(`names must be {"<login>": "<first name>"}`);
    for (const [key, name] of Object.entries(value))
      if (typeof name !== "string") throw invalid(`names.${key} must be a string`);
    return value as Record<string, string>;
  };

  /** slot -> library path, or null for the slot's default. Every path is checked against the disk. */
  const parseSlots = (value: unknown, boot: boolean) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw invalid(`sounds must be {"<slot>": "<library path>"}`);
    const slots: Record<string, string | null> = {};
    for (const [slot, path] of Object.entries(value)) {
      if (!SLOTS.includes(slot)) throw invalid(`sounds: ${slot} is not one of ${SLOTS.join(", ")}`);
      if (path !== null && !inLibrary(path))
        missing(boot, path, `sounds.${slot}: ${path} is not in the Sound Library`);
      else slots[slot] = path;
    }
    return slots;
  };

  /** Reminders and Scheduled Celebrations, normalized to exactly the fields the board uses. */
  const parseSchedules = (value: unknown, boot: boolean): Schedule[] => {
    if (!Array.isArray(value)) throw invalid("schedules must be a list");
    if (value.length > MAX_SCHEDULES) {
      if (!boot) throw invalid(`at most ${MAX_SCHEDULES} schedules`);
      console.warn(`${configPath}: more than ${MAX_SCHEDULES} schedules, keeping the first ${MAX_SCHEDULES}`);
      value = value.slice(0, MAX_SCHEDULES);
    }
    const ids = new Set<string>();
    return (value as unknown[]).map((item: any, index): Schedule => {
      const bad = (complaint: string) => invalid(`schedules[${index}]: ${complaint}`);
      if (typeof item !== "object" || item === null) throw bad("must be an object");
      let { id, kind, text, sound = null, time, date, days } = item;
      if (typeof id !== "string" || !id || ids.has(id)) throw bad("id must be a unique non-empty string");
      ids.add(id);
      if (kind !== "reminder" && kind !== "celebration")
        throw bad(`kind must be "reminder" or "celebration"`);
      if (typeof text !== "string" || !text.trim() || text.length > 120)
        throw bad("text must be 1-120 characters");
      if (sound !== null && !inLibrary(sound)) {
        missing(boot, sound, `schedules[${index}]: ${sound} is not in the Sound Library`);
        sound = null;
      }
      minutesOfDay(time, `schedules[${index}]: time must be "HH:MM"`);
      const base = { id, kind, text, sound, time };
      if ((date === undefined) === (days === undefined))
        throw bad("needs exactly one of date (one-off) or days (weekly)");
      if (date !== undefined) {
        if (typeof date !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date))
          throw bad(`date must be "YYYY-MM-DD"`);
        return { ...base, date };
      }
      if (
        !Array.isArray(days) ||
        !days.length ||
        new Set(days).size !== days.length ||
        !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      )
        throw bad("days must be distinct weekdays 0 (Sunday) to 6");
      return { ...base, days };
    });
  };

  /**
   * The one check, for boot and writes alike: every field given, validated and
   * normalized, or a throw naming the first bad one. At boot every field is given
   * (optional ones defaulted by the caller) and slots apply over nothing.
   */
  const parse = (input: Patch, boot: boolean) => {
    const given = (key: keyof Settings) => boot || input[key] !== undefined;
    const parsed: Partial<Settings> = {};
    if (given("theme")) parsed.theme = parseTheme(input.theme);
    if (given("quietHours")) parsed.quietHours = parseQuietHours(input.quietHours);
    if (given("chimes")) parsed.chimes = parseChimes(input.chimes);
    if (given("names")) parsed.names = parseNames(input.names);
    if (given("sounds")) {
      const slots = { ...(boot ? {} : current.sounds), ...parseSlots(input.sounds, boot) };
      parsed.sounds = Object.fromEntries(
        Object.entries(slots).filter(([, path]) => path !== null),
      ) as Record<string, string>;
    }
    if (given("schedules")) parsed.schedules = parseSchedules(input.schedules, boot);
    return parsed;
  };

  let current: Settings;
  try {
    // Optional keys default, since existing Pi configs predate them (and wore kernel
    // before config.theme). quietHours and chimes are required.
    current = parse(
      {
        theme: config.theme ?? "kernel",
        quietHours: config.quietHours,
        chimes: config.chimes,
        names: config.names === undefined ? {} : config.names,
        sounds: config.sounds ?? {},
        schedules: config.schedules ?? [],
      },
      true,
    ) as Settings;
  } catch (error) {
    throw new Error(`${configPath}: ${(error as Error).message}`);
  }

  return {
    /** The settings in force now. Read it each time: a write replaces it. */
    current: () => current,

    /**
     * Check every field of `patch` before anything is saved, so one bad field (a throw
     * carrying status 400) leaves the file, the board and the displays as they were.
     * Then save, make it current and tell `onApply`; returns the fields as saved. Throws,
     * having applied nothing, if config.json cannot be read or written.
     *
     * The file is re-read rather than rewritten from memory: keys the console doesn't
     * own, and hand-edits to fields this write doesn't touch, stay in it (live from the
     * next boot, like any hand-edit). Write-then-rename so a crash mid-write leaves the
     * old file whole. All sync, so two writes in flight cannot interleave and lose each
     * other's fields.
     */
    patch(patch: Patch) {
      const parsed = parse(patch, false);
      const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
      writeFileSync(`${configPath}.tmp`, JSON.stringify({ ...onDisk, ...parsed }, null, 2) + "\n");
      renameSync(`${configPath}.tmp`, configPath);
      current = { ...current, ...parsed };
      onApply(parsed);
      return parsed;
    },
  };
}
