import { afterEach, expect, test, vi } from "vitest";
import { LAST_WEEK_QUERY, LIVE_QUERY, onTarget, toWau, wauPayload, wauReader } from "../src/wau.ts";

// Days are the Pi's local days, which are US Central ones.
process.env.TZ = "America/Chicago";

/** Thursday 13 August 2026 at `hour`, local. */
const thursdayAt = (hour: number) => new Date(2026, 7, 13, hour).getTime();

// Thursday noon is 5.5 days into the Sat–Fri cycle: a 7000 target expects 5500 by now.
test.each([
  [5500, 7000, "on"],
  [4950, 7000, "on"],
  [4949, 7000, "behind"],
  [3850, 7000, "behind"],
  [3849, 7000, "far-behind"],
  [0, 0, "on"],
])("On Target: %i WUU against a %i target at Thursday noon is %s", (current, target, expected) => {
  expect(onTarget(current, target, thursdayAt(12))).toBe(expected);
});

// Monday noon is 60 of the week's 168 hours: a 10000 target expects ≈ 3571 by now.
test.each([
  [2000, "far-behind"],
  [3300, "on"],
])("On Target: %i WUU against a 10000 target at Monday noon is %s", (current, expected) => {
  expect(onTarget(current, 10000, new Date(2026, 7, 10, 12).getTime())).toBe(expected);
});

test("On Target: the pace starts at Saturday midnight, so a new week owes nothing", () => {
  expect(onTarget(0, 24400, new Date(2026, 7, 15, 0, 0).getTime())).toBe("on");
  // Friday at 23:00 owes nearly the whole target.
  expect(onTarget(21000, 24400, new Date(2026, 7, 14, 23).getTime())).toBe("behind");
});

test("On Target: a DST day's 25 hours still end the day at midnight", () => {
  // Sunday 1 November 2026, CDT -> CST: 18:00 local is 19 of the day's 25 hours, 1.76 days in.
  // A 7000 target expects 1760 by then, so green from 1584. Read as 18 of 24 hours it
  // would expect 1750 (1580 green); as 19 of 24, 1792 (1590 yellow).
  const at = new Date(2026, 10, 1, 18).getTime();
  expect(onTarget(1580, 7000, at)).toBe("behind");
  expect(onTarget(1590, 7000, at)).toBe("on");
});

test("the payload: Saturday-first rows, today's index, and the target's derived numbers", () => {
  const live = [4110, 3315, 3352, 2376, 0, 0, 0, 13153];
  const lastWeek = [2967, 3727, 3420, 3312, 2267, 2137, 3895, 21725];
  const at = new Date(2026, 9, 20, 14, 30).getTime(); // Tuesday
  const value = toWau({ live, lastWeek, target: 24400, activation: 4.5 }, at);

  expect(value).toEqual({
    currentWau: 13153,
    targetWau: 24400,
    targetPercent: 53.9,
    activationPercent: 4.5,
    daily: [
      { day: 1, label: "Saturday", current: 4110, previous: 2967 },
      { day: 2, label: "Sunday", current: 3315, previous: 3727 },
      { day: 3, label: "Monday", current: 3352, previous: 3420 },
      { day: 4, label: "Tuesday", current: 2376, previous: 3312 },
      { day: 5, label: "Wednesday", current: 0, previous: 2267 },
      { day: 6, label: "Thursday", current: 0, previous: 2137 },
      { day: 7, label: "Friday", current: 0, previous: 3895 },
    ],
    today: 3,
    // 3 + 14.5/24 days in: 13153 against 24400 × 3.604 / 7 ≈ 12564.
    onTarget: "on",
  });
  expect(toWau({ live, lastWeek, target: 0, activation: 4.5 }, at).targetPercent).toBe(0);

  const fetchedAt = new Date(at).toISOString();
  expect(wauPayload({ value, fetchedAt, stale: true })).toEqual({ fetchedAt, ...value, stale: true });
  expect(wauPayload(undefined)).toBeNull();
});

