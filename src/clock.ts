/**
 * The server's one day clock: every "what day is it" question, asked of an epoch ms
 * (the injected `now()`) in the Pi's local time (US Central). Built on Date's own
 * local-time setters rather than DAY_MS arithmetic, so a 23- or 25-hour DST day
 * still starts and ends at midnight.
 */

/** Local midnight of the day containing `at` — today's MVP starts here. */
export const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);

/** The next local midnight after `at` — when a live Theme comes off. */
export const nextMidnight = (at: number) => new Date(at).setHours(24, 0, 0, 0);

/** A key naming the local day containing `at`, e.g. "Tue Oct 20 2026". */
export const dayKey = (at: number) => new Date(at).toDateString();

/** "YYYY-MM-DD" of `at` in local time — what a one-off schedule's date is compared with. */
export const localDate = (at: number) => {
  const day = new Date(at);
  return `${day.getFullYear()}-${`${day.getMonth() + 1}`.padStart(2, "0")}-${`${day.getDate()}`.padStart(2, "0")}`;
};

/** The day's index in the WUU week, Saturday=0 … Friday=6 — the dashboard's `daily` order. */
export const cycleDay = (at: number) => (new Date(at).getDay() + 1) % 7;

/** Monday 00:00 local time of the week containing `at` — the dedup window. */
export const startOfWeek = (at: number) => {
  const monday = new Date(at);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday.getTime();
};

/**
 * How long from `at` until the next local :00 — never 0, so a timer armed on the minute
 * waits a whole one. Epoch arithmetic, unlike the days above: every UTC offset is whole
 * minutes, and a local-time setter would aim 01:59 on the fall-back night at the one
 * 02:00, an hour and a minute away.
 */
export const msToNextMinute = (at: number) => 60_000 - (at % 60_000);
