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

/** A fetch stub: the search URL gets `data`, everything else gets gif bytes. */
const stub =
  (data: unknown, downloads: Record<string, number> = {}) =>
  async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("api.giphy.com"))
      return new Response(JSON.stringify({ data }), { status: 200 });
    downloads[href] = (downloads[href] ?? 0) + 1;
    return new Response(GIF, { status: 200 });
  };

const clip = (id: string) => ({ id, images: { downsized: { url: `https://cdn/${id}.gif` } } });

test("downloads the pool, names files by id", async () => {
  const dir = freshDir();
  const result = await refreshGiphyCache({
    apiKey: "k",
    dir,
    query: "wwe",
    limit: 2,
    fetchImpl: stub([clip("abc"), clip("def-2")]) as typeof fetch,
  });
  expect(result).toEqual({ total: 2, added: 2, removed: 0 });
  expect(readdirSync(dir).sort()).toEqual(["abc.gif", "def-2.gif"]);
});

test("keeps cached clips without re-downloading, ages out the stale", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "abc.gif"), GIF);
  writeFileSync(join(dir, "stale.gif"), GIF);
  const downloads: Record<string, number> = {};
  const result = await refreshGiphyCache({
    apiKey: "k",
    dir,
    query: "wwe",
    limit: 2,
    fetchImpl: stub([clip("abc"), clip("new1")], downloads) as typeof fetch,
  });
  expect(result).toEqual({ total: 2, added: 1, removed: 1 });
  expect(readdirSync(dir).sort()).toEqual(["abc.gif", "new1.gif"]);
  expect(downloads["https://cdn/abc.gif"]).toBeUndefined();
});

test("a failed download keeps the existing pool intact", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "old.gif"), GIF);
  const failing = (async (url: string | URL | Request) =>
    String(url).includes("api.giphy.com")
      ? new Response(JSON.stringify({ data: [clip("abc")] }), { status: 200 })
      : new Response("nope", { status: 503 })) as typeof fetch;
  await expect(
    refreshGiphyCache({ apiKey: "k", dir, query: "wwe", limit: 1, fetchImpl: failing }),
  ).rejects.toThrow("HTTP 503");
  expect(readdirSync(dir)).toEqual(["old.gif"]);
});

test("ids that are not plain slugs never become filenames", async () => {
  const dir = freshDir();
  const hostile = { id: "../escape", images: { downsized: { url: "https://cdn/x.gif" } } };
  await expect(
    refreshGiphyCache({
      apiKey: "k",
      dir,
      query: "wwe",
      limit: 1,
      fetchImpl: stub([hostile]) as typeof fetch,
    }),
  ).rejects.toThrow("no usable clips");
  expect(readdirSync(dir)).toEqual([]);
});
