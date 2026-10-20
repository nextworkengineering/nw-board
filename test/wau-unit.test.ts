import { expect, test } from "vitest";
import { LAST_WEEK_QUERY, LIVE_QUERY, onTarget, toWau, wauPayload } from "../src/wau.ts";

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
    expect(sql).toMatch(/WHERE event = '\$pageview'\n(.*\n){2}\s+AND NOT coalesce\(properties\.\$virt_is_bot, false\)/);
  }
  expect(LIVE_QUERY).toContain("AND timestamp >= week_start\n    AND timestamp <= now()");
  expect(LAST_WEEK_QUERY).toContain("week_start - toIntervalDay(7) AS last_week_start\nSELECT");
  expect(LAST_WEEK_QUERY).toContain("AND timestamp >= last_week_start\n    AND timestamp < week_start");
});
