import { execFile } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { WebSocketServer } from "ws";

type DomainEvent = {
  type: string;
  repo: string;
  number: number;
  title: string;
  /** Who did it. Never undefined on the wire: an unnamed GitHub user is "". */
  actor: string;
};

/** The login of whoever GitHub named, or "" when it named nobody. */
const login = (who: any) => who?.login ?? "";

/** Translate a GitHub delivery into the domain vocabulary. Anything else is ignored. */
function toDomainEvent(
  githubEvent: string | undefined,
  payload: any,
): DomainEvent | undefined {
  const repo = payload.repository?.full_name;
  // The PR this delivery is about: issue_comment carries it as `issue`, the rest as
  // `pull_request`. Anything without a numeric `number` is garbage, whatever the shape.
  const pr = githubEvent === "issue_comment" ? payload.issue : payload.pull_request;
  if (typeof pr?.number !== "number") return undefined;
  const { number, title } = pr;

  if (githubEvent === "pull_request") {
    if (payload.action === "opened")
      return { type: "pr-opened", repo, number, title, actor: login(pr.user) };
    if (payload.action === "closed")
      return {
        type: pr.merged ? "pr-merged" : "pr-closed",
        repo,
        number,
        title,
        // A merge belongs to whoever pressed the button; the author stands in when
        // GitHub names no merger.
        actor: (pr.merged && login(pr.merged_by)) || login(pr.user),
      };
  }

  if (githubEvent === "pull_request_review" && payload.action === "submitted") {
    const actor = login(payload.review?.user);
    if (payload.review?.state === "approved")
      return { type: "review-approved", repo, number, title, actor };
    if (payload.review?.state === "changes_requested")
      return { type: "changes-requested", repo, number, title, actor };
  }

  // Only comments on pull requests count; plain issue comments have no `pull_request`.
  if (
    githubEvent === "issue_comment" &&
    payload.action === "created" &&
    pr.pull_request
  ) {
    // The PR comes from `issue`, but the actor is the commenter.
    return {
      type: "pr-comment",
      repo,
      number,
      title,
      actor: login(payload.comment?.user),
    };
  }

  return undefined;
}

/** Celebration Events are the loud ones; everything else is an Ambient Event. */
const CELEBRATIONS = new Set(["pr-merged", "review-approved"]);

/**
 * Events that carry sound. Celebrations plus pr-opened, the one Ambient Event with
 * a voice: it keeps its quiet feed animation and takes over nothing, but it does
 * make a noise, so it needs the same Quiet Hours and roster flags on the wire.
 */
const SOUNDED = new Set([...CELEBRATIONS, "pr-opened"]);

/**
 * A complaint about config, whether it came from config.json at boot or from an
 * Admin Console write. The status is what the admin API answers with; at boot it
 * is ignored and the server simply refuses to start.
 */
const invalid = (complaint: string) => Object.assign(new Error(complaint), { status: 400 });

/** "09:00" -> 540 minutes past local midnight. Anything else is a config error. */
function minutesOfDay(value: unknown, complaint: string) {
  // A string check, not String(value): ["09:00"] would otherwise pass and be saved.
  const match = typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw invalid(complaint);
  return Number(match[1]) * 60 + Number(match[2]);
}

// The live-editable settings, checked identically at boot and on PUT /api/settings,
// so nothing the Admin Console saves can stop the next boot.

/** Quiet Hours: sound is allowed on weekdays between these two local times only. */
function parseQuietHours(value: any) {
  const complaint = `quietHours must be {"soundStart":"HH:MM","soundEnd":"HH:MM"}`;
  minutesOfDay(value?.soundStart, complaint);
  minutesOfDay(value?.soundEnd, complaint);
  return { soundStart: value.soundStart as string, soundEnd: value.soundEnd as string };
}

/** Day Chimes: local times, weekdays only. */
function parseChimes(value: unknown) {
  const complaint = `chimes must be a list of "HH:MM"`;
  if (!Array.isArray(value)) throw invalid(complaint);
  for (const chime of value) minutesOfDay(chime, complaint);
  return value as string[];
}

/**
 * Team member names: GitHub login -> first name shown on the board. Optional;
 * an unmapped login displays as-is, so absence is a cosmetic gap, not an error.
 */
function parseNames(value: unknown = {}) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid(`names must be {"<login>": "<first name>"}`);
  for (const [key, name] of Object.entries(value))
    if (typeof name !== "string") throw invalid(`names.${key} must be a string`);
  return value as Record<string, string>;
}

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

/** A Sound Library file name. The pattern is also what keeps a name inside its directory. */
const SOUND_NAME = /^[a-z0-9-]+\.mp3$/;

/** "YYYY-MM-DD" of `at` in local time — what a one-off schedule's date is compared with. */
const localDate = (at: Date) =>
  `${at.getFullYear()}-${`${at.getMonth() + 1}`.padStart(2, "0")}-${`${at.getDate()}`.padStart(2, "0")}`;

type Schedule = {
  id: string;
  kind: "reminder" | "celebration";
  text: string;
  /** A Sound Library path, e.g. "uploads/gong.mp3"; null plays the board's fallback jingle. */
  sound: string | null;
  time: string;
} & ({ date: string } | { days: number[] });

type Options = {
  /** Path to the JSON config holding the Tracked Repo list. */
  configPath?: string;
  now?: () => number;
  /** Root of the GitHub REST API; tests point this at a stub. */
  githubApiBase?: string;
  /** How often the Day Chime scheduler checks the clock. */
  tickMs?: number;
  /** How often to reconcile merges whose webhook could not reach the board. */
  reconcileMs?: number;
  /** How long the news-feed proxy waits for its configured upstream. */
  newsTimeoutMs?: number;
  /** Root of the PostHog API; tests point this at a stub. */
  posthogApiBase?: string;
  /** How long the WAU dashboard proxy waits for PostHog's cached read. */
  posthogTimeoutMs?: number;
  /** The Admin Console's loopback-only port; 0 picks a free one. */
  adminPort?: number;
  /** The Sound Library root (built-ins, plus uploads/); tests point this at a temp dir. */
  soundsDir?: string;
  /** Normalize an uploaded clip from src into dest, resolving to what it printed. */
  normalize?: (src: string, dest: string) => Promise<string>;
};

const NORMALIZER = fileURLToPath(new URL("../scripts/normalize-sound.py", import.meta.url));
/** scripts/normalize-sound.py, the one door every clip on the board goes through. */
async function normalizeSound(src: string, dest: string) {
  const { stdout, stderr } = await promisify(execFile)("python3", [NORMALIZER, src, dest], {
    timeout: 120_000,
  });
  return stdout + stderr;
}

/** Monday 00:00 local time of the week containing `at` — the dedup window. */
function startOfWeek(at: number) {
  const monday = new Date(at);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday.getTime();
}

/** Local midnight of the day containing `at` — today's MVP starts here. */
const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);

/** The next local midnight after `at` — when a live Theme comes off. */
const nextMidnight = (at: number) => new Date(at).setHours(24, 0, 0, 0);

/**
 * A Theme — the board's whole look — is a file in public/themes/. The pattern keeps
 * a name from walking out of the directory; index.js is the loader, not a look.
 */
