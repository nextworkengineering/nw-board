import { localDate, msToNextMinute, startOfDay } from "./clock.ts";

/**
 * The Day Chime, Reminder and Scheduled Celebration clock, plus the midnight rollover:
 * one timer that wakes on each local :00, so whatever is due at a minute goes out
 * within a moment of it rather than up to a poll interval late.
 */

/** A Reminder or Scheduled Celebration, normalized to exactly the fields the board uses. */
export type Schedule = {
  id: string;
  kind: "reminder" | "celebration";
  text: string;
  /** A Sound Library path, e.g. "uploads/gong.mp3"; null plays the board's fallback jingle. */
  sound: string | null;
  time: string;
} & ({ date: string } | { days: number[] });

/**
 * What is due at the local minute containing `at`: the Day Chime (weekdays only) and
 * every schedule whose time it is, one-off on its date or weekly on its days. Everything
 * due in a minute fires together, so a Reminder set for 09:00 and the 09:00 chime both go out.
 */
export function dueAt(at: number, chimes: string[], schedules: Schedule[]) {
  const date = new Date(at);
  const hhmm = `${date.getHours()}`.padStart(2, "0") + ":" + `${date.getMinutes()}`.padStart(2, "0");
  const weekday = date.getDay() >= 1 && date.getDay() <= 5;
  const today = localDate(at);
  return {
    // "HH:MM" sorts as text, so the latest chime is the last one sorted: the end of the
    // workday, whatever times the Admin Console has set. Always a boolean: with none,
    // the board falls back to "17:00 is the end" and a middle 17:00 would end the day.
    chime:
      weekday && chimes.includes(hhmm)
        ? { at: hhmm, last: hhmm === [...chimes].sort().at(-1) }
        : null,
    schedules: schedules.filter(
      (schedule) =>
        schedule.time === hhmm &&
        ("date" in schedule ? schedule.date === today : schedule.days.includes(date.getDay())),
    ),
  };
}

/**
 * Wakes on each local :00 of the injected clock, re-arming a one-shot timer every
 * time rather than trusting a fixed period, so the wake follows the clock (and a Pi
 * whose time jumps after an NTP sync). A wake that lands before the minute turns —
 * the timer and the wall clock drift apart — re-arms for the rest of it.
 *
 * `onMinute` gets each new minute once. The minute only moves forward: a clock
 * stepped back stays quiet until it passes the last minute seen, rather than firing
 * it twice, and a forward jump (or a late wake) skips the minutes in between rather
 * than catching up. The minute the scheduler starts in counts as seen: it fires a
 * minute by reaching it, never most of a minute late.
 *
 * `onMidnight` gets each wake whose local day differs from the last one's, either
 * way, before that wake's `onMinute`.
 *
 * ponytail: minutes are epoch minutes, so on the fall-back night 01:00-01:59 comes
 * twice and so does anything due in it (a Sunday: no Day Chime, only a weekly Sunday
 * schedule), and the spring-forward 02:00-02:59 never comes. Key by local "HH:MM" if a
 * 01:30 Sunday schedule ever matters.
 */
export function createScheduler({
  now,
  onMinute,
  onMidnight,
}: {
  now: () => number;
  onMinute: (at: number) => void;
  onMidnight?: (at: number) => void;
}) {
  const start = now();
  let day = startOfDay(start);
  let lastMinute = Math.floor(start / 60_000);
  let timer: NodeJS.Timeout;
  const arm = () => (timer = setTimeout(wake, msToNextMinute(now())));
  function wake() {
    const at = now();
    // Re-armed before the callbacks run, so one that throws doesn't end the schedule.
    arm();
    if (startOfDay(at) !== day) {
      day = startOfDay(at);
      onMidnight?.(at);
    }
    const minute = Math.floor(at / 60_000);
    if (minute <= lastMinute) return;
    lastMinute = minute;
    onMinute(at);
  }
  arm();
  return { stop: () => clearTimeout(timer) };
}
