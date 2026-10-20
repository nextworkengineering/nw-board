import { isDeepStrictEqual } from "node:util";

/**
 * A Monitor keeps one upstream read fresh on the server, so a display is told what
 * changed instead of asking: it owns the timer, the last good value, whether that value
 * has gone stale, Retry-After backoff, and the push when something changed. Service
 * Status and WUU are two readers on it.
 */

/** The last good value, when it was read (the injected clock), and whether that is too long ago. */
export type Reading<T> = { value: T; fetchedAt: string; stale: boolean };

export type Monitor<T> = {
  /** The latest reading, or undefined until the first read succeeds. */
  current(): Reading<T> | undefined;
  /** Read now (or join the read already in flight); a read held off by Retry-After is skipped. */
  refresh(): Promise<void>;
  /** No more reads or pushes; a read already in flight lands nowhere. */
  stop(): void;
};

/**
 * Starts reading at once, then every `intervalMs` after the last read finished, so
 * reads never overlap. A read that throws keeps the last good value; one whose error
 * carries `retryAfterMs` also holds off reading for that long, while the ticks go on
 * judging staleness. `onChange` is called when the value or `stale` changes — a newer
 * `fetchedAt` alone is not news.
 */
export function createMonitor<T>({
  name,
  read,
  intervalMs,
  now,
  onChange,
  staleAfterMs = 2 * intervalMs,
}: {
  /** Names the monitor in the journal when a read fails. */
  name: string;
  read: () => Promise<T>;
  intervalMs: number;
  now: () => number;
  onChange: (reading: Reading<T>) => void;
  /** How long since the last good read before the reading is stale. */
  staleAfterMs?: number;
}): Monitor<T> {
  let reading: Reading<T> | undefined;
  let lastGood = 0;
  let inFlight: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  // Pending while a Retry-After holds reads off. A real timer, like the ticks, rather
  // than the injected clock: a test's frozen `now` would otherwise hold it forever.
  let held: NodeJS.Timeout | undefined;
  let stopped = false;

  const poll = async () => {
    let next = reading;
    if (!held) {
      try {
        const value = await read();
        lastGood = now();
        next = { value, fetchedAt: new Date(lastGood).toISOString(), stale: false };
      } catch (error) {
        const { retryAfterMs } = error as { retryAfterMs?: number };
        // Not after stop(): it has already cleared the timers, and this one would keep
        // the process alive for the length of the Retry-After.
        if (retryAfterMs && retryAfterMs > 0 && !stopped)
          held = setTimeout(() => (held = undefined), retryAfterMs);
        console.warn(`${name} unavailable${reading ? ", keeping the last good reading" : ""}: ${error}`);
      }
    }
    if (stopped || !next) return;
    // Judged on every tick, failed or held, so a reading that stops being refreshed
    // goes stale on time rather than at the next successful read.
    const stale = now() - lastGood > staleAfterMs;
    if (stale !== next.stale) next = { ...next, stale };
    const changed =
      !reading || reading.stale !== next.stale || !isDeepStrictEqual(reading.value, next.value);
    reading = next;
    if (changed) onChange(next);
  };

  const refresh = () => (inFlight ??= poll().finally(() => (inFlight = undefined)));

  const tick = () =>
    void refresh()
      .catch((error) => console.warn(`${name} push failed: ${error}`))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  tick();

  return {
    current: () => reading,
    refresh,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(held);
    },
  };
}
