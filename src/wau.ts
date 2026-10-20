import { cycleDay, dayKey, nextMidnight, startOfDay } from "./clock.ts";
import type { Reading } from "./monitor.ts";
import { limitedText, retryAfterMs } from "./upstream.ts";

/**
 * WUU: the WUU panel's numbers, one read of PostHog for a Monitor to run once a minute,
 * with today's Target Hit and the On Target light judged on each reading. A day is a US
 * Central day on both ends: the queries count in America/Chicago, and the Pi's clock
 * (src/clock.ts, Pi local time) picks today's row.
 */

const PROJECT = 196853;
const DASHBOARD = 1468050;
// Dashboard tile ids, not insight ids. The target is a constant SELECT, so it costs
// nothing to read; the activation rate is PostHog's slow query, read from its cache.
const TARGET_TILE = 7119740;
const ACTIVATION_TILE = 10992630;
const HOUR_MS = 60 * 60 * 1000;

/** Row labels, indexed like the queries and `cycleDay`: Saturday=0 … Friday=6. */
export const DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/**
 * One row of 8 counts: new persons per Central day of a Sat–Fri week (each person
 * counted on the day of their first pageview), then the week's distinct persons. One
 * row rather than a GROUP BY day, so a day with nobody new is a 0 and not a gap.
 * `event` sits in the same WHERE as the bot check, so ClickHouse prunes on its sort
 * key and reads the week's pageviews, not every event of the week.
 */
const perDay = (since: string, until: string, extra = "") => `WITH
  toStartOfDay(toTimeZone(now(), 'America/Chicago')) AS today_ct,
  today_ct - toIntervalDay((toDayOfWeek(today_ct) + 1) % 7) AS week_start${extra}
SELECT
  countIf(day = 0) AS sat,
  countIf(day = 1) AS sun,
  countIf(day = 2) AS mon,
  countIf(day = 3) AS tue,
  countIf(day = 4) AS wed,
  countIf(day = 5) AS thu,
  countIf(day = 6) AS fri,
  count() AS total
FROM (
  SELECT (toDayOfWeek(toTimeZone(min(timestamp), 'America/Chicago')) + 1) % 7 AS day
  FROM events
  WHERE event = '$pageview'
    AND timestamp >= ${since}
    AND timestamp ${until}
    AND NOT coalesce(properties.$virt_is_bot, false)
  GROUP BY person_id
)`;
/** This week so far: read every minute. */
export const LIVE_QUERY = perDay("week_start", "<= now()");
/** Last week, whole: read once per Central day. */
export const LAST_WEEK_QUERY = perDay(
  "last_week_start",
  "< week_start",
  ",\n  week_start - toIntervalDay(7) AS last_week_start",
);

export type OnTarget = "on" | "behind" | "far-behind";
export type WauRow = { day: number; label: string; current: number; previous: number };
export type Wau = {
  currentWau: number;
  targetWau: number;
  targetPercent: number;
  activationPercent: number;
  daily: WauRow[];
  /** Index of today's row (Saturday=0 … Friday=6). */
  today: number;
  onTarget: OnTarget;
};

/**
 * On pace for the weekly target at `at`? The pace is flat, target ÷ 168 an hour since
 * Saturday midnight local, computed as days into the Sat–Fri cycle ÷ 7 so a DST week's
 * 167 or 169 hours is ignored: the week-to-date WUU should be target × elapsed / 7.
 * Green from 90% of that, yellow from 70%, red below.
 * ponytail: just after Saturday midnight `expected` is tiny, so the light swings on a
 * handful of users (or ingestion lag); add a grace window if anyone watches then.
 */
export function onTarget(currentWau: number, targetWau: number, at: number): OnTarget {
  const day = startOfDay(at);
  const elapsed = cycleDay(at) + (at - day) / (nextMidnight(at) - day);
  const expected = (targetWau * elapsed) / 7;
  if (expected <= 0) return "on";
  const ratio = currentWau / expected;
  return ratio >= 0.9 ? "on" : ratio >= 0.7 ? "behind" : "far-behind";
}

/**
 * The panel's value from one read, judged at `at`. `live` and `lastWeek` are the
 * queries' rows. The daily target and % of target the dashboard tiles compute from
 * the one target number are computed here from it the same way.
 */
export function toWau(
  { live, lastWeek, target, activation }: { live: number[]; lastWeek: number[]; target: number; activation: number },
  at: number,
): Wau {
  const currentWau = live[7];
  return {
    currentWau,
    targetWau: target,
    // Tile 7122309's round(wau * 100.0 / target, 1).
    targetPercent: target > 0 ? Math.round((currentWau * 1000) / target) / 10 : 0,
    activationPercent: activation,
    daily: DAYS.map((label, day) => ({
      day: day + 1,
      label,
      current: live[day],
      previous: lastWeek[day],
    })),
    today: cycleDay(at),
    onTarget: onTarget(currentWau, target, at),
  };
}

/** What a push, the snapshot and /wau.json carry: the reading, flattened; null before the first. */
export const wauPayload = (reading: Reading<Wau> | undefined) =>
  reading ? { fetchedAt: reading.fetchedAt, ...reading.value, stale: reading.stale } : null;

