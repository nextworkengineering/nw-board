import { limitedText, retryAfterMs } from "./upstream.ts";

/**
 * Service Status: one read of the GitHub, Sentry and GCP status pages, for a Monitor to
 * run once a minute. Each service fails on its own: one status page down shows that
 * row UNAVAILABLE, not a failed read.
 */

export const STATUS_URLS = {
  github: "https://www.githubstatus.com/api/v2/status.json",
  sentry: "https://status.sentry.io/api/v2/status.json",
  gcp: "https://status.cloud.google.com/incidents.json",
};
// Cloud Run, Google Cloud Storage, Cloud Firestore — the GCP products we run on.
const GCP_PRODUCTS = ["9D7d2iNBQWN24zc1VamE", "UwaYoXQ5bHYHG6EdiPB8", "CETSkT92V21G6A1x28me"];
// GCP lists a worldwide incident under an explicit "global" location.
const GCP_REGIONS = ["us-central1", "us-east1", "us-west1", "global"];
const GCP_SEVERITY = ["low", "medium", "high"];

export type StatusLevel = "ok" | "minor" | "major" | "unknown";
export type ServiceStatus = { services: { name: string; level: StatusLevel; text: string }[] };

/** A Statuspage summary (GitHub, Sentry). Maintenance counts as minor, not ok. */
export function normalizeStatuspage(payload: any): { level: StatusLevel; text: string } {
  const { indicator, description } = payload?.status ?? {};
  if (typeof indicator !== "string" || typeof description !== "string")
    throw new Error("status page has no indicator");
  const level =
    indicator === "none"
      ? "ok"
      : indicator === "major" || indicator === "critical"
        ? "major"
        : "minor";
  // A healthy row reads the same for every service, and fits the narrow panel.
  return { level, text: level === "ok" ? "OPERATIONAL" : description.toUpperCase() };
}

/**
 * GCP's incident history, narrowed to open incidents on our products that reach our
 * regions. No current locations means the incident has recovered, so it does not count.
 */
export function normalizeGcpIncidents(payload: any): { level: StatusLevel; text: string } {
  if (!Array.isArray(payload)) throw new Error("GCP incidents is not a list");
  const relevant = payload.filter(
    (incident: any) =>
      !incident?.end &&
      incident?.affected_products?.some?.((product: any) => GCP_PRODUCTS.includes(product?.id)) &&
      incident?.currently_affected_locations?.some?.((location: any) =>
        GCP_REGIONS.includes(location?.id),
      ),
  );
  if (relevant.length === 0) return { level: "ok", text: "OPERATIONAL" };
  const rank = (incident: any) => GCP_SEVERITY.indexOf(incident.severity);
  const worst = relevant.reduce((a: any, b: any) => (rank(b) > rank(a) ? b : a));
  return {
    level: worst.severity === "high" ? "major" : "minor",
    text:
      typeof worst.status_impact === "string"
        ? worst.status_impact.replaceAll("_", " ")
        : "INCIDENT",
  };
}

/**
 * The reader. Destinations are fixed (tests point `urls` at stubs). A 429 is the one
 * failure that fails the whole read, carrying its Retry-After, so the Monitor backs off
 * and keeps the last good reading rather than asking again in a minute.
 * ponytail: one page rate-limiting holds all three rows at the last good reading; back
 * off per service if one page ever rate-limits on its own.
 */
export function statusReader({
  urls = {},
  timeoutMs = 5_000,
}: { urls?: Partial<typeof STATUS_URLS>; timeoutMs?: number } = {}) {
  const services = [
    { name: "GITHUB", url: urls.github ?? STATUS_URLS.github, normalize: normalizeStatuspage },
    { name: "SENTRY", url: urls.sentry ?? STATUS_URLS.sentry, normalize: normalizeStatuspage },
    { name: "GCP", url: urls.gcp ?? STATUS_URLS.gcp, normalize: normalizeGcpIncidents },
  ];
  const get = async (url: string) => {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429)
      throw Object.assign(new Error("returned 429"), {
        limited: true,
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      });
    if (!response.ok) throw new Error(`returned ${response.status}`);
    return JSON.parse(await limitedText(response, "status response exceeds 1 MiB"));
  };

  return async (): Promise<ServiceStatus> => {
    const results = await Promise.allSettled(
      services.map(async ({ url, normalize }) => normalize(await get(url))),
    );
    const limited = results.flatMap((result, i) =>
      result.status === "rejected" && result.reason?.limited
        ? [{ name: services[i].name, retryAfterMs: result.reason.retryAfterMs as number | undefined }]
        : [],
    );
    if (limited.length)
      throw Object.assign(
        new Error(`${limited.map(({ name }) => name).join(", ")} rate-limited the board (429)`),
        // The longest wait asked for; none named means just the next tick.
        { retryAfterMs: Math.max(0, ...limited.map(({ retryAfterMs = 0 }) => retryAfterMs)) },
      );
    return {
      services: results.map((result, i) => {
        const { name } = services[i];
        if (result.status === "fulfilled") return { name, ...result.value };
        console.warn(`${name} status unavailable: ${result.reason}`);
        return { name, level: "unknown", text: "UNAVAILABLE" };
      }),
    };
  };
}