const THEMES_DIR = fileURLToPath(new URL("../public/themes/", import.meta.url));
const isTheme = (name: unknown): name is string =>
  typeof name === "string" &&
  /^[a-z0-9-]+$/.test(name) &&
  name !== "index" &&
  existsSync(`${THEMES_DIR}${name}.js`);

const UPSTREAM_MAX_BYTES = 1024 * 1024;
const POSTHOG_PROJECT = 196853;
const POSTHOG_DASHBOARD = 1468050;
const WAU_TILES = {
  currentWau: 7119738,
  targetWau: 7119740,
  targetPercent: 7122309,
  activationPercent: 10992630,
  daily: 7119735,
} as const;

function normalizeWauDashboard(payload: any) {
  const tiles = Array.isArray(payload) ? payload : payload?.results;
  if (!Array.isArray(tiles)) throw new Error("PostHog dashboard has no results list");
  const result = (id: number) => {
    const value = tiles.find((tile: any) => tile?.id === id)?.insight?.result;
    if (!Array.isArray(value)) throw new Error(`PostHog tile ${id} has no result`);
    return value;
  };
  const number = (value: unknown, name: string) => {
    const parsed = typeof value === "string" ? Number(value.replace(/%$/, "")) : value;
    if (typeof parsed !== "number" || !Number.isFinite(parsed))
      throw new Error(`PostHog ${name} is not numeric`);
    return parsed;
  };
  const scalar = (id: number, name: string) => number(result(id)?.[0]?.[0], name);
  // Rows arrive ordered Day 1..7 of the Sat–Fri cycle; the first column is a free
  // label (the insight has carried "Day 1" and "Saturday" so far) and extra
  // columns are ignored, so an edit to the saved query cannot 502 the board.
  const daily = result(WAU_TILES.daily).map((row: unknown, index: number) => {
    if (!Array.isArray(row)) throw new Error("PostHog daily WAU row is malformed");
    return {
      day: index + 1,
      label: String(row[0]),
      current: number(row[1], `daily day ${index + 1} current`),
      previous: number(row[2], `daily day ${index + 1} previous`),
    };
  });
  if (daily.length !== 7) throw new Error("PostHog daily WAU result must contain 7 days");
  return {
    fetchedAt: new Date().toISOString(),
    currentWau: scalar(WAU_TILES.currentWau, "current WAU"),
    targetWau: scalar(WAU_TILES.targetWau, "target WAU"),
    targetPercent: scalar(WAU_TILES.targetPercent, "target percent"),
    activationPercent: scalar(WAU_TILES.activationPercent, "activation percent"),
    daily,
  };
}

async function limitedText(response: Response, complaint = "news feed exceeds 1 MiB") {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > UPSTREAM_MAX_BYTES) {
      await reader.cancel();
      throw new Error(complaint);
    }
    text += decoder.decode(value, { stream: true });
  }
}

