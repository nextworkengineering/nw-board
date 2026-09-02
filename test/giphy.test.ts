import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { refreshGiphyCache } from "../src/giphy.ts";

const dirs: string[] = [];
const freshDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "giphy-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

/** A fetch stub: the search URL gets `data`, downloads get gif bytes unless failed. */
const stub = (
  data: unknown,
  opts: { downloads?: string[]; fail?: string[] } = {},
): typeof fetch =>
  (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("api.giphy.com"))
      return new Response(JSON.stringify({ data }), { status: 200 });
    opts.downloads?.push(href);
    if (opts.fail?.some((id) => href.includes(id)))
      return new Response("gone", { status: 404 });
    return new Response(GIF, { status: 200 });
  }) as typeof fetch;

const clip = (id: string) => ({ id, images: { downsized: { url: `https://cdn/${id}.gif` } } });

test("downloads the pool, names files by id", async () => {
  const dir = freshDir();
  const result = await refreshGiphyCache({
    apiKey: "k",
    dir,
    query: "wwe",
    limit: 2,
    fetchImpl: stub([clip("abc"), clip("def-2")]),
  });
  expect(result).toEqual({ total: 2, added: 2, removed: 0, failed: 0 });
  expect(readdirSync(dir).sort()).toEqual(["abc.gif", "def-2.gif"]);
});

test("keeps cached clips without re-downloading, ages out the stale", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "abc.gif"), GIF);
  writeFileSync(join(dir, "stale.gif"), GIF);
  const downloads: string[] = [];
  const result = await refreshGiphyCache({
    apiKey: "k",
    dir,
    query: "wwe",
    limit: 2,
    fetchImpl: stub([clip("abc"), clip("new1")], { downloads }),
  });
  expect(result).toEqual({ total: 2, added: 1, removed: 1, failed: 0 });
  expect(readdirSync(dir).sort()).toEqual(["abc.gif", "new1.gif"]);
  expect(downloads).toEqual(["https://cdn/new1.gif"]);
});

test("one dead clip is skipped, the rest still rotate, and the pool stays bounded", async () => {
  const dir = freshDir();
  // Yesterday's pool: none of these are in today's search.
  writeFileSync(join(dir, "old1.gif"), GIF);
  writeFileSync(join(dir, "old2.gif"), GIF);
  const result = await refreshGiphyCache({
    apiKey: "k",
    dir,
    query: "wwe",
    limit: 3,
    fetchImpl: stub([clip("n1"), clip("dead"), clip("n3")], { fail: ["dead"] }),
  });
  // The dead clip must not abort the run, strand yesterday's files, or leave the
  // pool growing: exactly the clips that downloaded survive.
  expect(result).toEqual({ total: 2, added: 2, removed: 2, failed: 1 });
  expect(readdirSync(dir).sort()).toEqual(["n1.gif", "n3.gif"]);
});

test("a run that can fetch nothing keeps the existing pool untouched", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "old1.gif"), GIF);
  writeFileSync(join(dir, "old2.gif"), GIF);
  await expect(
    refreshGiphyCache({
      apiKey: "k",
      dir,
      query: "wwe",
      limit: 2,
      fetchImpl: stub([clip("a1"), clip("a2")], { fail: ["a1", "a2"] }),
    }),
  ).rejects.toThrow("no clips could be fetched");
  expect(readdirSync(dir).sort()).toEqual(["old1.gif", "old2.gif"]);
});

test("a failed search deletes nothing", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "old1.gif"), GIF);
  const failedSearch = (async () => new Response("bad", { status: 500 })) as typeof fetch;
  await expect(
    refreshGiphyCache({ apiKey: "k", dir, query: "wwe", limit: 2, fetchImpl: failedSearch }),
  ).rejects.toThrow("HTTP 500");
  expect(readdirSync(dir)).toEqual(["old1.gif"]);
});

test("ids that are not short plain slugs never become filenames", async () => {
  const dir = freshDir();
  const hostile = { id: "../escape", images: { downsized: { url: "https://cdn/x.gif" } } };
  const long = { id: "a".repeat(65), images: { downsized: { url: "https://cdn/y.gif" } } };
  // Mixed payload — the realistic shape: the good clip lands, the rest are dropped.
  const result = await refreshGiphyCache({
    apiKey: "k",
    dir,
    query: "wwe",
    limit: 3,
    fetchImpl: stub([hostile, clip("good"), long]),
  });
  expect(result.total).toBe(1);
  expect(readdirSync(dir)).toEqual(["good.gif"]);
});

test("tmp files stranded by a power cut are reaped", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, ".abc.1234.deadbeef.tmp"), GIF);
  await refreshGiphyCache({
    apiKey: "k",
    dir,
    query: "wwe",
    limit: 1,
    fetchImpl: stub([clip("abc")]),
  });
  expect(readdirSync(dir)).toEqual(["abc.gif"]);
});
