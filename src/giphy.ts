import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Keeps public/celebrations/giphy stocked from the Giphy search API so a merge
// takeover always plays from local disk: the board never waits on the network,
// and a dead network just replays the last pool. The whole refresh is
// all-or-keep — stale clips are only aged out after every download landed, so
// a failure part-way leaves yesterday's cache intact rather than a thin one.

type RefreshOptions = {
  apiKey: string;
  /** Absolute path of the cache directory (created if missing). */
  dir: string;
  query: string;
  limit: number;
  /** Tests inject a stub; production uses global fetch. */
  fetchImpl?: typeof fetch;
};

export async function refreshGiphyCache({ apiKey, dir, query, limit, fetchImpl }: RefreshOptions) {
  const get = fetchImpl ?? fetch;
  const url = new URL("https://api.giphy.com/v1/gifs/search");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  // The board hangs in an office; keep the pool office-safe.
  url.searchParams.set("rating", "pg-13");
  const res = await get(url.toString());
  if (!res.ok) throw new Error(`giphy search: HTTP ${res.status}`);
  const body: any = await res.json();
  if (!Array.isArray(body?.data)) throw new Error("giphy search: unexpected response shape");

  // downsized keeps clips a sane size for the 640px takeover box; original is
  // the fallback. The id becomes a filename, so anything but a plain slug is
  // dropped rather than trusted.
  const clips = body.data
    .map((g: any) => ({
      id: g?.id,
      url: g?.images?.downsized?.url || g?.images?.original?.url,
    }))
    .filter(
      (c: any): c is { id: string; url: string } =>
        typeof c.id === "string" && /^[A-Za-z0-9_-]+$/.test(c.id) && typeof c.url === "string",
    );
  if (!clips.length) throw new Error("giphy search: no usable clips in response");

  mkdirSync(dir, { recursive: true });
  const have = new Set(readdirSync(dir));
  let added = 0;
  for (const clip of clips) {
    const name = `${clip.id}.gif`;
    if (have.has(name)) continue;
    const download = await get(clip.url);
    if (!download.ok) throw new Error(`giphy download ${clip.id}: HTTP ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    // tmp-then-rename so a crash mid-download never leaves half a gif for the TV.
    const tmp = join(dir, `.${name}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(dir, name));
    added++;
  }

  const keep = new Set(clips.map((c: { id: string }) => `${c.id}.gif`));
  let removed = 0;
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".gif") && !keep.has(file)) {
      rmSync(join(dir, file));
      removed++;
    }
  }
  return { total: keep.size, added, removed };
}
