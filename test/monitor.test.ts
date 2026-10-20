import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMonitor, type Monitor, type Reading } from "../src/monitor.ts";
import { retryAfterMs } from "../src/upstream.ts";

const T0 = new Date(2026, 9, 20, 9, 0).getTime();
const INTERVAL = 1_000;

let monitor: Monitor<unknown> | undefined;
beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  monitor?.stop();
  monitor = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A monitor over `reads`, one per read (a function result is thrown); the last repeats. */
function watch(reads: unknown[], now = Date.now) {
  const pushes: Reading<unknown>[] = [];
  const read = vi.fn(async () => {
    const next = reads.length > 1 ? reads.shift() : reads[0];
    if (typeof next === "function") throw next();
    return next;
  });
  monitor = createMonitor({
    name: "Test",
    read,
    intervalMs: INTERVAL,
    now,
    onChange: (reading) => pushes.push(reading),
  });
  return { read, pushes, monitor };
}
const fails = (extra = {}) => () => Object.assign(new Error("upstream down"), extra);
const at = (ms: number) => new Date(T0 + ms).toISOString();

test("the first read happens at start", async () => {
  const { read, pushes } = watch([{ a: 1 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(pushes).toEqual([{ value: { a: 1 }, fetchedAt: at(0), stale: false }]);
});

test("pushes only on change", async () => {
  const { pushes, monitor } = watch([{ a: 1 }, { a: 1 }, { a: 2 }, { a: 2 }]);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(INTERVAL);
  // An equal value read again is no news, but current() carries the newer read.
  expect(pushes).toHaveLength(1);
  expect(monitor.current()).toEqual({ value: { a: 1 }, fetchedAt: at(INTERVAL), stale: false });

  await vi.advanceTimersByTimeAsync(2 * INTERVAL);
  expect(pushes).toEqual([
    { value: { a: 1 }, fetchedAt: at(0), stale: false },
    { value: { a: 2 }, fetchedAt: at(2 * INTERVAL), stale: false },
  ]);
});

test("a stale flip pushes", async () => {
  const { pushes, read } = watch([{ a: 1 }, fails(), fails(), fails(), { a: 1 }]);
  await vi.advanceTimersByTimeAsync(0);
  // Two failed reads: the last good one is exactly 2 intervals old, not yet stale.
  await vi.advanceTimersByTimeAsync(2 * INTERVAL);
  expect(pushes).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(INTERVAL);
  expect(pushes.at(-1)).toEqual({ value: { a: 1 }, fetchedAt: at(0), stale: true });
  expect(pushes).toHaveLength(2);

  // The same value read again is news now: it is fresh again.
  await vi.advanceTimersByTimeAsync(INTERVAL);
  expect(read).toHaveBeenCalledTimes(5);
  expect(pushes.at(-1)).toEqual({ value: { a: 1 }, fetchedAt: at(4 * INTERVAL), stale: false });
  expect(pushes).toHaveLength(3);
});

test("backs off on Retry-After", async () => {
  const { read, pushes } = watch([{ a: 1 }, fails({ retryAfterMs: 5 * INTERVAL }), { a: 1 }]);
  await vi.advanceTimersByTimeAsync(INTERVAL);
  expect(read).toHaveBeenCalledTimes(2);

  // Held from 1s to 6s: the ticks between read nothing, but still judge staleness.
  await vi.advanceTimersByTimeAsync(5 * INTERVAL - 1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(pushes.at(-1)).toEqual({ value: { a: 1 }, fetchedAt: at(0), stale: true });

  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
  expect(pushes.at(-1)).toEqual({ value: { a: 1 }, fetchedAt: at(6 * INTERVAL), stale: false });
});

test("backs off on Retry-After given as seconds or an HTTP-date", () => {
  expect(retryAfterMs("120")).toBe(120_000);
  expect(retryAfterMs(new Date(T0 + 30_000).toUTCString(), T0)).toBe(30_000);
  expect(retryAfterMs(new Date(T0 - 30_000).toUTCString(), T0)).toBe(0);
  expect(retryAfterMs(null)).toBeUndefined();
  expect(retryAfterMs("soon")).toBeUndefined();
});

test("keeps the last good reading", async () => {
  const { pushes, monitor } = watch([{ a: 1 }, fails(), fails({ retryAfterMs: 60_000 })]);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(INTERVAL);
  expect(monitor.current()).toEqual({ value: { a: 1 }, fetchedAt: at(0), stale: false });
  await vi.advanceTimersByTimeAsync(INTERVAL);
  expect(monitor.current()).toEqual({ value: { a: 1 }, fetchedAt: at(0), stale: false });
  expect(pushes).toHaveLength(1);
});

test("nothing to keep before the first good read", async () => {
  const { pushes, monitor } = watch([fails(), { a: 1 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(monitor.current()).toBeUndefined();
  expect(pushes).toEqual([]);
  await vi.advanceTimersByTimeAsync(INTERVAL);
  expect(pushes).toEqual([{ value: { a: 1 }, fetchedAt: at(INTERVAL), stale: false }]);
});

test("fetchedAt comes from the injected clock", async () => {
  const injected = new Date(2027, 0, 2, 3, 4, 5).getTime();
  const { monitor } = watch([{ a: 1 }], () => injected);
  await vi.advanceTimersByTimeAsync(0);
  expect(monitor.current()?.fetchedAt).toBe(new Date(injected).toISOString());
});

test("reads never overlap, and a refresh joins the read in flight", async () => {
  let release!: (value: unknown) => void;
  const read = vi.fn(() => new Promise((resolve) => (release = resolve)));
  monitor = createMonitor({ name: "Test", read, intervalMs: INTERVAL, now: Date.now, onChange: () => {} });
  const joined = monitor.refresh();
  // A read slower than the interval: no tick starts a second one beside it.
  await vi.advanceTimersByTimeAsync(3 * INTERVAL);
  expect(read).toHaveBeenCalledTimes(1);

  release({ a: 1 });
  await joined;
  expect(monitor.current()?.value).toEqual({ a: 1 });
  // The next read is an interval after this one finished.
  await vi.advanceTimersByTimeAsync(INTERVAL - 1);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
});

test("stop ends the reads, and a read in flight pushes nothing", async () => {
  let release!: (value: unknown) => void;
  const read = vi.fn(() => new Promise((resolve) => (release = resolve)));
  const onChange = vi.fn();
  monitor = createMonitor({ name: "Test", read, intervalMs: INTERVAL, now: Date.now, onChange });
  monitor.stop();
  release({ a: 1 });
  await vi.advanceTimersByTimeAsync(10 * INTERVAL);
  expect(read).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("a 429 after stop leaves no timer", async () => {
  let refuse!: (error: unknown) => void;
  const read = vi.fn(() => new Promise((_, reject) => (refuse = reject)));
  monitor = createMonitor({ name: "Test", read, intervalMs: INTERVAL, now: Date.now, onChange: () => {} });
  monitor.stop();
  // The read in flight at stop() comes back limited: its Retry-After holds nothing.
  refuse(fails({ retryAfterMs: 60_000 })());
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});
