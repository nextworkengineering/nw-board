import { startOfWeek } from "./clock.ts";

/**
 * What happened in the Tracked Repos since some moment, read back from the GitHub API
 * as domain events. Startup Backfill and the 60 s Reconcile are two schedules over this
 * one read; they differ only in how far back they look. Neither records anything —
 * the caller does, and its dedup is what lets every successful webhook win.
 */

export type DomainEvent = {
  type: string;
  repo: string;
  number: number;
  title: string;
  /** Who did it. Never undefined on the wire: an unnamed GitHub user is "". */
  actor: string;
};

/** A domain event and when GitHub says it happened. */
export type Happening = { at: number; event: DomainEvent };

/** GET a path under /repos, e.g. "owner/name/actions/runs"; throws on a non-2xx. */
export type GitHubGet = (path: string) => Promise<any>;

/** The login of whoever GitHub named, or "" when it named nobody. */
export const login = (who: any) => who?.login ?? "";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Every pr-opened, pr-merged, pr-closed and review-approved in `repos` that happened in
 * [since, until], oldest first (the Feed's order: its 24h expiry shifts off the front).
 * Reviews are fetched only for PRs updated since `reviewsSince` — submitting a review
 * bumps the PR's updated_at, so an older PR has no new approval to find. One repo whose
 * open list errors loses its own history, not the others'; a closed list that errors
 * loses only its merges and closes; one PR whose reviews error loses only its approvals.
 */
async function happened(
  get: GitHubGet,
  repos: string[],
  caller: string,
  { since, until = Infinity, reviewsSince = since }: { since: number; until?: number; reviewsSince?: number },
): Promise<Happening[]> {
  const found: Happening[] = [];
  const add = (type: string, repo: string, pr: any, actor: string, when: unknown) => {
    const at = Date.parse(when as string);
    // NaN fails both, so an undated PR is never placed in a window it can't be aged out of.
    if (at >= since && at <= until)
      found.push({ at, event: { type, repo, number: pr.number, title: pr.title, actor } });
  };

  for (const repo of repos) {
    try {
      const prs: any[] = [...(await get(`${repo}/pulls?state=open&per_page=100`))];
      let closed: any[] = [];
      try {
        // ponytail: one page per repo — the ceiling is 100 closed PRs per repo per
        // week; page through only if a repo ever outruns that.
        closed = await get(`${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`);
      } catch (error) {
        console.warn(
          `${caller} failed for ${repo}'s closed PRs, its merges and closes are live-only for now: ${error}`,
        );
      }
      // Closed PRs come back newest-updated first, so we can stop at the first one
      // that predates the window.
      for (const pr of closed) {
        if (Date.parse(pr.updated_at) < since) break;
        prs.push(pr);
      }
      for (const pr of prs) {
        add("pr-opened", repo, pr, login(pr.user), pr.created_at);
        if (pr.merged_at)
          // The list API returns no merged_by, so the author is an honest lazy
          // stand-in for the merger.
          add("pr-merged", repo, pr, login(pr.user), pr.merged_at);
        else add("pr-closed", repo, pr, login(pr.user), pr.closed_at);
      }
      // Approvals are Celebration Events, so they have to be refetched or they vanish
      // from the Feed and today's MVP. One request per recently-touched PR.
      for (const pr of prs) {
        if (!(Date.parse(pr.updated_at) >= reviewsSince)) continue;
        let reviews: any[];
        try {
          reviews = await get(`${repo}/pulls/${pr.number}/reviews`);
        } catch (error) {
          console.warn(`${caller} skipped reviews for ${repo}#${pr.number}: ${error}`);
          continue;
        }
        for (const review of reviews)
          if (review.state === "APPROVED")
            add("review-approved", repo, pr, login(review.user), review.submitted_at);
      }
    } catch (error) {
      console.warn(`${caller} failed for ${repo}, its history is live-only for now: ${error}`);
    }
  }
  // Stable, so same-instant events keep the order they were found in.
  return found.sort((a, b) => a.at - b.at);
}

/** The Tracked Repos' history over an injected GitHub GET and clock. */
export function createHistory({ get, now, repos }: { get: GitHubGet; now: () => number; repos: string[] }) {
  return {
    /**
     * Startup Backfill: back to the start of the week or the last 24h, whichever is
     * further. The dedup set spans the week, so it has to learn every event a webhook
     * might redeliver from this week; the Feed spans the last 24h — and early in the
     * week the week is younger than that, so a Monday-morning boot fetching only back
     * to Monday 00:00 leaves the Feed blank for everything the weekend still owes it.
     */
    backfill: () =>
      happened(get, repos, "Backfill", { since: Math.min(startOfWeek(now()), now() - DAY_MS) }),

    /**
     * Reconcile: the last 24h, but never before Monday 00:00 — the dedup set forgets
     * last week at that moment, so reaching back past it would re-record Sunday's
     * events as if they had been missed.
     */
    reconcile: async () => {
      const found = await happened(get, repos, "Reconcile", {
        since: Math.max(startOfWeek(now()), now() - DAY_MS),
        // A webhook a few seconds behind its event must still win, or its sound and
        // the merger's MVP credit go to a silent author-credited recovery instead.
        until: now() - 2 * MINUTE_MS,
        // ponytail: 30-minute lookback keeps this to a couple of requests per tick; a
        // delivery lost longer ago than that waits for the next restart's Backfill.
        reviewsSince: now() - 30 * MINUTE_MS,
      });
      // The same cutoff again, now: a Reconcile that set out on Sunday night and
      // lands after Monday 00:00 meets a dedup set that has just forgotten Sunday.
      const week = startOfWeek(now());
      return found.filter(({ at }) => at >= week);
    },
  };
}
