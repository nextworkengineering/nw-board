import { afterEach, expect, test, vi } from "vitest";
import { createScheduler, dueAt, type Schedule } from "../src/scheduler.ts";

// August 2026: the 13th is a Thursday (getDay() 4), the 15th a Saturday.
const at = (day: number, hour: number, minute = 0, second = 0, ms = 0) =>
  new Date(2026, 7, day, hour, minute, second, ms).getTime();
const THURSDAY = 13;
const SATURDAY = 15;
const hhmm = (time: number) =>
  `${new Date(time).getHours()}`.padStart(2, "0") + ":" + `${new Date(time).getMinutes()}`.padStart(2, "0");

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

/**
 * A scheduler on fake timers from `start`, recording each minute and midnight it is
 * handed. `vi.setSystemTime` steps the wall clock the way NTP does: the armed timer
 * still lands after the delay it was given, on whatever the clock then says.
 */
function run(start: number, now = () => Date.now()) {
  vi.useFakeTimers({ now: start });
  const events: string[] = [];
  const scheduler = createScheduler({
    now,
    onMinute: (time) => events.push(hhmm(time)),
    onMidnight: (time) => events.push(`midnight ${new Date(time).getDate()}`),
  });
  stop = scheduler.stop;
  return events;
}

test("fires within 1 s of :00, once a minute", () => {
  const fired: number[] = [];
  vi.useFakeTimers({ now: at(THURSDAY, 8, 59, 30, 250) });
  stop = createScheduler({ now: Date.now, onMinute: (time) => fired.push(time) }).stop;

  vi.advanceTimersByTime(29_749);
  expect(fired).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(fired).toEqual([at(THURSDAY, 9)]);
  vi.advanceTimersByTime(5 * 60_000);
  expect(fired).toEqual([0, 1, 2, 3, 4, 5].map((minute) => at(THURSDAY, 9, minute)));
});

test("a wake that lands before :00 by the wall clock re-arms and still fires within 1 s of :00, once", () => {
  let lag = 0;
  const events = run(at(THURSDAY, 8, 59, 30), () => Date.now() - lag);
  // The wall clock falls 2 ms behind the timer: it lands with the clock at 08:59:59.998.
  lag = 2;
  vi.advanceTimersByTime(30_000);
  expect(events).toEqual([]);
  vi.advanceTimersByTime(2);
  expect(events).toEqual(["09:00"]);
  vi.advanceTimersByTime(2 * 60_000);
  expect(events).toEqual(["09:00", "09:01", "09:02"]);
});

test("a backward clock step does not double-fire: it stays quiet until it passes the last minute seen", () => {
  const events = run(at(THURSDAY, 9, 58, 55));
  vi.advanceTimersByTime(65_000); // 09:59:00, then 10:00:00
  expect(events).toEqual(["09:59", "10:00"]);

  vi.setSystemTime(at(THURSDAY, 9, 59, 30));
  vi.advanceTimersByTime(60_000); // lands at 10:00:30
  expect(events).toEqual(["09:59", "10:00"]);
  vi.advanceTimersByTime(30_000);
  expect(events).toEqual(["09:59", "10:00", "10:01"]);

  vi.setSystemTime(at(THURSDAY, 9, 50)); // the timer lands at 09:51, then each minute
  vi.advanceTimersByTime(11 * 60_000);
  expect(events).toEqual(["09:59", "10:00", "10:01"]);
  vi.advanceTimersByTime(60_000);
  expect(events).toEqual(["09:59", "10:00", "10:01", "10:02"]);
});

test("a forward jump skips the minutes in between rather than catching up", () => {
  const events = run(at(THURSDAY, 9, 0, 30));
  vi.advanceTimersByTime(10_000);
  vi.setSystemTime(at(THURSDAY, 9, 5, 20));
  vi.advanceTimersByTime(20_000); // the timer armed at 09:00:30 lands at 09:05:40
  expect(events).toEqual(["09:05"]);
  vi.advanceTimersByTime(20_000);
  expect(events).toEqual(["09:05", "09:06"]);
});