/**
 * The reader. Every read runs the live query; last week's row is read once per Central
 * day (the first read of a day, so Saturday's moves on with the week). The target tile
 * is read hourly and the activation tile every 15 minutes, both from PostHog's cache
 * (`force_cache`), and each keeps its last good value through a failed read; with no
 * target or activation read yet there is no reading. One `blocking` recompute of
 * those two tiles an hour keeps that cache warm, never more than one at a time.
 *
 * A 429 from any call fails the whole read with its Retry-After, so the Monitor backs
 * off and keeps the last good reading.
 *
 * Target Hit: today's row beating the same weekday last week, judged on each reading.
 * Crossing only, so a boot that is already ahead stays quiet, and at most once per
 * local day; a reading from an earlier day counts as behind, so the day's first one
 * can cross. `onTargetHit` is told today's row.
 * ponytail: a crossing while the server is down is missed, and a restart forgets the
 * day was celebrated; persist it if a second hit the same day matters.
 */
export function wauReader({
  token,
  base = "https://us.posthog.com",
  timeoutMs = 15_000,
  now,
  onTargetHit,
}: {
  token: string;
  /** Root of the PostHog API; tests point this at a stub. */
  base?: string;
  /** How long a query or tile read waits. */
  timeoutMs?: number;
  now: () => number;
  onTargetHit: (row: WauRow) => void;
}) {
  const call = async (path: string, init: RequestInit = {}, waitMs = timeoutMs) => {
    const response = await fetch(new URL(`/api/projects/${PROJECT}${path}`, base), {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...init.headers },
      signal: AbortSignal.timeout(waitMs),
    });
    if (response.status === 429)
      throw Object.assign(new Error("PostHog returned 429"), {
        limited: true,
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      });
    if (!response.ok) throw new Error(`PostHog returned ${response.status}`);
    return JSON.parse(await limitedText(response, "PostHog response exceeds 1 MiB"));
  };

  const query = async (name: string, sql: string) => {
    const body = await call("/query/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // force_blocking: plain `blocking` answers from PostHog's cache while it deems
      // that fresh, which a once-a-minute read would mostly just re-read.
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql }, refresh: "force_blocking", name }),
    });
    const row = body?.results?.[0];
    if (!Array.isArray(row) || row.length !== 8 || !row.every((n) => Number.isFinite(n) && n >= 0))
      throw new Error(`PostHog ${name} is not one row of 8 counts`);
    return row as number[];
  };

  const tiles = (ids: number[], refresh: string, waitMs?: number) =>
    call(
      `/dashboards/${DASHBOARD}/run_insights/?tile_ids=${ids.join(",")}&output_format=json&refresh=${refresh}`,
      {},
      waitMs,
    );

  /** A tile's number ("4.5%" reads as 4.5), read every `everyMs`, the last good one kept. */
  const tile = (id: number, everyMs: number) => {
    let value: number | undefined;
    let readAt = -Infinity;
    return async () => {
      // abs: a clock stepped back reads again rather than waiting to catch up.
      if (Math.abs(now() - readAt) < everyMs) return value;
      try {
        const payload = await tiles([id], "force_cache");
        const list = Array.isArray(payload) ? payload : payload?.results;
        const raw = list?.find?.((item: any) => item?.id === id)?.insight?.result?.[0]?.[0];
        const parsed = typeof raw === "string" ? Number(raw.replace(/%$/, "")) : raw;
        if (typeof parsed !== "number" || !Number.isFinite(parsed))
          throw new Error(`PostHog tile ${id} is not numeric`);
        value = parsed;
        readAt = now();
      } catch (error) {
        if ((error as { limited?: boolean }).limited) throw error;
        console.warn(`WUU tile ${id} unavailable${value === undefined ? "" : ", keeping the last good value"}: ${error}`);
      }
      return value;
    };
  };
  const target = tile(TARGET_TILE, HOUR_MS);
  const activation = tile(ACTIVATION_TILE, 15 * 60 * 1000);

  let warming = false;
  let warmedAt = -Infinity;
  const warm = () => {
    if (warming || Math.abs(now() - warmedAt) < HOUR_MS) return;
    warming = true;
    warmedAt = now();
    // In the background: a recompute can outlast any read, and the cache it fills is
    // what the next force_cache reads see.
    tiles([TARGET_TILE, ACTIVATION_TILE], "blocking", 5 * 60_000)
      .catch((error) => console.warn(`WUU tile refresh failed: ${error}`))
      .finally(() => (warming = false));
  };

  let lastWeek: { key: string; row: number[] } | undefined;
  let last: { key: string; ahead: boolean } | undefined;
  let celebratedOn = "";

  return async (): Promise<Wau> => {
    // One instant for the whole read: today's row, last week's day and the pace all
    // agree even when the calls straddle midnight.
    const at = now();
    const key = dayKey(at);
    warm();
    const [live, previous, targetWau, activationPercent] = await Promise.all([
      query("board-wuu-live", LIVE_QUERY),
      lastWeek?.key === key ? lastWeek.row : query("board-wuu-last-week", LAST_WEEK_QUERY),
      target(),
      activation(),
    ]);
    if (targetWau === undefined || activationPercent === undefined)
      throw new Error("no WUU target or activation rate read yet");
    const today = cycleDay(at);
    // New persons on a day after today mean PostHog's clock is in a later day, or (just
    // past Saturday midnight on the Pi) its week is still the last one. Either way its
    // rows are not the board's days, and caching its "last week" would be a week out
    // for the whole day, so this read is dropped and the next one asks again.
    if (live.slice(today + 1, 7).some((count) => count > 0))
      throw new Error("PostHog's week is not the board's: new WUU after today");
    lastWeek = { key, row: previous };

    const wau = toWau({ live, lastWeek: previous, target: targetWau, activation: activationPercent }, at);
    const row = wau.daily[today];
    const ahead = row.current > row.previous;
    if (last && !(last.key === key && last.ahead) && ahead && celebratedOn !== key) {
      celebratedOn = key;
      onTargetHit(row);
    }
    last = { key, ahead };
    return wau;
  };
}
