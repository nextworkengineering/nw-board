import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Keeps public/celebrations/giphy stocked from the Giphy search API so a merge
// takeover always plays from local disk: the board never waits on the network,
// and a dead network just replays the last pool.
//
// The pool after a run is exactly the clips from this search that are playable
// on disk, so it stays bounded by `limit` and converges even when one clip is
// permanently gone from the CDN: a failed download is skipped, not fatal. The
// pool is only ever emptied by a run that has something to put in it — if the
// search fails, or nothing at all is playable, we throw before deleting
// anything and yesterday's pool survives.
//
// This directory is SERVER-OWNED: the sweep deletes any media in it that is not
// in the current pool. Hand-dropped clips belong one level up, in
// public/celebrations, which this module never touches.

const MEDIA = /\.(gif|webp|png|apng)$/i;
/** Giphy's `downsized` is ~2 MB; `original` is uncapped and the Pi has 512 MB-4 GB. */
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
/** Giphy's own search ceiling. */
const MAX_LIMIT = 50;

type RefreshOptions = {
  apiKey: string;
  /** Absolute path of the cache directory (created if missing). */
  dir: string;
  query: string;
  limit: number;
  /** Tests inject a stub; production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Aborts in-flight downloads when the server shuts down. */
  signal?: AbortSignal;
};

export async function refreshGiphyCache({
  apiKey,
  dir,
  query,
  limit,
  fetchImpl,
  signal,
}: RefreshOptions) {
  const get = fetchImpl ?? fetch;
  // Every request is bounded: a stalled download on a flaky uplink would
  // otherwise sit on undici's 300s body timeout, once per clip.
  const fetchWithTimeout = (url: string) => {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    return get(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  };

  const url = new URL("https://api.giphy.com/v1/gifs/search");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(Math.max(1, limit), MAX_LIMIT)));
  // The board hangs in an office; keep the pool office-safe.
  url.searchParams.set("rating", "pg-13");
  const res = await fetchWithTimeout(url.toString());
  if (!res.ok) throw new Error(`giphy search: HTTP ${res.status}`);
  const body: any = await res.json();
  if (!Array.isArray(body?.data)) throw new Error("giphy search: unexpected response shape");

  // downsized keeps clips a sane size for the takeover box; original is the
  // fallback. The id becomes a filename, so anything but a short plain slug is
  // dropped rather than trusted.
  const clips = body.data
    .map((g: any) => ({
      id: g?.id,
      url: g?.images?.downsized?.url || g?.images?.original?.url,
    }))
    .filter(
      (c: any): c is { id: string; url: string } =>
        typeof c.id === "string" &&
        c.id.length <= 64 &&
        /^[A-Za-z0-9_-]+$/.test(c.id) &&
        typeof c.url === "string",
    );
  if (!clips.length) throw new Error("giphy search: no usable clips in response");

  mkdirSync(dir, { recursive: true });
  // Reap tmp files stranded by a power cut mid-download: they are invisible to
  // the listing (no media extension) and would otherwise accumulate forever.
  for (const file of readdirSync(dir))
    if (file.endsWith(".tmp")) rmSync(join(dir, file), { force: true });

  const have = new Set(readdirSync(dir));
  /** Clips from this search that are playable on disk — the pool after this run. */
  const available = new Set<string>();
  let added = 0;
  let failed = 0;
  for (const clip of clips) {
    const name = `${clip.id}.gif`;
    if (have.has(name)) {
      available.add(name);
      continue;
    }
    try {
      const download = await fetchWithTimeout(clip.url);
      if (!download.ok) throw new Error(`HTTP ${download.status}`);
      const declared = Number(download.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES) throw new Error(`${declared} bytes exceeds the ${MAX_BYTES} cap`);
      const bytes = Buffer.from(await download.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES)
        throw new Error(`${bytes.byteLength} bytes exceeds the ${MAX_BYTES} cap`);
      // tmp-then-rename so a crash mid-download never leaves half a gif for the
      // TV. The name is unique per writer, so two processes racing on the same
      // clip cannot rename each other's partial bytes into place.
      const tmp = join(dir, `.${clip.id}.${process.pid}.${randomUUID()}.tmp`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, join(dir, name));
      available.add(name);
      added++;
    } catch (error: any) {
      // One dead CDN entry must not stop the pool rotating, so skip and carry on.
      failed++;
      console.warn(`giphy: skipped ${clip.id}: ${error?.cause ?? error}`);
    }
  }

  // Nothing playable means the network, not the pool, is the problem: leave
  // yesterday's clips alone rather than sweeping the board down to nothing.
  if (!available.size)
    throw new Error(`giphy: no clips could be fetched (${failed} failed), keeping the current pool`);

  let removed = 0;
  for (const file of readdirSync(dir)) {
    if (MEDIA.test(file) && !available.has(file)) {
      rmSync(join(dir, file), { force: true });
      removed++;
    }
  }
  return { total: available.size, added, removed, failed };
}
