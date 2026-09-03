// Brand-kernel gates: the committed token file must match the kernel submodule,
// and no color may bypass it as a raw literal.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

test("committed kernel tokens match the kernel submodule", () => {
  try {
    execFileSync("node", ["scripts/sync-kernel.mjs", "--check"], { cwd: root });
  } catch (error: any) {
    // Exit 2 is "no readable kernel submodule". The kernel is a private repo, so
    // a contributor without access cannot init it and this gate is not theirs to
    // pass — skip rather than fail them forever. Exit 1 is real drift: resync
    // and commit the regenerated file.
    if (error?.status === 2) {
      console.warn("skipping kernel sync gate: no readable kernel submodule");
      return;
    }
    throw error;
  }
});

test("client.js carries no raw color literals outside the gen file", () => {
  const src = readFileSync(new URL("../public/client.js", import.meta.url), "utf8");
  expect(src.match(/0x[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
  expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
});

test("the index.html letterbox matches the kernel's leather token", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const gen = readFileSync(new URL("../public/kernel-tokens.gen.js", import.meta.url), "utf8");
  // Pin the hand-typed letterbox to the generated token rather than to itself,
  // so a kernel change to leather cannot leave it silently wrong.
  const leather = gen.match(/"leather":\s*0x([0-9a-f]{6})/)?.[1];
  expect(leather).toBeDefined();
  const literals = html.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  expect(literals.length).toBeGreaterThan(0);
  for (const literal of literals) expect(literal.toLowerCase()).toBe(`#${leather}`);
});
