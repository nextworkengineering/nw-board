/** Reading someone else's HTTP API: a body that can't grow without bound, and Retry-After. */

const UPSTREAM_MAX_BYTES = 1024 * 1024;

export async function limitedText(response: Response, complaint = "news feed exceeds 1 MiB") {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > UPSTREAM_MAX_BYTES) {
      await reader.cancel();
      throw new Error(complaint);
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * A Retry-After header — delay-seconds or an HTTP-date — as ms from `at`, for a
 * Monitor's backoff. Undefined when absent or unparseable; a date already past is 0.
 */
export function retryAfterMs(header: string | null, at = Date.now()) {
  if (!header) return undefined;
  const ms = /^\s*\d+\s*$/.test(header) ? Number(header) * 1000 : Date.parse(header) - at;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}
