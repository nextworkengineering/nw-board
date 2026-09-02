// Brand-kernel gate: the committed token file must match the kernel submodule.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

test("committed kernel tokens match the kernel submodule", () => {
  // exit 1 = drift (npm run kernel:sync + commit), exit 2 = git submodule update --init kernel
  execFileSync("node", ["scripts/sync-kernel.mjs", "--check"], { cwd: root });
});
