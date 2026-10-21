import { execFile } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
import { createHistory, login, type DomainEvent, type Happening } from "./backfill.ts";
import { createBoard } from "./board.ts";
import { cycleDay } from "./clock.ts";
import { createMonitor, type Reading } from "./monitor.ts";
import { createScheduler, dueAt } from "./scheduler.ts";
import { createSettings, invalid, isTheme, minutesOfDay, THEMES_DIR } from "./settings.ts";
import { statusReader, type ServiceStatus } from "./status.ts";
import { limitedText } from "./upstream.ts";
import { wauPayload, wauReader } from "./wau.ts";

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

/** A Sound Library file name. The pattern is also what keeps a name inside its directory. */
const SOUND_NAME = /^[a-z0-9-]+\.mp3$/;

type Options = {
  /** Path to the JSON config holding the Tracked Repo list. */
  configPath?: string;
  now?: () => number;
  /** Root of the GitHub REST API; tests point this at a stub. */
  githubApiBase?: string;
  /** How often to reconcile merges whose webhook could not reach the board. */
  reconcileMs?: number;
  /** How long the news-feed proxy waits for its configured upstream. */
  newsTimeoutMs?: number;
  /** Root of the PostHog API; tests point this at a stub. */
  posthogApiBase?: string;
  /** How long each PostHog query or tile read waits. */
  posthogTimeoutMs?: number;
  /** How often WUU is read; tests shorten it. */
  wauIntervalMs?: number;
  /** The upstream status pages; tests point these at stubs. */
  statusUrls?: { github?: string; sentry?: string; gcp?: string };
  /** How long a Service Status read waits for each status page. */
  statusTimeoutMs?: number;
  /** How often Service Status is read; tests shorten it. */
  statusIntervalMs?: number;
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

  // The dev deploy workflow, as its file name (e.g. "env-dev.yaml"). Optional: with
  // no workflow configured the board simply never names a dev deployer.
  const devDeployWorkflow: string | undefined = config.devDeployWorkflow;
  if (devDeployWorkflow !== undefined && typeof devDeployWorkflow !== "string")
    throw new Error(
      `${configPath}: devDeployWorkflow must be a workflow file name, e.g. "env-dev.yaml"`,
    );

  // Review Queue reviewers: the GitHub logins whose requested reviews the board lists.
  // Optional and boot-only (the Admin Console does not edit it); none means no queue.
  const reviewers: string[] = config.reviewers ?? [];
  if (!Array.isArray(reviewers) || reviewers.some((reviewer) => typeof reviewer !== "string"))
    throw new Error(`${configPath}: reviewers must be a list of GitHub logins`);

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

  // Theme, Quiet Hours, Day Chimes, names, sound slots and schedules: checked here at
  // boot and on every Admin Console write by the same Settings Store, which is also the
  // only writer of config.json. Each write is told to Board State, which pushes a
  // fresh snapshot; a permanent Theme is the new default, worn at once.
  const settings = createSettings({
    configPath,
    config,
    inLibrary,
    onApply: ({ theme }) =>
      theme !== undefined ? board.setTheme(theme, { permanent: true }) : board.settingsChanged(),
  });

  const now = options.now ?? Date.now;
  const isWeekday = (at: Date) => at.getDay() >= 1 && at.getDay() <= 5;
  const soundAllowed = () => {
    const at = new Date(now());
    const minute = at.getHours() * 60 + at.getMinutes();
    return (
      isWeekday(at) &&
      minute >= minutesOfDay(settings.current().quietHours.soundStart, "") &&
      minute < minutesOfDay(settings.current().quietHours.soundEnd, "")
    );
  };

  // Board State: the Feed, today's MVP, In Dev and the Theme. Displays hear of every
  // change through its onChange, wired to the one snapshot push below.
  const board = createBoard({
    now,
    names: () => settings.current().names,
    theme: settings.current().theme,
  });
  const HOUR_MS = 60 * 60 * 1000;

  /**
   * A successful run of the configured deploy workflow, credited to whoever triggered
   * it (Board State keeps it roster-only). Returns true when it moved In Dev.
   */
  const recordDevDeploy = (repo: string, run: any) =>
    !!devDeployWorkflow &&
    trackedRepos.includes(repo) &&
    run?.path === `.github/workflows/${devDeployWorkflow}` &&
    run?.conclusion === "success" &&
    board.recordDeploy(login(run.triggering_actor), Date.parse(run.updated_at), repo, run.run_number);
  const describeDevDeploy = () => {
    const { devDeploy } = board.snapshot();
    return devDeploy
      ? `in dev = ${devDeploy.actor} (${devDeploy.repo} run ${devDeploy.run}, ${new Date(devDeploy.at).toISOString()})`
      : "nobody in dev";
  };

  // A repo without the workflow answers 404 — it just has no dev deploys to find — so
  // ask it hourly, not once a minute. Not forever: a 404 can also be a token blip or a
  // repo that gains the workflow later.
  const askAgainAt = new Map<string, number>();
  /**
   * Re-read the deploy workflow's latest successful runs for every Tracked Repo.
   * Backfill and the reconcile poll share this: the header is state with no Feed entry
   * to dedup against, so a lost workflow_run webhook (or a Backfill that read something
   * odd during a flaky boot) has nothing else to repair it. Only read here; `recordFound`
   * credits the newest.
   */
  const devDeployRuns = async (caller: string) => {
    const found: { repo: string; run: any }[] = [];
    if (!devDeployWorkflow) return found;
    for (const repo of trackedRepos) {
      if (now() < (askAgainAt.get(repo) ?? 0)) continue;
      try {
        const runs = await get(
          `${repo}/actions/workflows/${devDeployWorkflow}/runs?status=success&per_page=20`,
        );
        for (const run of runs.workflow_runs ?? []) found.push({ repo, run });
      } catch (error) {
        if ((error as { status?: number }).status === 404) askAgainAt.set(repo, now() + HOUR_MS);
        console.warn(`${caller} found no dev deploys in ${repo}: ${error}`);
      }
    }
    return found;
  };

  /**
   * Record what a Backfill or Reconcile read, in one batch so the displays get one
   * snapshot for all of it. Returns how many events were new and whether In Dev moved.
   * `queueBefore` is the Review Queue (as JSON) from before the read: one that moved
   * with nothing else is pushed too.
   */
  const recordFound = (
    happenings: Happening[],
    runs: { repo: string; run: any }[],
    queueBefore: string,
  ) => {
    const found = board.batch(() => {
      let recovered = 0;
      let devMoved = false;
      for (const { at, event } of happenings) if (board.record(event, at)) recovered++;
      for (const { repo, run } of runs) if (recordDevDeploy(repo, run)) devMoved = true;
      return { recovered, devMoved };
    });
    // Either of those already pushed a snapshot, which carries the queue.
    if (!found.recovered && !found.devMoved && JSON.stringify(reviewQueue()) !== queueBefore)
      pushSnapshot();
    return found;
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

  // Service Status as the displays were last told it, for curl through the Funnel. Never
  // an upstream call per request: the Monitor below reads the status pages once a minute.
  app.get("/status.json", (_req, res) => {
    const body = statusBody();
    if (body) res.set("Cache-Control", "no-store").json(body);
    else res.sendStatus(502); // no reading yet
  });

  // WUU as the displays were last told it, for curl through the Funnel. Never a PostHog
  // call per request: the Monitor below reads it once a minute. No credential, no panel.
  app.get("/wau.json", (_req, res) => {
    const body = wauPayload(wauMonitor?.current());
    if (!wauMonitor) res.sendStatus(503);
    else if (body) res.set("Cache-Control", "no-store").json(body);
    else res.sendStatus(502); // no reading yet
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

  /** Wear `name` until local midnight, or make it config.theme for good. Throws if the save fails. */
  const setTheme = (name: string, permanent: boolean) => {
    if (permanent) settings.patch({ theme: name });
    else board.setTheme(name);
  };

  /** Replays the Target Hit on demand, with today's row from the last WUU reading. */
  const replayTargetHit = () => {
    board.setTheme("arcade", { silent: true });
    const row = wauMonitor?.current()?.value.daily[cycleDay(now())];
    broadcast({
      type: "wau-target-hit",
      audible: soundAllowed(),
      label: row?.label,
      current: row?.current,
      previous: row?.previous,
    });
  };

  app.post("/wau-target-hit", piOnly, (_req, res) => {
    replayTargetHit();
    res.sendStatus(204);
  });

  // The ?fps overlay's pacing line, posted by the kiosk every 5s so it can be read
  // with journalctl instead of off the TV.
  app.post("/fps", piOnly, express.text({ limit: "1kb" }), (req, res) => {
    console.log(`fps: ${String(req.body).slice(0, 200)}`);
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
    board.clearTheme();
    res.sendStatus(204);
  });

  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  const http = createServer(app);
  const wss = new WebSocketServer({ server: http });

  // Display protocol (server -> client only):
  //   on connect: {"type":"snapshot","feed":[{<domain event>, "at":<ms>}, ...],
  //                "mvp":{"names":[<string>, ...],"count":<number>}|null,
  //                "devDeploy":{"actor":<string>,"at":<ms>,"repo":<string>,"run":<number>}|null,
  //                "theme":<string>, "sounds":{"<slot>":"sounds/<path>.mp3", ...},
  //                "status":<Service Status>|null, "wau":<WUU>|null,
  //                "reviewQueue":[{"reviewer":<string>,"prs":[<number>, ...]}, ...]|null}
  //               feed is oldest first and holds the last 24h, each entry stamped with
  //               the server time it happened; mvp names all Actors tied for today's
  //               lead, null until today has an event; devDeploy is the last teammate
  //               to deploy to dev, null until one has; theme names the Theme the board
  //               wears (a file in public/themes/) — config.theme, else a live override:
  //               "arcade" from a Target Hit or whatever a loopback POST /theme?name=
  //               set, until local midnight (when a fresh snapshot carries it off) or a
  //               DELETE /theme. POST /theme?name=<name>&permanent rewrites config.theme
  //               itself (the Admin Console's /api/theme does the same); sounds maps
  //               each slot (a SAMPLES key in public/audio.js) the Admin Console has
  //               assigned to a Sound Library clip, so the board plays it instead of the
  //               slot's default — an unassigned slot is absent; status and wau are
  //               the last Service Status and WUU readings, each null until its first
  //               read lands (wau stays null without a PostHog credential), as below;
  //               reviewQueue has one entry per configured reviewer, in config order and
  //               even when it is empty, naming the open PRs (numbers ascending, across
  //               every Tracked Repo) that ask that reviewer for a review — reviewer is
  //               the display name, else the login; null until the first open-PR read
  //               lands. Each change is pushed as a fresh snapshot.
  //   live:       <domain event> = {"type":"pr-merged"|..., repo, number, title, actor}
  //               actor is the display name of whoever did it (the merger for a
  //               pr-merged, the reviewer for a review, the commenter for a comment):
  //               the names map's first name for their GitHub login, the login as-is
  //               when it has no mapping. Always a string — "" when GitHub named nobody.
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
  //   wuu target: {"type":"wau-target-hit","audible":true|false, label, current, previous}
  //               — today's new WUU (its daily row) beating the same weekday last week,
  //               judged on each WUU reading whether or not a display is connected, at
  //               most once a local day: a Celebration with no PR, "audible" gated by
  //               Quiet Hours. Also sent on demand by a loopback POST
  //               /wau-target-hit, with today's row from the last reading.
  //   status:     {"type":"status","status":<Service Status>} where <Service Status> =
  //               {"fetchedAt":<ISO>,"services":[{"name":"GITHUB"|"SENTRY"|"GCP",
  //               "level":"ok"|"minor"|"major"|"unknown","text":<string>}, ...],
  //               "stale":true|false} — the status pages read once a minute, pushed only
  //               when a row or "stale" changes. fetchedAt is the last good read; stale
  //               turns true once that is over ten minutes old (reads failing, or held by a 429).
  //               GET /status.json serves the same body.
  //   wau:        {"type":"wau","wau":<WUU>} where <WUU> = {"fetchedAt":<ISO>,
  //               "currentWau":<n>,"targetWau":<n>,"targetPercent":<n>,
  //               "activationPercent":<n>,"daily":[{"day":1..7,"label":"Saturday"…"Friday",
  //               "current":<n>,"previous":<n>}, ...7, Saturday first],"today":0..6,
  //               "onTarget":"on"|"behind"|"far-behind","stale":true|false} — PostHog read
  //               once a minute on US Central days, pushed only when a number, today,
  //               onTarget or "stale" changes; fetchedAt as for status, stale after thirty minutes.
  //               current/previous are each day's new WUU this week / last week; today
  //               indexes daily. GET /wau.json serves the same body (503 without a
  //               PostHog credential, 502 before the first reading).
  // No domain event type is called "snapshot", "day-chime", "wau-target-hit", "reminder",
  // "scheduled-celebration", "status" or "wau", so `type` tells them apart.
  // Review Queue: each Tracked Repo's requested reviews from its last good open-PR read,
  // so a repo whose read fails keeps what it last showed. Logins are kept and named
  // on read, because names are live-editable.
  // ponytail: poll-only, so a new or withdrawn request shows up to reconcileMs late;
  // review_requested webhooks are ignored. Handle them if that lag ever matters.
  const reviewRequests = new Map<string, { login: string; number: number }[]>();
  const noteReviewRequests = (repo: string, open: any[]) =>
    reviewRequests.set(
      repo,
      open.flatMap((pr) =>
        (pr.requested_reviewers ?? []).map((who: any) => ({ login: login(who), number: pr.number })),
      ),
    );
  const reviewQueue = () => {
    // Nothing read yet (booting, or no GITHUB_TOKEN) is unknown, not ALL CLEAR.
    if (!reviewRequests.size) return null;
    const requests = [...reviewRequests.values()].flat();
    const names = settings.current().names;
    return reviewers.map((reviewer) => ({
      reviewer: Object.hasOwn(names, reviewer) ? names[reviewer]! : reviewer,
      prs: [...new Set(requests.filter((r) => r.login === reviewer).map((r) => r.number))].sort(
        (a, b) => a - b,
      ),
    }));
  };
  const broadcast = (message: unknown) => {
    for (const client of wss.clients) client.send(JSON.stringify(message));
  };
  const snapshot = () => ({
    type: "snapshot",
    ...board.snapshot(),
    sounds: Object.fromEntries(
      Object.entries(settings.current().sounds).map(([slot, path]) => [slot, `sounds/${path}`]),
    ),
    status: statusBody(),
    wau: wauPayload(wauMonitor?.current()),
    reviewQueue: reviewQueue(),
  });
  wss.on("connection", (socket) => socket.send(JSON.stringify(snapshot())));
  // The one snapshot push: whatever changed, the displays get the whole board again.
  const pushSnapshot = () => broadcast(snapshot());
  board.onChange(pushSnapshot);

  // Service Status, read here rather than by each display: one set of upstream calls a
  // minute however many screens (and Funnel curls) are watching, pushed on change.
  const statusMonitor = createMonitor({
    name: "Service Status",
    read: statusReader({ urls: options.statusUrls, timeoutMs: options.statusTimeoutMs }),
    intervalMs: options.statusIntervalMs ?? 60_000,
    // A status page that misses a few reads is not news; ten minutes without one is.
    staleAfterMs: 10 * 60_000,
    now,
    onChange: (reading) => broadcast({ type: "status", status: statusBody(reading) }),
  });
  /** What the push, the snapshot and /status.json carry: the reading, flattened; null before the first. */
  function statusBody(reading: Reading<ServiceStatus> | undefined = statusMonitor.current()) {
    return reading ? { fetchedAt: reading.fetchedAt, ...reading.value, stale: reading.stale } : null;
  }

  // WUU, likewise read here once a minute for every display. The Target Hit is judged on
  // each reading, so it fires (and the board puts the Arcade Theme on) with no display
  // connected. The credential stays on the server and every destination is fixed.
  const posthogToken = process.env.POSTHOG_PERSONAL_API_KEY;
  const wauMonitor = posthogToken
    ? createMonitor({
        name: "WUU",
        read: wauReader({
          token: posthogToken,
          base: options.posthogApiBase,
          timeoutMs: options.posthogTimeoutMs,
          now,
          onTargetHit: ({ label, current, previous }) => {
            const audible = soundAllowed();
            console.log(
              `WUU daily beat: ${label} ${current} > ${previous} sound=${audible ? "clip" : "silent (quiet hours)"}`,
            );
            // Silently: the takeover below tells every display about the Arcade Theme.
            board.setTheme("arcade", { silent: true });
            broadcast({ type: "wau-target-hit", audible, label, current, previous });
          },
        }),
        intervalMs: options.wauIntervalMs ?? 60_000,
        // PostHog sometimes queues a query past the timeout, so a few reads in a row can
        // fail on a healthy day. STALE means half an hour without a good one, as before #48.
        staleAfterMs: 30 * 60_000,
        now,
        onChange: (reading) => broadcast({ type: "wau", wau: wauPayload(reading) }),
      })
    : undefined;

  const token = process.env.GITHUB_TOKEN;
  const apiBase = options.githubApiBase ?? "https://api.github.com";
  /** GET a path under /repos, e.g. "owner/name/actions/runs". */
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

  const history = createHistory({ get, now, repos: trackedRepos, onOpen: noteReviewRequests });

  /**
   * Backfill: rebuild the Feed from the GitHub API so a fresh boot is never blank and
   * downtime leaves no gap. Reaches back far enough that the dedup set knows every
   * event a webhook might redeliver from this week (see createHistory).
   * Any failure is logged and skipped — live webhooks still work without it.
   */
  async function backfill() {
    if (!token) {
      console.warn(
        "GITHUB_TOKEN is not set: skipping Backfill, the board will fill from live webhooks only",
      );
      return;
    }
    const queueBefore = JSON.stringify(reviewQueue());
    const entries = await history.backfill();
    // The last dev deploy is state, not a Feed entry, so a restart has to refetch it
    // or the header sits blank until the next deploy.
    const runs = await devDeployRuns("Backfill");
    recordFound(entries, runs, queueBefore);
    // Say what was chosen: a stale header is otherwise undiagnosable from the journal.
    if (devDeployWorkflow) console.log(`Backfill: ${describeDevDeploy()}`);
  }

  /**
   * GitHub does not retry a repository webhook that received a 502. Re-read the same
   * history Backfill does, over the last 24h, between full Backfills so missed
   * openings, merges, closes and approvals repair themselves while the process stays
   * up. Dedup makes every successful webhook win the race; this path records only the
   * misses and refreshes the board without replaying a stale sound or takeover.
   */
  let reconciling = false;
  async function reconcile() {
    if (!token || reconciling) return;
    reconciling = true;
    try {
      const queueBefore = JSON.stringify(reviewQueue());
      const happenings = await history.reconcile();
      // The header is state, not an event, so a lost workflow_run delivery leaves no
      // PR to notice; the runs list is the only place it can be repaired from.
      // Not counted as a recovered event: In Dev is board state, not an event.
      const { recovered, devMoved } = recordFound(
        happenings,
        await devDeployRuns("Reconcile"),
        queueBefore,
      );
      if (devMoved) console.log(`reconcile: ${describeDevDeploy()}`);
      if (recovered)
        console.log(`reconcile: recovered ${recovered} missed event${recovered === 1 ? "" : "s"}`);
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
    // state (and the displays with it) rather than joining the Feed.
    if (githubEvent === "workflow_run") {
      const recorded = recordDevDeploy(payload.repository?.full_name, payload.workflow_run);
      console.log(
        `webhook ${delivery}: ${recorded ? describeDevDeploy() : "ignored workflow_run"}`,
      );
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
      // Checked against the login, not the display name the board shows: the map is
      // the roster, so an unmapped login (a bot, an outside contributor) is not
      // someone we play a sample for.
      const teammate = Object.hasOwn(settings.current().names, event.actor);
      // Read once: the broadcast below must not re-ask a clock that may have ticked
      // past soundEnd since this line, or the log and the board disagree.
      const audible = soundAllowed();
      // A Celebration that reaches the board silently looks exactly like one that
      // never arrived, so name which gate decided the sound.
      const sound = !SOUNDED.has(event.type)
        ? ""
        : ` sound=${!audible ? "silent (quiet hours)" : teammate ? "clip" : "jingle (actor not on the roster)"}`;
      // Any event can change today's MVP, so every recorded one is followed by a fresh
      // snapshot rather than a second message shape for state the snapshot already
      // carries. Batched, so that snapshot goes out after the event itself.
      board.batch(() => {
        const shown = board.record(event, now());
        console.log(
          `webhook ${delivery}: ${shown ? "recorded" : "repeat, dropped"} ${event.type} ${event.repo}#${event.number}${sound}`,
        );
        // null = repeat of something already recorded (e.g. Backfill got there
        // first): no state change, so nothing to tell the displays.
        if (shown) broadcast(SOUNDED.has(event.type) ? { ...shown, audible, teammate } : shown);
      });
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
        ...board.theme(),
        all: readdirSync(THEMES_DIR)
          .map((file) => file.replace(/\.js$/, ""))
          .filter(isTheme)
          .sort(),
      },
      quietHours: settings.current().quietHours,
      chimes: settings.current().chimes,
      names: settings.current().names,
      sounds: { slots: settings.current().sounds, library: library() },
      schedules: settings.current().schedules,
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
    board.clearTheme();
    audit(req, "cleared the live theme");
    res.sendStatus(204);
  });

  // Any subset of the three; each one present replaces its whole value. All are checked
  // before any is saved, so a bad field leaves the file and the board as they were.
  admin.put("/api/settings", (req, res) => {
    const { quietHours, chimes, names } = req.body ?? {};
    const patch = Object.fromEntries(
      Object.entries({ quietHours, chimes, names }).filter(([, value]) => value !== undefined),
    );
    if (!Object.keys(patch).length) throw invalid("expected some of {quietHours, chimes, names}");
    // Logged as saved, normalized: what config.json now says.
    audit(req, `settings ${JSON.stringify(settings.patch(patch))}`);
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
    const { sounds, schedules } = settings.current();
    const users = [
      ...Object.keys(sounds).filter((slot) => sounds[slot] === path),
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
    settings.patch({ sounds: req.body });
    audit(req, `sound slots ${JSON.stringify(req.body)}`);
    res.sendStatus(204);
  });

  // The whole list, replaced: an edit is the client changing its copy and sending it back.
  admin.put("/api/schedules", (req, res) => {
    settings.patch({ schedules: req.body });
    const { schedules } = settings.current();
    audit(req, `schedules (${schedules.length}) ${JSON.stringify(schedules)}`);
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
  // window receive the completed snapshot as soon as Backfill records it, and the first
  // Service Status and WUU readings as their own pushes. Every interface unless
  // LISTEN_HOST names one (the tests pin 127.0.0.1; see test/helpers.ts).
  await new Promise<void>((resolve) => http.listen(port, process.env.LISTEN_HOST, resolve));
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
  // Day Chimes, Reminders and Scheduled Celebrations go out on the minute they are due.
  // By design: one that lands while no display is connected is dropped, not replayed
  // later. This is a display-only board, and a stale 09:00 chime at 09:20 is worse
  // than silence.
  // Local midnight rolls Board State over (today's MVP, a live Theme) in one push. A
  // live Theme is also checked each minute on its own so a clock that jumps doesn't strand it.
  // Started before the boot reads below, which can take most of a minute: a restart
  // just before 09:00 must still ring the 09:00 chime.
  const scheduler = createScheduler({
    now,
    onMidnight: () => board.rollover(),
    onMinute: (at) => {
      board.expireTheme();
      const { chimes, schedules } = settings.current();
      const { chime, schedules: due } = dueAt(at, chimes, schedules);
      if (chime) broadcast({ type: "day-chime", ...chime });
      if (!due.length) return;
      const audible = soundAllowed();
      for (const { kind, text, sound } of due)
        broadcast({
          type: kind === "reminder" ? "reminder" : "scheduled-celebration",
          text,
          sound: sound && `sounds/${sound}`,
          audible,
        });
    },
  });

  // The first Service Status and WUU reads started with their Monitors; wait for them
  // alongside Backfill so /status.json and /wau.json have them once startServer resolves.
  await Promise.all([
    backfill().catch((error) =>
      console.warn(`Backfill failed, serving live events only: ${error}`),
    ),
    statusMonitor.current() ?? statusMonitor.refresh(),
    wauMonitor && (wauMonitor.current() ?? wauMonitor.refresh()),
  ]);

  const reconciliation = setInterval(
    () =>
      void reconcile().catch((error) =>
        console.warn(`Reconcile failed: ${error}`),
      ),
    options.reconcileMs ?? 60_000,
  );

  return {
    port: (http.address() as AddressInfo).port,
    /** Undefined when the Admin Console could not listen. */
    adminPort: (adminHttp.address() as AddressInfo | null)?.port,
    close: () =>
      new Promise<void>((resolve) => {
        scheduler.stop();
        clearInterval(reconciliation);
        statusMonitor.stop();
        wauMonitor?.stop();
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