test("the queries count US Central days, with the pageview filter beside the bot check", () => {
  for (const sql of [LIVE_QUERY, LAST_WEEK_QUERY]) {
    expect(sql).toContain("toStartOfDay(toTimeZone(now(), 'America/Chicago')) AS today_ct");
    expect(sql).toContain("(toDayOfWeek(toTimeZone(min(timestamp), 'America/Chicago')) + 1) % 7 AS day");
    expect(sql).toMatch(/WHERE event = '\$pageview'\n(.*\n){2}\s+AND NOT \(coalesce\(properties\.\$virt_is_bot, false\)/);
    expect(sql).toContain("AND properties.$timezone = 'Asia/Shanghai'))\n  GROUP BY person_id");
  }
  expect(LIVE_QUERY).toContain("AND timestamp >= week_start\n    AND timestamp <= now()");
  expect(LAST_WEEK_QUERY).toContain("week_start - toIntervalDay(7) AS last_week_start\nSELECT");
  expect(LAST_WEEK_QUERY).toContain("AND timestamp >= last_week_start\n    AND timestamp < week_start");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const THIS_WEEK = "2026-08-08T00:00:00-05:00";
const WEEK_BEFORE = "2026-08-01T00:00:00-05:00";

/**
 * A stub PostHog behind `fetch`: the queries answer `live` / `lastWeek` (8 counts, then
 * the week start), the cached tiles a target and a rate, and the hourly `blocking` warm
 * `warmStatus`. `asked` lists each call by query name or tile refresh mode.
 */
function stubPostHog() {
  const ph = {
    live: [1000, 1001, 1002, 1003, 1004, 900, 0, 5910, THIS_WEEK] as unknown[],
    lastWeek: [900, 901, 902, 903, 904, 1000, 1000, 6510, THIS_WEEK] as unknown[],
    warmStatus: 200,
    asked: [] as string[],
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    if (url.pathname.endsWith("/query/")) {
      const { name } = JSON.parse(init.body as string);
      ph.asked.push(name);
      return Response.json({ results: [name === "board-wuu-live" ? ph.live : ph.lastWeek] });
    }
    const refresh = url.searchParams.get("refresh")!;
    ph.asked.push(refresh);
    if (refresh === "blocking") return Response.json({ results: [] }, { status: ph.warmStatus });
    const ids = url.searchParams.get("tile_ids")!.split(",").map(Number);
    const value = (id: number) => (id === 7119740 ? 24400 : "4.5%");
    return Response.json({ results: ids.map((id) => ({ id, insight: { result: [[value(id)]] } })) });
  });
  return ph;
}
const asked = (ph: { asked: string[] }, what: string) => ph.asked.filter((call) => call === what).length;
/** Let the warm, which runs in the background, finish. */
const settle = () => new Promise((done) => setTimeout(done, 10));

test("a last-week row from another week is dropped", async () => {
  const ph = stubPostHog();
  // Read just after Saturday midnight, with its last-week query run just before it.
  ph.lastWeek = [...ph.lastWeek.slice(0, 8), WEEK_BEFORE];
  const read = wauReader({ token: "t", now: () => thursdayAt(10), onTargetHit: () => {} });

  await expect(read()).rejects.toThrow("not the live week's");
  // Nothing was kept: the next read asks for last week again, and this time it matches.
  ph.lastWeek = [...ph.lastWeek.slice(0, 8), THIS_WEEK];
  expect((await read()).daily[5]).toMatchObject({ current: 900, previous: 1000 });
  expect(asked(ph, "board-wuu-last-week")).toBe(2);
  // Kept for the rest of the day now.
  await read();
  expect(asked(ph, "board-wuu-last-week")).toBe(2);
});

test("a failed warm retries before the hour", async () => {
  const ph = stubPostHog();
  ph.warmStatus = 504;
  let clock = thursdayAt(10);
  const read = wauReader({ token: "t", now: () => clock, onTargetHit: () => {} });
  const readAt = async (minutes: number) => {
    clock = thursdayAt(10) + minutes * 60_000;
    await read();
    await settle();
  };

  await readAt(0);
  expect(asked(ph, "blocking")).toBe(1);
  // Not straight away: one try every 5 minutes at most.
  await readAt(4);
  expect(asked(ph, "blocking")).toBe(1);
  ph.warmStatus = 200;
  await readAt(5);
  expect(asked(ph, "blocking")).toBe(2);
  // A warm that worked buys the hour.
  await readAt(64);
  expect(asked(ph, "blocking")).toBe(2);
  await readAt(65);
  expect(asked(ph, "blocking")).toBe(3);
});
