import { createHmac } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

/**
 * Shared plumbing for driving the server from outside: sign and POST webhooks,
 * connect a display, read a snapshot. Nothing here imports from src/ — the test
 * files own the one seam (`startServer`).
 */

export const SECRET = "test-webhook-secret";
process.env.GITHUB_WEBHOOK_SECRET = SECRET;
// Backfill is backfill.test.ts's business (it sets its own token). Without a token
// no other test can reach the real GitHub API with whatever PAT the shell exported.
delete process.env.GITHUB_TOKEN;

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
