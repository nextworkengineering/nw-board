import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
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

/** "09:00" -> 540 minutes past local midnight. Anything else is a config error. */
function minutesOfDay(value: unknown, complaint: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value));
  if (!match) throw new Error(complaint);
  return Number(match[1]) * 60 + Number(match[2]);
}

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
};

/** Monday 00:00 local time of the week containing `at` — the dedup window. */
function startOfWeek(at: number) {
  const monday = new Date(at);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday.getTime();
}

/** Local midnight of the day containing `at` — today's MVP starts here. */
const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);

const NEWS_MAX_BYTES = 1024 * 1024;

async function limitedText(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > NEWS_MAX_BYTES) {
      await reader.cancel();
      throw new Error("news feed exceeds 1 MiB");
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

  // Team member names: GitHub login -> first name shown on the board. Optional;
  // an unmapped login displays as-is, so absence is a cosmetic gap, not an error.
  const names: Record<string, string> = config.names ?? {};
  for (const [key, value] of Object.entries(names))
    if (typeof value !== "string")
      throw new Error(`${configPath}: names.${key} must be a string`);

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

  // Quiet Hours: sound is allowed on weekdays between these two local times only.
  const quietHours = `${configPath}: quietHours must be {"soundStart":"HH:MM","soundEnd":"HH:MM"}`;
  const soundStart = minutesOfDay(config.quietHours?.soundStart, quietHours);
  const soundEnd = minutesOfDay(config.quietHours?.soundEnd, quietHours);
  // Day Chimes: local times, weekdays only.
  const badChimes = `${configPath}: chimes must be a list of "HH:MM"`;
  if (!Array.isArray(config.chimes)) throw new Error(badChimes);
  const chimes: string[] = config.chimes;
  for (const chime of chimes) minutesOfDay(chime, badChimes);

  const now = options.now ?? Date.now;
  const isWeekday = (at: Date) => at.getDay() >= 1 && at.getDay() <= 5;
  const soundAllowed = () => {
    const at = new Date(now());
    const minute = at.getHours() * 60 + at.getMinutes();
    return isWeekday(at) && minute >= soundStart && minute < soundEnd;
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
    // event on purpose so the broadcast that follows carries the name too.
    event.actor = names[event.actor] ?? event.actor;
    rollDedupWeek(); // roll the week over before deduping
    // An approval dedups per actor: two people approving the same PR are two
    // Celebration Events, and keying by PR alone swallowed the second one for the
    // rest of the week. The other types stay keyed by PR — Backfill credits a merge
    // to the author (the list API carries no merged_by) where the webhook credits
    // the merger, so keying pr-merged by actor would let one merge through twice.
    const perActor = event.type === "review-approved" ? `/${event.actor}` : "";
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

  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  const http = createServer(app);
  const wss = new WebSocketServer({ server: http });

  // Display protocol (server -> client only):
  //   on connect: {"type":"snapshot","feed":[{<domain event>, "at":<ms>}, ...],
  //                "openPrs":[{repo, number, title, actor}, ...],
  //                "mvp":{"names":[<string>, ...],"count":<number>}|null,
  //                "devDeploy":{"actor":<string>,"at":<ms>,"repo":<string>,"run":<number>}|null}
  //               feed is oldest first and holds the last 24h, each entry stamped with
  //               the server time it happened; openPrs is the current set of open PRs
  //               (state, so no 24h expiry) — what's in flight now, each with the
  //               GitHub login of its author; mvp names all Actors tied for today's
  //               lead, null until today has an event; devDeploy is the last teammate
  //               to deploy to dev, null until one has.
  //   live:       <domain event> = {"type":"pr-merged"|..., repo, number, title, actor}
  //               actor is the GitHub login of whoever did it (the merger for a
  //               pr-merged, the reviewer for a review, the commenter for a comment),
  //               always a string — "" when GitHub named nobody.
  //               Celebration Events carry "audible": true|false — Quiet Hours decided
  //               at delivery time — and "teammate": true|false, whether the actor's
  //               login is in the names map (the recorded clips are for teammates; an
  //               unmapped actor gets the 8-bit jingle). Ambient Events never make
  //               sound, so carry neither flag.
  //   chime:      {"type":"day-chime","at":"09:00"}  (weekdays, on the configured times)
  // No domain event type is called "snapshot" or "day-chime", so `type` tells them apart.
  const broadcast = (message: unknown) => {
    for (const client of wss.clients) client.send(JSON.stringify(message));
  };
  const snapshot = () => ({
    type: "snapshot",
    feed: currentFeed(),
    openPrs,
    mvp: todaysMvp(),
    devDeploy,
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
      const sound = !CELEBRATIONS.has(event.type)
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
          CELEBRATIONS.has(event.type)
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

  // Listen before Backfill. A deploy or crash restart must not make GitHub's webhook
  // endpoint return 502 for the whole API crawl; displays that connect in this brief
  // window receive the completed snapshot as soon as Backfill finishes.
  await new Promise<void>((resolve) => http.listen(port, resolve));
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

  // Day Chime scheduler: poll the clock rather than compute a delay, so the injected
  // clock (and a Pi whose time jumps after an NTP sync) is followed rather than trusted.
  // `fired` keeps a chime to one per minute however many ticks land inside it.
  let fired = "";
  let mvpDay = startOfDay(now());
  const scheduler = setInterval(() => {
    const at = new Date(now());
    // The MVP is derived on read, so a display connected across local midnight would
    // keep yesterday's leader until something else happened. Remembering the day we
    // last pushed is what keeps this to one broadcast rather than one per tick.
    if (startOfDay(at.getTime()) !== mvpDay) {
      mvpDay = startOfDay(at.getTime());
      broadcast(snapshot());
    }
    const hhmm = `${at.getHours()}`.padStart(2, "0") + ":" + `${at.getMinutes()}`.padStart(2, "0");
    const minute = `${at.toDateString()} ${hhmm}`;
    if (fired === minute || !isWeekday(at) || !chimes.includes(hhmm)) return;
    fired = minute;
    // By design: a chime that lands while no display is connected is dropped, not
    // replayed later. This is a display-only board, and a stale 09:00 chime at 09:20
    // is worse than silence.
    broadcast({ type: "day-chime", at: hhmm });
  }, options.tickMs ?? 30_000);

  return {
    port: (http.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(scheduler);
        clearInterval(reconciliation);
        for (const client of wss.clients) client.terminate();
        http.close(() => resolve());
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.env.PORT ?? 3000));
  console.log(`PR Arcade on http://localhost:${port}`);
}