export async function startServer(port: number, options: Options = {}) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is not set");

  const configPath =
    options.configPath ?? fileURLToPath(new URL("../config.json", import.meta.url));
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const trackedRepos: string[] = config.trackedRepos;
  // A missing list would 400 every delivery; a bare string would match repos by substring.
  if (!Array.isArray(trackedRepos))
    throw new Error(`${configPath}: trackedRepos must be a list of "owner/name"`);

  /** Run a settings check at boot, naming the file in its complaint. */
  const fromConfig = <T>(parse: () => T) => {
    try {
      return parse();
    } catch (error) {
      throw new Error(`${configPath}: ${(error as Error).message}`);
    }
  };

  // Live-editable from the Admin Console, hence `let`: every reader goes through these.
  let names = fromConfig(() => parseNames(config.names));

  // The dev deploy workflow, as its file name (e.g. "env-dev.yaml"). Optional: with
  // no workflow configured the board simply never names a dev deployer.
  const devDeployWorkflow: string | undefined = config.devDeployWorkflow;
  if (devDeployWorkflow !== undefined && typeof devDeployWorkflow !== "string")
    throw new Error(
      `${configPath}: devDeployWorkflow must be a workflow file name, e.g. "env-dev.yaml"`,
    );

  // Optional because existing Pi installs keep config.json across deploys. A missing
  // URL leaves the news route disabled until the operator adds one and restarts.
  let newsFeedUrl: URL | undefined;
  if (config.newsFeedUrl !== undefined) {
    const complaint = `${configPath}: newsFeedUrl must be an http(s) URL`;
    if (typeof config.newsFeedUrl !== "string") throw new Error(complaint);
    try {
      newsFeedUrl = new URL(config.newsFeedUrl);
    } catch {
      throw new Error(complaint);
    }
    if (newsFeedUrl.protocol !== "http:" && newsFeedUrl.protocol !== "https:")
      throw new Error(complaint);
  }

  let quietHours = fromConfig(() => parseQuietHours(config.quietHours));
  let chimes = fromConfig(() => parseChimes(config.chimes));

  // The Sound Library: the committed clips in public/sounds/ (read-only) plus what the
  // Admin Console uploaded into public/sounds/uploads/ (gitignored, deletable). A path
  // is relative to public/sounds/, which is also where the board fetches it from.
  const soundsDir =
    options.soundsDir ?? fileURLToPath(new URL("../public/sounds", import.meta.url));
  const uploadsDir = join(soundsDir, "uploads");
  const mp3sIn = (dir: string) => {
    try {
      return readdirSync(dir).filter((file) => SOUND_NAME.test(file));
    } catch {
      return []; // no uploads/ until the first upload
    }
  };
  const library = () => [
    ...mp3sIn(soundsDir),
    ...mp3sIn(uploadsDir).map((file) => `uploads/${file}`),
  ];
  // An allow-list read off the disk, so no path can name anything outside it.
  const inLibrary = (path: unknown) => typeof path === "string" && library().includes(path);

  // At boot (`boot` true) a path missing from the disk — a clip deleted by hand while
  // assigned — only warns and is dropped: a throw there would be a systemd restart loop.
  // An Admin Console write still 400s on it, so a typo never gets saved.
  const missing = (boot: boolean, path: unknown, complaint: string) => {
    if (!boot || typeof path !== "string") throw invalid(complaint);
    console.warn(`${configPath}: ${complaint}, ignoring it`);
  };

  /** slot -> library path. Every value is checked against the disk, so a typo 400s. */
  const parseSlots = (value: unknown, boot = false) => {
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

  // Every tick scans the whole list and every save logs it, so keep it a list a person
  // could have typed. Only a hand-edit can exceed it at boot, which keeps the first 100.
  const MAX_SCHEDULES = 100;

  /** Reminders and Scheduled Celebrations, normalized to exactly the fields the board uses. */
  const parseSchedules = (value: unknown, boot = false): Schedule[] => {
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

  // Optional, since existing Pi configs predate the Admin Console. Checked at boot like
  // the rest, except that a hand-deleted clip still assigned somewhere only warns.
  const assigned = (slots: Record<string, string | null>) =>
    Object.fromEntries(Object.entries(slots).filter(([, path]) => path !== null)) as Record<
      string,
      string
    >;
  let soundSlots = assigned(fromConfig(() => parseSlots(config.sounds ?? {}, true)));
  let schedules = fromConfig(() => parseSchedules(config.schedules ?? [], true));

  // The Theme the board wears when nothing live overrides it. Optional: existing Pi
  // installs keep config.json across deploys, and they wore kernel before this key.
  // A POST /theme?name=<name>&permanent rewrites both this and the file.
  let defaultTheme: string = config.theme ?? "kernel";
  if (!isTheme(defaultTheme))
    throw new Error(`${configPath}: theme must name a file in public/themes/, e.g. "kernel"`);

  const now = options.now ?? Date.now;
  const isWeekday = (at: Date) => at.getDay() >= 1 && at.getDay() <= 5;
  const soundAllowed = () => {
    const at = new Date(now());
    const minute = at.getHours() * 60 + at.getMinutes();
    return (
      isWeekday(at) &&
      minute >= minutesOfDay(quietHours.soundStart, "") &&
      minute < minutesOfDay(quietHours.soundEnd, "")
    );
  };

  // The Feed: every tracked domain event from the last 24 hours, oldest first.
  const feed: { at: number; event: DomainEvent }[] = [];
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const currentFeed = () => {
    while (feed.length && now() - feed[0]!.at >= DAY_MS) feed.shift();
    // Each entry carries the timestamp it was recorded at, so a display expires it
    // by when it happened rather than when the snapshot happened to arrive.
    return feed.map(({ at, event }) => ({ ...event, at }));
  };

  // The currently open PRs: board state rather than a 24h event, so an open PR sits
  // on the board however long ago it was opened. Backfill fills it; a pr-opened adds,
  // a pr-merged or pr-closed removes.
  const openPrs: {
    repo: string;
    number: number;
    title: string;
    actor: string;
  }[] = [];

  // The event types Backfill can rediscover after a restart, so a repeat delivery of
  // one is the same event rather than a new one. Kept for a whole week (not the Feed's
  // 24h) because Backfill fetches back to the week start, so a webhook redelivered days
  // later still meets its Backfilled twin. Ambient repeats — a second comment or a
  // second changes-requested review — are genuinely new events.
  const BACKFILLED = new Set(["pr-merged", "pr-opened", "review-approved"]);
  const seen = new Set<string>();
  let seenWeek = startOfWeek(now());
  /** Forget last week's dedup keys once the week Backfill covers has moved on. */
  const rollDedupWeek = () => {
    const week = startOfWeek(now());
    if (week === seenWeek) return;
    seenWeek = week;
    seen.clear();
  };

  // Today's MVP: the Actor with the most PR merges since local midnight. Derived
  // from the Feed on read — its 24h window always contains today — so the midnight
  // reset needs no state and no timer. A tie names every contender, ordered by
  // first merge of the day (Map insertion order), and the display rotates between them.
  const todaysMvp = () => {
    const midnight = startOfDay(now());
    const counts = new Map<string, number>();
    for (const { at, event } of feed)
      // Only merges count toward the crown; "" (GitHub named nobody) can't wear it.
      if (at >= midnight && event.type === "pr-merged" && event.actor)
        counts.set(event.actor, (counts.get(event.actor) ?? 0) + 1);
    let mvp: { names: string[]; count: number } | null = null;
    for (const [name, count] of counts)
      if (!mvp || count > mvp.count) mvp = { names: [name], count };
      else if (count === mvp.count) mvp.names.push(name);
    return mvp;
  };

  /**
   * The one path into state: append to the Feed (which the MVP is read from) and
   * update the in-flight list. Webhooks and Backfill both land here (Backfill with the
   * event's real `at`), so today's MVP rebuilds from Backfill for free. Repeats of a
   * Backfillable event (same type/repo/number, this week) are dropped — that's what
   * stops a webhook duplicating what Backfill already fetched. Returns true when the
   * event was recorded, or null for a dropped repeat.
   */
  const recordEvent = (event: DomainEvent, at: number = now()): true | null => {
    // An event with no parseable timestamp (a Backfilled PR missing created_at, say)
    // would sit in the Feed forever: the expiry loop stops at the first entry it
    // cannot age out. Undateable is unshowable, so drop it.
    if (!Number.isFinite(at)) return null;
    // Display names live here, the one path into state: mutating the caller's
    // event on purpose so the broadcast that follows carries the name too. hasOwn, so
    // a login like "constructor" is not read off Object.prototype.
    const who = event.actor;
    event.actor = Object.hasOwn(names, who) ? names[who]! : who;
    rollDedupWeek(); // roll the week over before deduping
    // An approval dedups per actor: two people approving the same PR are two
    // Celebration Events, and keying by PR alone swallowed the second one for the
    // rest of the week. The other types stay keyed by PR — Backfill credits a merge
    // to the author (the list API carries no merged_by) where the webhook credits
    // the merger, so keying pr-merged by actor would let one merge through twice.
    // Keyed by login, not display name: names are live-editable, and a rename must not
    // let a redelivered approval celebrate twice.
    const perActor = event.type === "review-approved" ? `/${who}` : "";
    const key = `${event.type}/${event.repo}/${event.number}${perActor}`;
    if (BACKFILLED.has(event.type)) {
      if (seen.has(key)) return null;
      seen.add(key);
    }
    feed.push({ at, event });
    const { type, repo, number, title, actor } = event;
    const open = openPrs.findIndex(
      (pr) => pr.repo === repo && pr.number === number,
    );
    // Newest first: the display shows the head of this list, and a freshly
    // opened PR should be visible there, not buried behind "+N MORE".
    if (type === "pr-opened" && open < 0)
      openPrs.unshift({ repo, number, title, actor });
    if ((type === "pr-merged" || type === "pr-closed") && open >= 0)
      openPrs.splice(open, 1);
    return true;
  };

  // The last human to deploy to dev: board state like the MVP, not a Feed event, so
  // a newer deploy replaces it and nothing expires.
  let devDeploy: { actor: string; at: number; repo: string; run: number } | null = null;

  /**
   * A successful run of the configured deploy workflow, credited to whoever triggered
   * it. Roster-only on purpose: the question is which human put that on dev, and a run
   * triggered by a bot names no human. Returns true when it moved the state.
   */
  const recordDevDeploy = (repo: string, run: any) => {
    const actor = login(run?.triggering_actor);
    if (
      !devDeployWorkflow ||
      !trackedRepos.includes(repo) ||
      run?.path !== `.github/workflows/${devDeployWorkflow}` ||
      run?.conclusion !== "success" ||
      !Object.hasOwn(names, actor)
    )
      return false;
    const at = Date.parse(run.updated_at);
    // A redelivery or a late Backfill must not un-do a newer deploy.
    if (!Number.isFinite(at) || at <= (devDeploy?.at ?? 0)) return false;
    devDeploy = { actor: names[actor]!, at, repo, run: run.run_number };
    return true;
  };
  const describeDevDeploy = () =>
    devDeploy
      ? `in dev = ${devDeploy.actor} (${devDeploy.repo} run ${devDeploy.run}, ${new Date(devDeploy.at).toISOString()})`
      : "nobody in dev";

  // A repo without the workflow answers 404 — it just has no dev deploys to find — so
  // ask it hourly, not once a minute. Not forever: a 404 can also be a token blip or a
  // repo that gains the workflow later.
  const askAgainAt = new Map<string, number>();
  /**
   * Re-read the deploy workflow's latest successful runs for every Tracked Repo and
   * credit the newest. Backfill and the reconcile poll share this: the header is state
   * with no Feed entry to dedup against, so a lost workflow_run webhook (or a Backfill
   * that read something odd during a flaky boot) has nothing else to repair it.
   * Returns true when the state moved.
   */
  const refreshDevDeploys = async (caller: string) => {
    let moved = false;
    if (!devDeployWorkflow) return moved;
    for (const repo of trackedRepos) {
      if (now() < (askAgainAt.get(repo) ?? 0)) continue;
      try {
        const runs = await get(
          `${repo}/actions/workflows/${devDeployWorkflow}/runs?status=success&per_page=20`,
        );
        for (const run of runs.workflow_runs ?? []) if (recordDevDeploy(repo, run)) moved = true;
      } catch (error) {
        if ((error as { status?: number }).status === 404) askAgainAt.set(repo, now() + HOUR_MS);
        console.warn(`${caller} found no dev deploys in ${repo}: ${error}`);
      }
    }
    return moved;
  };

  const app = express();

  // Celebration clips for the merged takeover. Like the event sounds, the files
  // are gitignored (drop .gif/.webp into public/celebrations yourself); the
  // client asks what's there and falls back to the trophy when the answer is
  // nothing. Read per request so a drop-in needs no restart. Registered before
  // express.static, which would otherwise answer for the real directory of the
  // same name with a redirect.
  const celebrationsDir = fileURLToPath(new URL("../public/celebrations", import.meta.url));
  app.get("/celebrations", (_req, res) => {
    try {
      res.json(
        readdirSync(celebrationsDir)
          .filter((f) => /\.(gif|webp|png|apng)$/i.test(f))
          .sort(),
      );
    } catch {
      // No folder yet — an empty list is the answer, not an error.
      res.json([]);
    }
  });

  // Same-origin proxy for the kiosk. The URL comes only from config, so this cannot
  // be turned into an arbitrary fetch endpoint by a browser request.
  app.get("/news.xml", async (_req, res) => {
    if (!newsFeedUrl) {
      res.sendStatus(404);
      return;
    }
    try {
      const response = await fetch(newsFeedUrl, {
        headers: {
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        },
        signal: AbortSignal.timeout(options.newsTimeoutMs ?? 5_000),
      });
      if (!response.ok) {
        console.warn(`News feed returned ${response.status}: ${newsFeedUrl}`);
        res.sendStatus(502);
        return;
      }
      res.type("application/xml").send(await limitedText(response));
    } catch (error) {
      console.warn(`News feed unavailable: ${error}`);
      res.sendStatus(502);
    }
  });

  // The credential stays on the server and the destination is fixed: the kiosk can
  // read the five saved insights, but it cannot turn this route into a general proxy.
  let lastWau: ReturnType<typeof normalizeWauDashboard> | undefined;
  let warming = false;
  let wauAsked = 0;
  let wauApplied = 0;
  // The Theme worn now: config.theme, unless a live override still holds. Every live
  // override — a Target Hit's Arcade Theme or a POST /theme?name= — lasts until the
  // next local midnight or a DELETE /theme. Last write wins, and a ?permanent switch
  // counts as a write: it clears `live` so the new config.theme shows at once.
  // ponytail: `live` is in-memory, so a restart drops it; it only lasts the day anyway.
  let live: { name: string; until: number } | null = null;
  const theme = () => (live && now() < live.until ? live.name : defaultTheme);
  const wearUntilMidnight = (name: string) => (live = { name, until: nextMidnight(now()) });
  app.get("/wau.json", async (_req, res) => {
    const asked = ++wauAsked;
    const token = process.env.POSTHOG_PERSONAL_API_KEY;
    if (!token) {
      res.sendStatus(503);
      return;
    }
    const base = options.posthogApiBase ?? "https://us.posthog.com";
    const url = new URL(
      `/api/projects/${POSTHOG_PROJECT}/dashboards/${POSTHOG_DASHBOARD}/run_insights/`,
      base,
    );
    url.searchParams.set("tile_ids", Object.values(WAU_TILES).join(","));
    url.searchParams.set("output_format", "json");
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
    // Since the insights' queries were rewritten, a recompute often takes longer than
    // any timeout the kiosk can wait out. So answer from PostHog's cache, however old,
    // and recompute in the background so the next 15-minute poll reads fresh numbers.
    // One recompute at a time: reloads and Funnel viewers must not stack them.
    if (!warming) {
      warming = true;
      const warm = new URL(url);
      warm.searchParams.set("refresh", "blocking");
      fetch(warm, { headers, signal: AbortSignal.timeout(5 * 60_000) })
        .then((response) => response.body?.cancel())
        .catch((error) => console.warn(`WAU dashboard refresh failed: ${error}`))
        .finally(() => (warming = false));
    }
    url.searchParams.set("refresh", "force_cache");
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(options.posthogTimeoutMs ?? 15_000),
      });
      if (!response.ok) throw new Error(`PostHog returned ${response.status}`);
      const payload = await limitedText(response, "WAU dashboard response exceeds 1 MiB");
      const next = normalizeWauDashboard(JSON.parse(payload));
      // A slow read asked before the one already applied holds older cache; letting it
      // overwrite lastWau would re-arm the crossing below and celebrate twice.
      if (asked < wauApplied) {
        res.set("Cache-Control", "no-store").json(next);
        return;
      }
      wauApplied = asked;
      // Crossing only, so a restart that boots already over target stays quiet.
      // ponytail: a crossing while the server is down is missed; persist the last
      // celebrated Sat–Fri cycle if that matters.
      if (lastWau && lastWau.targetPercent < 100 && next.targetPercent >= 100) {
        const audible = soundAllowed();
        console.log(
          `WAU target hit: ${next.targetPercent}% sound=${audible ? "clip" : "silent (quiet hours)"}`,
        );
        wearUntilMidnight("arcade");
        broadcast({
          type: "wau-target-hit",
          audible,
          currentWau: next.currentWau,
          targetWau: next.targetWau,
          targetPercent: next.targetPercent,
        });
      }
      lastWau = next;
      res.set("Cache-Control", "no-store").json(lastWau);
    } catch (error) {
      console.warn(`WAU dashboard unavailable: ${error}`);
      // The cached read sometimes hangs or misses a tile; one bad read should not turn
      // the panel STALE, so serve the last good numbers under their own fetchedAt.
      if (lastWau) res.set("Cache-Control", "no-store").json(lastWau);
      else res.sendStatus(502);
    }
  });

  // Routes for whoever is on the Pi itself, e.g. curl -X POST 127.0.0.1:3000/wau-target-hit.
  // Funnel proxies from loopback too; its X-Forwarded-For is what keeps the internet out.
  // That holds for HTTP Funnel only: `funnel --tcp` adds no header and would let it through.
  const piOnly: RequestHandler = (req, res, next) => {
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress ?? "",
    );
    if (!loopback || req.headers["x-forwarded-for"] !== undefined) res.sendStatus(403);
    else next();
  };

  /**
   * Every config write — a permanent Theme, an Admin Console save — goes through here.
   * Re-read rather than reuse `config`: the operator may have edited the file since
   * boot. Write-then-rename so a crash mid-write leaves the old file whole. All sync,
   * so two writes in flight cannot interleave and lose each other's keys.
   */
  const saveConfig = (patch: Record<string, unknown>) => {
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(`${configPath}.tmp`, JSON.stringify({ ...onDisk, ...patch }, null, 2) + "\n");
    renameSync(`${configPath}.tmp`, configPath);
  };

  /** Wear `name` until local midnight, or make it config.theme for good. Throws if the save fails. */
  const setTheme = (name: string, permanent: boolean) => {
    if (permanent) {
      saveConfig({ theme: name });
      defaultTheme = name;
      // A permanent switch counts as the last write, so it beats any live override.
      live = null;
    } else wearUntilMidnight(name);
    broadcast(snapshot());
  };
  const clearTheme = () => {
    live = null;
    broadcast(snapshot());
  };

  /** Replays the Target Hit on demand, with the last WAU numbers read. */
  const replayTargetHit = () => {
    wearUntilMidnight("arcade");
    broadcast({
      type: "wau-target-hit",
      audible: soundAllowed(),
      currentWau: lastWau?.currentWau,
      targetWau: lastWau?.targetWau,
      targetPercent: lastWau?.targetPercent,
    });
  };

  app.post("/wau-target-hit", piOnly, (_req, res) => {
    replayTargetHit();
    res.sendStatus(204);
  });

  // Swaps the Theme to ?name= by hand until local midnight (or DELETE /theme). With
  // &permanent it becomes config.theme instead, written to config.json so it survives
  // restarts. A missing or repeated ?name is a 400; one naming no Theme is a 404.
  app.post("/theme", piOnly, (req, res) => {
    const name = req.query.name;
    if (typeof name !== "string") {
      res.sendStatus(400);
      return;
    }
    if (!isTheme(name)) {
      res.sendStatus(404);
      return;
    }
    try {
      setTheme(name, "permanent" in req.query);
    } catch (error) {
      console.warn(`Could not save theme to ${configPath}: ${error}`);
      res.sendStatus(500);
      return;
    }
    res.sendStatus(204);
  });
  app.delete("/theme", piOnly, (_req, res) => {
    clearTheme();
    res.sendStatus(204);
  });

  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  const http = createServer(app);
  const wss = new WebSocketServer({ server: http });

  // Display protocol (server -> client only):
  //   on connect: {"type":"snapshot","feed":[{<domain event>, "at":<ms>}, ...],
  //                "openPrs":[{repo, number, title, actor}, ...],
  //                "mvp":{"names":[<string>, ...],"count":<number>}|null,
  //                "devDeploy":{"actor":<string>,"at":<ms>,"repo":<string>,"run":<number>}|null,
  //                "theme":<string>, "sounds":{"<slot>":"sounds/<path>.mp3", ...}}
  //               feed is oldest first and holds the last 24h, each entry stamped with
  //               the server time it happened; openPrs is the current set of open PRs
  //               (state, so no 24h expiry) — what's in flight now, each with the
  //               GitHub login of its author; mvp names all Actors tied for today's
  //               lead, null until today has an event; devDeploy is the last teammate
  //               to deploy to dev, null until one has; theme names the Theme the board
  //               wears (a file in public/themes/) — config.theme, else a live override:
  //               "arcade" from a Target Hit or whatever a loopback POST /theme?name=
  //               set, until local midnight (when a fresh snapshot carries it off) or a
  //               DELETE /theme. POST /theme?name=<name>&permanent rewrites config.theme
  //               itself (the Admin Console's /api/theme does the same); sounds maps
  //               each slot (a SAMPLES key in public/audio.js) the Admin Console has
  //               assigned to a Sound Library clip, so the board plays it instead of the
  //               slot's default — an unassigned slot is absent. Each change is pushed as
  //               a fresh snapshot.
  //   live:       <domain event> = {"type":"pr-merged"|..., repo, number, title, actor}
  //               actor is the GitHub login of whoever did it (the merger for a
  //               pr-merged, the reviewer for a review, the commenter for a comment),
  //               always a string — "" when GitHub named nobody.
  //               Events that make a sound — the Celebrations plus pr-opened — carry
  //               "audible": true|false — Quiet Hours decided at delivery time — and
  //               "teammate": true|false, whether the actor's login is in the names
  //               map (the recorded clips are for teammates; an unmapped actor gets
  //               the 8-bit jingle). Every other Ambient Event is silent and carries
  //               neither flag, which is how the board knows to stay quiet.
  //   chime:      {"type":"day-chime","at":"09:00","last":false}  (weekdays, on the
  //               configured times); "last" is true on the latest configured time — the
  //               end of the workday, which moves when the Admin Console edits the times.
  //   scheduled:  {"type":"reminder"|"scheduled-celebration","text":<string>,
  //               "sound":"sounds/<path>.mp3"|null,"audible":true|false} — an Admin
  //               Console schedule reaching its minute (on its date, or on its weekdays).
  //               A Reminder is a banner; a Scheduled Celebration takes the board over.
  //               Neither joins the Feed. "sound" is the clip to play, if any, and
  //               "audible" is Quiet Hours at that minute, as for every other sound.
  //   wau target: {"type":"wau-target-hit","audible":true|false, currentWau, targetWau,
  //               targetPercent} — the WAU panel's weekly target crossing 100%: a
  //               Celebration with no PR, "audible" gated by Quiet Hours.
  //               Also sent on demand by a loopback POST /wau-target-hit, with the last read.
  // No domain event type is called "snapshot", "day-chime", "wau-target-hit", "reminder" or
  // "scheduled-celebration", so `type` tells them apart.
  const broadcast = (message: unknown) => {
    for (const client of wss.clients) client.send(JSON.stringify(message));
  };
  const snapshot = () => ({
    type: "snapshot",
    feed: currentFeed(),
    openPrs,
    mvp: todaysMvp(),
    devDeploy,
    theme: theme(),
    sounds: Object.fromEntries(
      Object.entries(soundSlots).map(([slot, path]) => [slot, `sounds/${path}`]),
    ),
  });
  wss.on("connection", (socket) => socket.send(JSON.stringify(snapshot())));

  const token = process.env.GITHUB_TOKEN;
  const apiBase = options.githubApiBase ?? "https://api.github.com";
  /** GET a list under /repos, e.g. "owner/name/pulls?state=open". */
  const get = async (path: string) => {
    const response = await fetch(`${apiBase}/repos/${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
    });
    if (!response.ok)
      throw Object.assign(new Error(`GitHub API ${response.status} for ${path}`), {
        status: response.status,
      });
    return (await response.json()) as any;
  };

  /**
   * Backfill: rebuild the Feed from the GitHub API so a fresh boot is never blank and
   * downtime leaves no gap. Fetches back to the start of the week or the last 24h,
   * whichever is further, so the dedup set knows every event a webhook might redeliver
   * from this week and the Feed gets its whole window even on a Monday morning.
   * Any failure is logged and skipped — live webhooks still work without it.
   */
  async function backfill() {
    if (!token) {
      console.warn(
        "GITHUB_TOKEN is not set: skipping Backfill, the board will fill from live webhooks only",
      );
      return;
    }
    // How far back to fetch: far enough for both windows Backfill serves. The dedup
    // set spans the week, but the Feed spans the last 24h — and early in the week the
    // week is younger than that, so a Monday-morning boot fetching only back to Monday
    // 00:00 leaves the Feed blank for everything the weekend still owes it.
    const since = Math.min(startOfWeek(now()), now() - DAY_MS);
    const entries: { at: number; event: DomainEvent }[] = [];

    const backfillRepo = async (repo: string) => {
      // PRs touched this week, whose reviews may hold this week's approvals.
      const active: any[] = [];
      for (const pr of await get(`${repo}/pulls?state=open&per_page=100`)) {
        entries.push({
          at: Date.parse(pr.created_at),
          event: {
            type: "pr-opened",
            repo,
            number: pr.number,
            title: pr.title,
            actor: login(pr.user),
          },
        });
        if (Date.parse(pr.updated_at) >= since) active.push(pr);
      }
      // Closed PRs come back newest-updated first, so we can stop at the first one
      // that predates the week.
      // ponytail: one page per repo — the ceiling is 100 closed PRs per repo per
      // week; page through only if a repo ever outruns that.
      for (const pr of await get(
        `${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      )) {
        if (Date.parse(pr.updated_at) < since) break;
        active.push(pr);
        const mergedAt = pr.merged_at ? Date.parse(pr.merged_at) : 0;
        if (mergedAt >= since)
          entries.push({
            at: mergedAt,
            event: {
              type: "pr-merged",
              repo,
              number: pr.number,
              title: pr.title,
              // The list API returns no merged_by, so the author is an honest lazy
              // stand-in for the merger.
              actor: login(pr.user),
            },
          });
      }
      // Approvals are Celebration Events, so a restart mid-morning has to refetch them
      // or they vanish from the Feed and today's MVP. One request per PR touched this
      // week; a repo that refuses the read loses its approvals, not the whole Backfill.
      for (const pr of active) {
        let reviews: any[];
        try {
          reviews = await get(`${repo}/pulls/${pr.number}/reviews`);
        } catch (error) {
          console.warn(`Backfill skipped reviews for ${repo}#${pr.number}: ${error}`);
          continue;
        }
        for (const review of reviews) {
          const at = Date.parse(review.submitted_at);
          if (review.state !== "APPROVED" || !(at >= since)) continue;
          entries.push({
            at,
            event: {
              type: "review-approved",
              repo,
              number: pr.number,
              title: pr.title,
              actor: login(review.user),
            },
          });
        }
      }
    };

    // One repo the token can't read (or that errors) loses its own history, not
    // the whole board's — the other Tracked Repos' entries still land.
    for (const repo of trackedRepos)
      await backfillRepo(repo).catch((error) =>
        console.warn(`Backfill failed for ${repo}, its history is live-only: ${error}`),
      );

    // The last dev deploy is state, not a Feed entry, so a restart has to refetch it
    // or the header sits blank until the next deploy. Say what was chosen: a stale
    // header is otherwise undiagnosable from the journal.
    if (devDeployWorkflow) {
      await refreshDevDeploys("Backfill");
      console.log(`Backfill: ${describeDevDeploy()}`);
    }

    // Oldest first, matching the Feed's order (its 24h expiry shifts off the front).
    for (const { at, event } of entries.sort((a, b) => a.at - b.at))
      recordEvent(event, at);
  }

  /**
   * GitHub does not retry a repository webhook that received a 502. Poll the cheap
   * PR lists between full Backfills so missed merges and approvals repair themselves
   * while the process stays up. Dedup makes every successful webhook win the race;
   * this path records only the misses and refreshes the board without replaying a
   * stale celebration sound.
   */
  let reconciling = false;
  async function reconcile() {
    if (!token || reconciling) return;
    reconciling = true;
    let recovered = 0;
    const since = now() - DAY_MS;
    // A lost pull_request_review delivery leaves no trace here, but submitting a
    // review bumps the PR's updated_at — so only recently-touched PRs need their
    // reviews refetched.
    // ponytail: 30-minute lookback keeps this to a couple of requests per tick; a
    // delivery lost longer ago than that waits for the next restart's Backfill.
    const reviewSince = now() - 30 * 60_000;
    try {
      for (const repo of trackedRepos) {
        let pulls: any[];
        let open: any[];
        try {
          pulls = await get(`${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`);
          open = await get(`${repo}/pulls?state=open&per_page=100`);
        } catch (error) {
          console.warn(`Reconcile failed for ${repo}: ${error}`);
          continue;
        }
        // The API returns newest-updated first. Record oldest-first so simultaneous
        // recovered merges retain their real order in the Feed.
        const merges = pulls
          .filter((pr) => pr.merged_at && Date.parse(pr.merged_at) >= since)
          .sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at));
        for (const pr of merges)
          if (
            recordEvent(
              {
                type: "pr-merged",
                repo,
                number: pr.number,
                title: pr.title,
                // The list endpoint has no merged_by. This is the same honest
                // author stand-in used by startup Backfill.
                actor: login(pr.user),
              },
              Date.parse(pr.merged_at),
            )
          )
            recovered++;
        for (const pr of [...open, ...pulls]) {
          if (!(Date.parse(pr.updated_at) >= reviewSince)) continue;
          let reviews: any[];
          try {
            reviews = await get(`${repo}/pulls/${pr.number}/reviews`);
          } catch (error) {
            console.warn(`Reconcile skipped reviews for ${repo}#${pr.number}: ${error}`);
            continue;
          }
          for (const review of reviews) {
            const at = Date.parse(review.submitted_at);
            if (review.state !== "APPROVED" || !(at >= since)) continue;
            if (
              recordEvent(
                {
                  type: "review-approved",
                  repo,
                  number: pr.number,
                  title: pr.title,
                  actor: login(review.user),
                },
                at,
              )
            )
              recovered++;
          }
        }
      }
      // The header is state, not an event, so a lost workflow_run delivery leaves no
      // PR to notice; the runs list is the only place it can be repaired from.
      // Not counted as a recovered event: In Dev is board state, not an event.
      const devMoved = await refreshDevDeploys("Reconcile");
      if (devMoved) console.log(`reconcile: ${describeDevDeploy()}`);
      if (recovered)
        console.log(`reconcile: recovered ${recovered} missed event${recovered === 1 ? "" : "s"}`);
      if (recovered || devMoved) broadcast(snapshot());
    } finally {
      reconciling = false;
    }
  }

  app.post("/webhook", express.raw({ type: "*/*", limit: "5mb" }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.sendStatus(401);
      return;
    }
    const expected = Buffer.from(
      "sha256=" + createHmac("sha256", secret).update(req.body).digest("hex"),
    );
    const given = Buffer.from(req.header("x-hub-signature-256") ?? "");
    if (
      given.length !== expected.length ||
      !timingSafeEqual(given, expected)
    ) {
      res.sendStatus(401);
      return;
    }

    const payload = JSON.parse(req.body.toString("utf8"));
    const githubEvent = req.header("x-github-event");
    const event = toDomainEvent(githubEvent, payload);
    // One line per accepted delivery saying what became of it — a 204 has four
    // different meanings, and debugging a live miss on the Pi needs to see which.
    const delivery = req.header("x-github-delivery") ?? "?";
    // A deploy is not a PR event: it carries no PR to name, so it updates the header
    // state and pushes a snapshot rather than joining the Feed.
    if (githubEvent === "workflow_run") {
      const recorded = recordDevDeploy(payload.repository?.full_name, payload.workflow_run);
      console.log(
        `webhook ${delivery}: ${recorded ? describeDevDeploy() : "ignored workflow_run"}`,
      );
      if (recorded) broadcast(snapshot());
      res.sendStatus(204);
      return;
    }
    if (!event) {
      console.log(
        `webhook ${delivery}: ignored ${req.header("x-github-event")}/${payload.action ?? "?"}`,
      );
    } else if (!trackedRepos.includes(event.repo)) {
      console.log(`webhook ${delivery}: untracked repo ${event.repo}`);
    } else {
      // Checked against the login before recordEvent swaps in the display name: the
      // map is the roster, so an unmapped login (a bot, an outside contributor) is
      // not someone we play a sample for.
      const teammate = Object.hasOwn(names, event.actor);
      // Read once: the broadcast below must not re-ask a clock that may have ticked
      // past soundEnd since this line, or the log and the board disagree.
      const audible = soundAllowed();
      // A Celebration that reaches the board silently looks exactly like one that
      // never arrived, so name which gate decided the sound.
      const sound = !SOUNDED.has(event.type)
        ? ""
        : ` sound=${!audible ? "silent (quiet hours)" : teammate ? "clip" : "jingle (actor not on the roster)"}`;
      const recorded = recordEvent(event);
      console.log(
        `webhook ${delivery}: ${recorded ? "recorded" : "repeat, dropped"} ${event.type} ${event.repo}#${event.number}${sound}`,
      );
      // null = repeat of something already recorded (e.g. Backfill got there
      // first): no state change, so nothing to tell the displays.
      if (recorded) {
        broadcast(
          SOUNDED.has(event.type)
            ? { ...event, audible, teammate }
            : event,
        );
        // Any event can change today's MVP (and an open/merged/closed also moves the
        // in-flight list), so follow every recorded one with a fresh snapshot rather
        // than inventing a second message shape for state the snapshot already carries.
        broadcast(snapshot());
      }
    }
    res.sendStatus(204);
  });

  // Everything that can fail here is a bad delivery; never let express render a stack.
  app.use(((err, _req, res, _next) => {
    res.sendStatus(err.status ?? 400);
  }) satisfies ErrorRequestHandler);

  // The Admin Console: its own app on its own port, bound to loopback, so nothing above
  // can reach it. Funnel exposes port 3000 only; this one is reached through
  // `tailscale serve`, which is tailnet-only and names the user in Tailscale-User-Login.
  const admin = express();
  const audit = (req: express.Request, action: string) =>
    console.log(`admin: ${req.header("tailscale-user-login") ?? "local"} ${action}`);
  // No CORS, but a cross-site page can still fire a simple POST (a replay, or an upload
  // with text/plain) at a tailnet user's console. The browser's own label stops it, and
  // for a browser that sends none, a write must carry a type no simple request can, so
  // the browser has to preflight it, and the preflight finds no CORS.
  // ponytail: no Host check; DNS rebinding only matters for a browser on the Pi itself,
  // and the upgrade path is a Host allowlist once tailscale serve's Host is confirmed.
  admin.use((req, res, next) => {
    const site = req.headers["sec-fetch-site"];
    if (req.method === "GET" || req.method === "HEAD") next();
    else if (site && site !== "same-origin" && site !== "none") res.sendStatus(403);
    else if ((req.method === "POST" || req.method === "PUT") && !req.is(["application/json", "audio/mpeg"]))
      res.sendStatus(415);
    else next();
  });
  admin.use(express.json());

  admin.get("/api/state", (req, res) => {
    res.json({
      // Who the console is signed in as; null when reached without `tailscale serve`.
      you: req.header("tailscale-user-login") ?? null,
      theme: {
        current: theme(),
        default: defaultTheme,
        all: readdirSync(THEMES_DIR)
          .map((file) => file.replace(/\.js$/, ""))
          .filter(isTheme)
          .sort(),
      },
      quietHours,
      chimes,
      names,
      sounds: { slots: soundSlots, library: library() },
      schedules,
    });
  });

  admin.post("/api/theme", (req, res) => {
    const { name, permanent = false } = req.body ?? {};
    if (typeof name !== "string" || typeof permanent !== "boolean") throw invalid("expected {name, permanent?}");
    if (!isTheme(name)) {
      res.status(404).json({ error: `${name} is not a Theme in public/themes/` });
      return;
    }
    setTheme(name, permanent);
    audit(req, `theme ${name}${permanent ? " permanently" : " until midnight"}`);
    res.sendStatus(204);
  });
  admin.delete("/api/theme", (req, res) => {
    clearTheme();
    audit(req, "cleared the live theme");
    res.sendStatus(204);
  });

  // Any subset of the three; each one present replaces its whole value. All are checked
  // before any is saved, so a bad field leaves the file and the board as they were.
  admin.put("/api/settings", (req, res) => {
    const body = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (body.quietHours !== undefined) patch.quietHours = parseQuietHours(body.quietHours);
    if (body.chimes !== undefined) patch.chimes = parseChimes(body.chimes);
    if (body.names !== undefined) patch.names = parseNames(body.names);
    if (!Object.keys(patch).length) throw invalid("expected some of {quietHours, chimes, names}");
    saveConfig(patch);
    quietHours = (patch.quietHours as typeof quietHours) ?? quietHours;
    chimes = (patch.chimes as string[]) ?? chimes;
    names = (patch.names as typeof names) ?? names;
    audit(req, `settings ${JSON.stringify(patch)}`);
    res.sendStatus(204);
  });

  // An upload goes in as-is and comes out of scripts/normalize-sound.py, like every
  // other clip on the board. No overwriting: a replaced clip at the same URL would play
  // stale from the kiosk's cache, so changing one is delete, then upload.
  const normalize = options.normalize ?? normalizeSound;
  // One normalization at a time: each one is a python3 holding a whole clip in memory.
  let normalizing = false;
  admin.post("/api/sounds", express.raw({ type: "audio/mpeg", limit: "10mb" }), async (req, res) => {
    const name = req.query.name;
    if (typeof name !== "string" || !SOUND_NAME.test(name))
      throw invalid(`name must be lowercase letters, digits and dashes, ending .mp3`);
    const body: unknown = req.body;
    // An ID3 tag, or an MPEG audio frame sync with a real layer (AAC's ADTS has none).
    const mp3 =
      Buffer.isBuffer(body) &&
      (body.subarray(0, 3).toString("latin1") === "ID3" ||
        (body[0] === 0xff && (body[1]! & 0xe0) === 0xe0 && (body[1]! & 0x06) !== 0));
    if (!mp3) throw invalid("not an mp3");
    const dest = join(uploadsDir, name);
    const taken = () => res.status(409).json({ error: `uploads/${name} already exists` });
    if (existsSync(dest)) return void taken();
    if (normalizing)
      return void res.status(429).json({ error: "another upload is still being normalized, try again shortly" });
    mkdirSync(uploadsDir, { recursive: true });
    // Dot-named, so the library listing (and express.static) never shows a half-written file.
    const tmp = join(uploadsDir, `.${randomUUID()}`);
    // The normalizer names the hidden temp files it was handed; the admin reading its
    // output knows the clip as what they uploaded and where it lands in the library.
    const named = (text: string) =>
      text.replaceAll(`${tmp}.in.mp3`, name).replaceAll(`${tmp}.out.mp3`, `uploads/${name}`);
    normalizing = true;
    try {
      writeFileSync(`${tmp}.in.mp3`, body);
      let output: string;
      try {
        output = named(await normalize(`${tmp}.in.mp3`, `${tmp}.out.mp3`));
      } catch (error) {
        throw Object.assign(new Error(`normalize-sound.py failed: ${named((error as Error).message)}`), {
          status: 422,
        });
      }
      // A link, not a rename: it refuses to replace a file, so two uploads of one name
      // racing through the normalizer cannot silently overwrite each other.
      try {
        linkSync(`${tmp}.out.mp3`, dest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return void taken();
        throw error;
      }
      audit(req, `uploaded uploads/${name}`);
      res.status(201).json({ path: `uploads/${name}`, output });
    } finally {
      normalizing = false;
      rmSync(`${tmp}.in.mp3`, { force: true });
      rmSync(`${tmp}.out.mp3`, { force: true });
    }
  });

  // Uploads only: the committed clips are not the console's to delete.
  admin.delete("/api/sounds/uploads/:name", (req, res) => {
    const { name } = req.params;
    if (!SOUND_NAME.test(name)) throw invalid("not a Sound Library name");
    const path = `uploads/${name}`;
    const users = [
      ...Object.keys(soundSlots).filter((slot) => soundSlots[slot] === path),
      ...schedules.filter((schedule) => schedule.sound === path).map(({ id }) => `schedule ${id}`),
    ];
    if (users.length) {
      res.status(409).json({ error: `${path} is still assigned to ${users.join(", ")}` });
      return;
    }
    if (!existsSync(join(uploadsDir, name))) {
      res.status(404).json({ error: `${path} is not in the Sound Library` });
      return;
    }
    unlinkSync(join(uploadsDir, name));
    audit(req, `deleted ${path}`);
    res.sendStatus(204);
  });

  // A patch: each slot named is assigned (a path) or put back to its default (null).
  admin.put("/api/sound-slots", (req, res) => {
    const slots = assigned({ ...soundSlots, ...parseSlots(req.body) });
    saveConfig({ sounds: slots });
    soundSlots = slots;
    audit(req, `sound slots ${JSON.stringify(req.body)}`);
    broadcast(snapshot());
    res.sendStatus(204);
  });

  // The whole list, replaced: an edit is the client changing its copy and sending it back.
  admin.put("/api/schedules", (req, res) => {
    const next = parseSchedules(req.body);
    saveConfig({ schedules: next });
    schedules = next;
    audit(req, `schedules (${next.length}) ${JSON.stringify(next)}`);
    res.sendStatus(204);
  });

  admin.post("/api/wau-target-hit", (req, res) => {
    replayTargetHit();
    audit(req, "replayed the Target Hit");
    res.sendStatus(204);
  });

  admin.use(express.static(fileURLToPath(new URL("../admin", import.meta.url))));
  // Previews for the library, uploads included; dotfiles (in-progress uploads) are ignored.
  admin.use("/sounds", express.static(soundsDir));
  admin.use(((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }) satisfies ErrorRequestHandler);
  const adminHttp = createServer(admin);

  // Listen before Backfill. A deploy or crash restart must not make GitHub's webhook
  // endpoint return 502 for the whole API crawl; displays that connect in this brief
  // window receive the completed snapshot as soon as Backfill finishes.
  await new Promise<void>((resolve) => http.listen(port, resolve));
  // A console that can't listen (its port taken, say) must not take the board and the
  // webhooks down with it.
  await new Promise<void>((resolve) =>
    adminHttp
      .once("error", (error) => {
        console.warn(`Admin Console not started: ${error.message}`);
        resolve();
      })
      .listen(options.adminPort ?? Number(process.env.ADMIN_PORT ?? 3001), "127.0.0.1", resolve),
  );
  await backfill().catch((error) =>
    console.warn(`Backfill failed, serving live events only: ${error}`),
  );
  broadcast(snapshot());

  const reconciliation = setInterval(
    () =>
      void reconcile().catch((error) =>
        console.warn(`Reconcile failed: ${error}`),
      ),
    options.reconcileMs ?? 60_000,
  );

  // Day Chime and schedule scheduler: poll the clock rather than compute a delay, so the
  // injected clock (and a Pi whose time jumps after an NTP sync) is followed rather than
  // trusted. `lastMinute` keeps each minute's chimes and schedules to one push however
  // many ticks land inside it; everything due in a minute fires together, so a Reminder
  // set for 09:00 and the 09:00 chime both go out. It only moves forward: a clock stepped
  // back stays quiet until it passes the last minute seen, rather than firing it twice,
  // and a forward jump skips the minutes in between rather than catching up.
  let lastMinute = -Infinity;
  let mvpDay = startOfDay(now());
  const scheduler = setInterval(() => {
    const at = new Date(now());
    // The MVP is derived on read, so a display connected across local midnight would
    // keep yesterday's leader until something else happened. Remembering the day we
    // last pushed is what keeps this to one broadcast rather than one per tick.
    // A live Theme ends at that same midnight; checked on its own so a clock that
    // jumps doesn't strand it, and folded into the one push so the rollover stays one.
    const liveOver = live !== null && at.getTime() >= live.until;
    if (startOfDay(at.getTime()) !== mvpDay || liveOver) {
      mvpDay = startOfDay(at.getTime());
      if (liveOver) live = null;
      broadcast(snapshot());
    }
    const hhmm = `${at.getHours()}`.padStart(2, "0") + ":" + `${at.getMinutes()}`.padStart(2, "0");
    const minute = Math.floor(at.getTime() / 60_000);
    if (minute <= lastMinute) return;
    lastMinute = minute;
    const chime = isWeekday(at) && chimes.includes(hhmm);
    const today = localDate(at);
    const due = schedules.filter(
      (schedule) =>
        schedule.time === hhmm &&
        ("date" in schedule ? schedule.date === today : schedule.days.includes(at.getDay())),
    );
    if (!chime && !due.length) return;
    // By design: a chime that lands while no display is connected is dropped, not
    // replayed later. This is a display-only board, and a stale 09:00 chime at 09:20
    // is worse than silence. The same goes for a schedule.
    // "HH:MM" sorts as text, so the latest chime is the last one sorted: the end of the
    // workday, whatever times the Admin Console has set. Always a boolean: with none,
    // the board falls back to "17:00 is the end" and a middle 17:00 would end the day.
    if (chime)
      broadcast({ type: "day-chime", at: hhmm, last: hhmm === [...chimes].sort().at(-1) });
    const audible = soundAllowed();
    for (const { kind, text, sound } of due)
      broadcast({
        type: kind === "reminder" ? "reminder" : "scheduled-celebration",
        text,
        sound: sound && `sounds/${sound}`,
        audible,
      });
  }, options.tickMs ?? 30_000);

  return {
    port: (http.address() as AddressInfo).port,
    /** Undefined when the Admin Console could not listen. */
    adminPort: (adminHttp.address() as AddressInfo | null)?.port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(scheduler);
        clearInterval(reconciliation);
        for (const client of wss.clients) client.terminate();
        adminHttp.close();
        http.close(() => resolve());
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port, adminPort } = await startServer(Number(process.env.PORT ?? 3000));
  console.log(
    `PR Arcade on http://localhost:${port}${adminPort ? `, Admin Console on http://127.0.0.1:${adminPort}` : ""}`,
  );
}