test("the minute the scheduler starts in has passed: it is never fired late", () => {
  const events = run(at(THURSDAY, 9, 0, 1));
  vi.advanceTimersByTime(58_999);
  expect(events).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(events).toEqual(["09:01"]);
});

test("midnight rollover: one call as the day changes, before that minute's, and again for a step back across it", () => {
  const events = run(at(THURSDAY, 23, 59, 30));
  vi.advanceTimersByTime(30_000 + 2 * 60_000);
  expect(events).toEqual(["midnight 14", "00:00", "00:01", "00:02"]);

  vi.setSystemTime(at(THURSDAY, 23, 58, 30));
  vi.advanceTimersByTime(60_000); // lands at 23:59:30 Thursday: the day went back
  expect(events.slice(4)).toEqual(["midnight 13"]);
  vi.advanceTimersByTime(30_000); // Friday 00:00 again, a minute already seen
  expect(events.slice(4)).toEqual(["midnight 13", "midnight 14"]);
});

test("a forward jump of days rolls over once", () => {
  const events = run(at(THURSDAY, 22, 0, 30));
  vi.setSystemTime(at(SATURDAY, 10));
  vi.advanceTimersByTime(30_000); // the timer armed at 22:00:30 lands at 10:00:30 Saturday
  expect(events).toEqual(["midnight 15", "10:00"]);
});

test("stop clears the timer", () => {
  run(at(THURSDAY, 9));
  expect(vi.getTimerCount()).toBe(1);
  stop!();
  expect(vi.getTimerCount()).toBe(0);
});

const CHIMES = ["09:00", "17:00"];
const weekly = (id: string, days: number[], time = "10:00"): Schedule => ({
  id,
  kind: "reminder",
  text: id,
  sound: null,
  time,
  days,
});
const oneOff = (id: string, date: string, time = "10:00"): Schedule => ({
  id,
  kind: "celebration",
  text: id,
  sound: null,
  time,
  date,
});

test.for([
  ["the start of a weekday", at(THURSDAY, 9), CHIMES, { at: "09:00", last: false }],
  // The latest configured chime is flagged, so the board ends the day on it.
  ["the end of a weekday", at(THURSDAY, 17, 0, 59), CHIMES, { at: "17:00", last: true }],
  // The board's fallback for a chime with no flag is "17:00 is the end", so a 17:00
  // that is not the latest must say so, or the day ends twice.
  ["a middle 17:00", at(THURSDAY, 17), ["09:00", "17:00", "18:00"], { at: "17:00", last: false }],
  ["the latest of chimes listed out of order", at(THURSDAY, 18, 30), ["18:30", "09:00"], { at: "18:30", last: true }],
  ["a weekend", at(SATURDAY, 9), CHIMES, null],
  ["a minute that is not a chime time", at(THURSDAY, 11), CHIMES, null],
])("the Day Chime due at %s", ([, time, chimes, chime]) => {
  expect(dueAt(time as number, chimes as string[], []).chime).toEqual(chime);
});

test("a weekly schedule is due on its days at its minute; a one-off on its date only", () => {
  const schedules = [
    weekly("thursday", [4]),
    weekly("friday", [5]),
    weekly("weekdays", [1, 2, 3, 4, 5], "10:01"),
    oneOff("today", "2026-08-13"),
    oneOff("tomorrow", "2026-08-14"),
  ];
  const due = (time: number) => dueAt(time, CHIMES, schedules).schedules.map(({ id }) => id);

  expect(due(at(THURSDAY, 10))).toEqual(["thursday", "today"]);
  expect(due(at(THURSDAY, 10, 1))).toEqual(["weekdays"]);
  expect(due(at(THURSDAY + 1, 10))).toEqual(["friday", "tomorrow"]);
  expect(due(at(SATURDAY, 10))).toEqual([]);
});

test("a schedule and a chime at the same minute are both due", () => {
  expect(dueAt(at(THURSDAY, 17), CHIMES, [weekly("standup", [4], "17:00")])).toEqual({
    chime: { at: "17:00", last: true },
    schedules: [weekly("standup", [4], "17:00")],
  });
});
