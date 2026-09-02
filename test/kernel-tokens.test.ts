// Brand-kernel gates: the committed token file must match the kernel submodule,
// and no color may bypass it as a raw literal.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

test("committed kernel tokens match the kernel submodule", () => {
  // exit 1 = drift (npm run kernel:sync + commit), exit 2 = git submodule update --init kernel
  execFileSync("node", ["scripts/sync-kernel.mjs", "--check"], { cwd: root });
});

test("client.js carries no raw color literals outside the gen file", () => {
  const src = readFileSync(new URL("../public/client.js", import.meta.url), "utf8");
  expect(src.match(/0x[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
  expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
});

test("index.html's only color literal is the leather letterbox", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  expect(html.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual(["#1b1918", "#1b1918"]);
});
