import type { DomainEvent } from "./backfill.ts";
import { nextMidnight, startOfDay, startOfWeek } from "./clock.ts";

/**
 * Board State: what a display shows that is not a passing event — the Feed, today's
 * MVP, In Dev and the Theme — plus the dedup that keeps a redelivered or Backfilled
 * event from being recorded twice. Every change is told to the `onChange` listeners,
 * which is how the displays hear about it: nobody pushes a snapshot by hand.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// The event types Backfill can rediscover after a restart, so a repeat delivery of
// one is the same event rather than a new one. Kept for a whole week (not the Feed's
// 24h) because Backfill fetches back to the week start, so a webhook redelivered days
// later still meets its Backfilled twin. Ambient repeats — a second comment or a
// second changes-requested review — are genuinely new events.
// ponytail: keyed by PR, so a PR closed, reopened and closed again in one week shows
// its first close only; key by closed_at if that ever matters.
const BACKFILLED = new Set(["pr-merged", "pr-opened", "pr-closed", "review-approved"]);

export function createBoard({
  now,
  names,
  theme,
}: {
  now: () => number;
  /** The names map, login -> first name. Asked on every record: the Admin Console edits it. */
  names: () => Record<string, string>;
  /** config.theme, worn whenever no live override holds. */
  theme: string;
}) {
  const listeners: (() => void)[] = [];
  // Inside a batch, changes are held and told once at its end.
  let batching = 0;
  let held = false;
  const changed = () => {
    if (batching) held = true;
    else for (const listener of listeners) listener();
  };

  // The Feed: every tracked domain event from the last 24 hours, oldest first.
  const feed: { at: number; event: DomainEvent }[] = [];
  const currentFeed = () => {
    while (feed.length && now() - feed[0]!.at >= DAY_MS) feed.shift();
    // Each entry carries the timestamp it was recorded at, so a display expires it
    // by when it happened rather than when the snapshot happened to arrive.
    return feed.map(({ at, event }) => ({ ...event, at }));
  };

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
  // reset needs no state of its own. A tie names every contender, ordered by first
  // merge of the day (the Feed is in time order), and the display rotates between them.
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

  // The last human to deploy to dev: board state like the MVP, not a Feed event, so
  // a newer deploy replaces it and nothing expires.
  let devDeploy: { actor: string; at: number; repo: string; run: number } | null = null;

  // The Theme worn now: config.theme, unless a live override still holds. Every live
  // override — a Target Hit's Arcade Theme or a hand-set one — lasts until the next
  // local midnight or a clear. Last write wins, and a permanent switch counts as a
  // write: it clears `live` so the new config.theme shows at once.
  // ponytail: `live` is in-memory, so a restart drops it; it only lasts the day anyway.
  let defaultTheme = theme;
  let live: { name: string; until: number } | null = null;
  const currentTheme = () => (live && now() < live.until ? live.name : defaultTheme);
  /** Takes off a live Theme whose midnight has passed; true when it did. */
  const expired = () => {
    if (!live || now() < live.until) return false;
    live = null;
    return true;
  };

  return {
    /**
     * The one path into the Feed (which the MVP is read from). Webhooks, Backfill and
     * Reconcile all land here with when the event happened, so today's MVP rebuilds
     * from Backfill for free. A repeat of a Backfillable event (same type/repo/number,
     * this week) is dropped — that is what stops a webhook duplicating what Backfill
     * already fetched. Returns the event as the board shows it, its actor's display
     * name swapped in on a copy, or null when it was not recorded. `event` is untouched.
     */
    record(event: DomainEvent, at: number): DomainEvent | null {
      // An event with no parseable timestamp (a Backfilled PR missing created_at, say)
      // would sit in the Feed forever: the expiry stops at the first entry it cannot
      // age out. Undateable is unshowable, so drop it.
      if (!Number.isFinite(at)) return null;
      rollDedupWeek(); // roll the week over before deduping
      // An approval dedups per actor: two people approving the same PR are two
      // Celebration Events, and keying by PR alone swallowed the second one for the
      // rest of the week. The other types stay keyed by PR — Backfill credits a merge
      // to the author (the list API carries no merged_by) where the webhook credits
      // the merger, so keying pr-merged by actor would let one merge through twice.
      // Keyed by login, not display name: names are live-editable, and a rename must not
      // let a redelivered approval celebrate twice.
      const perActor = event.type === "review-approved" ? `/${event.actor}` : "";
      const key = `${event.type}/${event.repo}/${event.number}${perActor}`;
      if (BACKFILLED.has(event.type)) {
        if (seen.has(key)) return null;
        seen.add(key);
      }
      // The name as it is now, kept: a later rename does not rewrite the day's Feed.
      // hasOwn, so a login like "constructor" is not read off Object.prototype.
      const roster = names();
      const shown = { ...event, actor: Object.hasOwn(roster, event.actor) ? roster[event.actor]! : event.actor };
      // In time order, however late it arrives: Reconcile recovers events up to a day
      // old, and one appended behind newer entries would hold up the expiry above,
      // which stops at the first entry still inside the 24h.
      let index = feed.length;
      while (index && feed[index - 1]!.at > at) index--;
      feed.splice(index, 0, { at, event: shown });
      changed();
      return shown;
    },

    /**
     * A successful dev deploy, credited to `login`. Roster-only on purpose: the
     * question is which human put that on dev, and a login off the names map (a bot)
     * names no human. A redelivery or a late Backfill never un-does a newer deploy.
     * Returns true when In Dev moved.
     */
    recordDeploy(login: string, at: number, repo: string, run: number) {
      const roster = names();
      if (!Object.hasOwn(roster, login) || !Number.isFinite(at) || at <= (devDeploy?.at ?? 0))
        return false;
      devDeploy = { actor: roster[login]!, at, repo, run };
      changed();
      return true;
    },

    /**
     * Wear `name` until the next local midnight, or with `permanent` make it the
     * default (the caller has saved config.theme). `silent` changes it without telling
     * the listeners: a Target Hit's takeover already tells every display it is wearing
     * the Arcade Theme, so a snapshot carrying it would only say so twice.
     */
    setTheme(name: string, { permanent = false, silent = false } = {}) {
      if (permanent) {
        defaultTheme = name;
        live = null;
      } else live = { name, until: nextMidnight(now()) };
      if (!silent) changed();
    },
    /** Back to the default Theme before midnight. */
    clearTheme() {
      live = null;
      changed();
    },
    /** The Theme worn now and the default it falls back to. */
    theme: () => ({ current: currentTheme(), default: defaultTheme }),

    /**
     * A new local day: today's MVP starts over and a live Theme comes off. The MVP is
     * derived on read, so a display connected across midnight would keep yesterday's
     * leader until something else happened; this tells it, always, once.
     */
    rollover() {
      expired();
      changed();
    },
    /** A live Theme whose midnight passed off a midnight wake (a clock that jumped) comes off. */
    expireTheme() {
      if (expired()) changed();
    },

    /** Board State as a display's snapshot carries it. */
    snapshot: () => ({ feed: currentFeed(), mvp: todaysMvp(), devDeploy, theme: currentTheme() }),

    /** Call `listener` after every change. */
    onChange(listener: () => void) {
      listeners.push(listener);
    },
    /**
     * Run `fn`, telling the listeners once at its end about everything it changed: a
     * Reconcile that recovers a dozen events pushes one snapshot, and a webhook that
     * broadcasts its event inside the batch has the snapshot follow it.
     */
    batch<T>(fn: () => T): T {
      batching++;
      try {
        return fn();
      } finally {
        if (!--batching && held) {
          held = false;
          changed();
        }
      }
    },
  };
}
