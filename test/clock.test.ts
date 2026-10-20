import { expect, test } from "vitest";
import {
  cycleDay,
  dayKey,
  localDate,
  msToNextMinute,
  nextMidnight,
  startOfDay,
  startOfWeek,
} from "../src/clock.ts";

// Every instant is built from local fields, so these hold in whatever zone the suite
// runs in. 2026-03-08 and 2026-11-01 are the US DST changes: on the Pi (US Central)
// those days are 23 and 25 hours long, and a DAY_MS shortcut would miss midnight.
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) =>
  new Date(y, m - 1, d, h, min, s, ms).getTime();

test("startOfDay is local midnight, including on DST change days", () => {
  expect(startOfDay(at(2026, 10, 20, 15, 42, 7, 9))).toBe(at(2026, 10, 20));
  expect(startOfDay(at(2026, 10, 20))).toBe(at(2026, 10, 20));
  expect(startOfDay(at(2026, 10, 20, 23, 59, 59, 999))).toBe(at(2026, 10, 20));
  expect(startOfDay(at(2026, 3, 8, 12))).toBe(at(2026, 3, 8));
  expect(startOfDay(at(2026, 11, 1, 23, 30))).toBe(at(2026, 11, 1));
});

test("nextMidnight is the following local midnight, so a DST day keeps its real length", () => {
  expect(nextMidnight(at(2026, 10, 20, 15))).toBe(at(2026, 10, 21));
  // Midnight itself belongs to the day it starts: the next one is a day away.
  expect(nextMidnight(at(2026, 10, 20))).toBe(at(2026, 10, 21));
  expect(nextMidnight(at(2026, 12, 31, 23, 59))).toBe(at(2027, 1, 1));
  expect(nextMidnight(at(2026, 3, 8, 12))).toBe(at(2026, 3, 9));
  expect(nextMidnight(at(2026, 11, 1, 12))).toBe(at(2026, 11, 2));
  const springDay = nextMidnight(at(2026, 3, 8, 12)) - startOfDay(at(2026, 3, 8, 12));
  expect(springDay).toBe(at(2026, 3, 9) - at(2026, 3, 8));
});

test("dayKey names the local day, changing exactly at midnight", () => {
  expect(dayKey(at(2026, 10, 20, 9))).toBe(new Date(2026, 9, 20).toDateString());
  expect(dayKey(at(2026, 10, 20, 23, 59, 59, 999))).toBe(dayKey(at(2026, 10, 20)));
  expect(dayKey(at(2026, 10, 21))).not.toBe(dayKey(at(2026, 10, 20, 23, 59, 59, 999)));
});

test("localDate is zero-padded YYYY-MM-DD in local time", () => {
  expect(localDate(at(2026, 1, 5, 8))).toBe("2026-01-05");
  expect(localDate(at(2026, 12, 31, 23, 59, 59, 999))).toBe("2026-12-31");
  expect(localDate(at(2027, 1, 1))).toBe("2027-01-01");
});

test("cycleDay counts the WUU week from Saturday=0 to Friday=6", () => {
  // 2026-10-17 is a Saturday.
  const week = [17, 18, 19, 20, 21, 22, 23].map((d) => cycleDay(at(2026, 10, d, 12)));
  expect(week).toEqual([0, 1, 2, 3, 4, 5, 6]);
  // The cycle turns over at Friday's midnight.
  expect(cycleDay(at(2026, 10, 23, 23, 59, 59, 999))).toBe(6);
  expect(cycleDay(at(2026, 10, 24))).toBe(0);
});

test("startOfWeek is Monday 00:00 of the week holding `at`", () => {
  // 2026-10-19 is a Monday.
  expect(startOfWeek(at(2026, 10, 19))).toBe(at(2026, 10, 19));
  expect(startOfWeek(at(2026, 10, 21, 14))).toBe(at(2026, 10, 19));
  // Sunday is the end of the week, not the start of the next.
  expect(startOfWeek(at(2026, 10, 25, 23, 59, 59, 999))).toBe(at(2026, 10, 19));
  expect(startOfWeek(at(2026, 10, 26))).toBe(at(2026, 10, 26));
  // Across a month boundary and across each DST change.
  expect(startOfWeek(at(2026, 11, 1, 12))).toBe(at(2026, 10, 26));
  expect(startOfWeek(at(2026, 11, 3, 8))).toBe(at(2026, 11, 2));
  expect(startOfWeek(at(2026, 3, 8, 23))).toBe(at(2026, 3, 2));
  expect(startOfWeek(at(2026, 3, 10, 8))).toBe(at(2026, 3, 9));
});

test("msToNextMinute lands on the next :00, a whole minute away when already on one", () => {
  expect(msToNextMinute(at(2026, 10, 20, 9, 0))).toBe(60_000);
  expect(msToNextMinute(at(2026, 10, 20, 9, 0, 30))).toBe(30_000);
  expect(msToNextMinute(at(2026, 10, 20, 8, 59, 59, 999))).toBe(1);
  expect(msToNextMinute(at(2026, 10, 20, 23, 59, 45))).toBe(15_000);
  const from = at(2026, 3, 8, 1, 59, 12, 345);
  expect(new Date(from + msToNextMinute(from)).getSeconds()).toBe(0);
  expect(new Date(from + msToNextMinute(from)).getMilliseconds()).toBe(0);
});
