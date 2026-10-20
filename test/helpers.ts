import { createHmac } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

/**
 * Shared plumbing for driving the server from outside: sign and POST webhooks,
 * connect a display, read a snapshot. Nothing here imports from src/. A deepened
 * module (src/clock.ts, say) is tested by importing it directly in its own
 * test/<module>.test.ts; the `startServer` tests stay the regression net.
 */

export const SECRET = "test-webhook-secret";
process.env.GITHUB_WEBHOOK_SECRET = SECRET;
// Every server also opens the Admin Console listener; on its default 3001, parallel
// test files would collide over it, so each one gets a free port instead.
process.env.ADMIN_PORT = "0";
// And the board itself listens on 127.0.0.1, the address every test connects to, not
// on every interface. On macOS a free port for the wildcard [::] can be one another
// test file's stub already holds on 127.0.0.1, and a connection to 127.0.0.1 then
// reaches that stub instead of this board: a 401 on a display's connect, a socket
// closed mid-request, another file's WUU numbers. Both on 127.0.0.1, the kernel never
// hands out a port that is taken.
process.env.LISTEN_HOST = "127.0.0.1";
// Backfill is backfill.test.ts's business (it sets its own token). Without a token
// no other test can reach the real GitHub API with whatever PAT the shell exported.
delete process.env.GITHUB_TOKEN;
// Likewise the WUU panel is wau.test.ts's business: no other server reads PostHog.
delete process.env.POSTHOG_PERSONAL_API_KEY;
// Every server reads Service Status from boot. No test reaches the internet: anything
// off loopback fails at once, so a server whose test never stubbed statusUrls reads its
// rows UNAVAILABLE instead of depending on (or waiting for) the real status pages.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const { hostname } = new URL(input instanceof Request ? input.url : input);
  return ["127.0.0.1", "localhost", "[::1]"].includes(hostname)
    ? realFetch(input, init)
    : Promise.reject(new Error(`a test reached for ${hostname}`));
};

export const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export const configPath = fileURLToPath(
  new URL("./fixtures/config.json", import.meta.url),
);

/** Path to a fixture config the server is expected to reject. */
export const badConfigPath = (file: string) =>
  fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url));

export const mergedBody = fixture("pull-request-merged.json");

export const sign = (body: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

export type PostOptions = {
  body?: string;
  event?: string;
  signature?: string;
  contentType?: string;
};

export const postWebhook = (
  port: number,
  {
    body = mergedBody,
    event = "pull_request",
    signature = sign(body),
    contentType = "application/json",
  }: PostOptions = {},
) =>
  fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: {
      ...(contentType ? { "content-type": contentType } : {}),
      "x-github-event": event,
      ...(signature ? { "x-hub-signature-256": signature } : {}),
    },
    // Uint8Array so fetch adds no Content-Type of its own when we omit it.
    body: new TextEncoder().encode(body),
  });

/** Connect a display, recording every protocol message from the moment it opens. */
export async function connectedDisplay(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: any[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  await once(ws, "open");
  return { ws, messages };
}

/** Connect a display and read the snapshot it is sent on connect. */
export async function readSnapshot(port: number) {
  const { ws, messages } = await connectedDisplay(port);
  await sleep(50);
  ws.close();
  return messages[0];
}

/** POST a webhook and collect the live messages the display received afterwards. */
export async function postAndWatch(port: number, options?: PostOptions) {
  const { ws, messages } = await connectedDisplay(port);

  const response = await postWebhook(port, options);
  await sleep(50);
  ws.close();
  // The snapshot sent on connect is asserted separately.
  return {
    status: response.status,
    received: messages.filter((message) => message.type !== "snapshot"),
  };
}
