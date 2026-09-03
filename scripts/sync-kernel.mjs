#!/usr/bin/env node
// sync-kernel — compiles nextwork-kernel assets into public/
//
// Reads from the kernel/ git submodule:
//   1. agent/visual/tokens/design-tokens.tailwind.css → public/kernel-tokens.gen.js
//      (every resolved --color-* token as a PixiJS integer 0xRRGGBB). Colors only —
//      fonts, type scale, radii and spacing stay app-local.
//   2. agent/visual/assets/logos/Paper lock up - full.svg → public/brand/, byte for
//      byte, with its sha256 stamped into the generated file.
//
// Usage:
//   npm run kernel:sync    # after bumping the kernel submodule; commit the result
//   npm run kernel:check   # exit 1 if anything committed drifted from the kernel
//
// The generated file and the vendored logo are COMMITTED — never hand-edit them;
// this script is the only writer. syncedAt is the kernel HEAD commit date (not
// wall clock) so --check is a deterministic string compare.
//
// The logo hash is the anti-invention gate: a redrawn, recoloured or re-typeset
// mark changes the bytes and fails --check. That only works if a mismatch exits 1
// (drift, "fix it") and never 2 (no kernel, "skip"), because the vitest gate
// treats exit 2 as a skip for contributors who cannot read the private kernel.
//
// Exit codes: 0 in sync / 1 drift, fix and commit / 2 no readable kernel submodule.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kernel = (p) => join(root, "kernel", p);
const OUT = join(root, "public", "kernel-tokens.gen.js");
/** Paper = the INK colour, so this is the lockup for DARK grounds. */
const LOGO_SRC = "agent/visual/assets/logos/Paper lock up - full.svg";
const LOGO_OUT = join(root, "public", "brand", "nextwork-lockup-on-dark.svg");
const check = process.argv.includes("--check");

/** No readable kernel: not the contributor's gate to pass, so the test skips. */
function noKernel(msg) {
  console.error(`[sync-kernel] FAIL: ${msg}`);
  process.exit(2);
}

/** Something committed disagrees with the kernel: fix it and commit. */
function drift(msg) {
  console.error(`[sync-kernel] ${msg}`);
  console.error("Run: npm run kernel:sync  (then commit the result).");
  process.exit(1);
}

/** Parse failures mean the kernel changed shape, not that the app drifted. */
const fail = noKernel;

if (!existsSync(kernel("agent/visual/tokens/design-tokens.tailwind.css"))) {
  noKernel("kernel submodule not initialised — run: git submodule update --init kernel");
}
if (!existsSync(kernel(LOGO_SRC))) {
  noKernel(`kernel submodule is missing ${LOGO_SRC}`);
}

// ── Parse colors ─────────────────────────────────────────────────────────────
const css = readFileSync(kernel("agent/visual/tokens/design-tokens.tailwind.css"), "utf8");
const raw = {};
for (const m of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|var\(--color-[a-z0-9-]+\))\s*;/g)) {
  raw[m[1]] = m[2];
}
if (Object.keys(raw).length < 50) fail(`only ${Object.keys(raw).length} color tokens parsed — CSS shape changed?`);
const colors = {};
for (const [name, value] of Object.entries(raw)) {
  let v = value;
  let hops = 0;
  while (v.startsWith("var(")) {
    const ref = v.match(/var\(--color-([a-z0-9-]+)\)/)?.[1];
    if (!ref || !(ref in raw)) fail(`unresolvable var ref for --color-${name}: ${v}`);
    v = raw[ref];
    if (++hops > 5) fail(`var() cycle at --color-${name}`);
  }
  colors[name] = v.toLowerCase();
}
// Every token the board's semantic layer (C in client.js) depends on.
const MUST_EXIST = [
  "paper", "leather", "warm-white",
  "brand-600", "brand-700", "brand-800", "brand-900",
  "surface-dark", "surface-dark-raised", "text-on-dark", "text-on-dark-muted",
  "accent-canary", "accent-emerald", "accent-pumpkin",
  "error-400", "plum-400", "information-400",
];
for (const must of MUST_EXIST) {
  if (!colors[must]) fail(`expected token missing: ${must}`);
}

// ── Meta + emit ──────────────────────────────────────────────────────────────
// The full 40-char sha, never `--short`: abbreviation length follows core.abbrev
// and git's own auto-scaling, so a contributor with core.abbrev=12 would
// regenerate a byte-different file and red the gate with zero color change.
// syncedAt is the kernel's commit date (not wall clock) so --check is a
// deterministic string compare.
let sha;
let syncedAt;
let version;
try {
  sha = execSync("git -C kernel rev-parse HEAD", { cwd: root }).toString().trim();
  syncedAt = execSync("git -C kernel show -s --format=%cs HEAD", { cwd: root }).toString().trim();
  // The parse reads the submodule working tree but the stamp names HEAD, so a
  // dirty submodule would publish colors that do not exist at that sha.
  execSync("git -C kernel diff --quiet HEAD", { cwd: root });
} catch (error) {
  fail(`kernel submodule is unreadable or has uncommitted changes: ${error.message}`);
}
try {
  const changelog = readFileSync(kernel("CHANGELOG.md"), "utf8");
  version = changelog.match(/^## (v[\d.]+)/m)?.[1] ?? "unknown";
} catch (error) {
  fail(`kernel CHANGELOG.md is unreadable: ${error.message}`);
}

// The logo travels as bytes, never as instructions to redraw it. Its hash goes
// into the generated file so the same byte-compare that guards the colors also
// guards the mark.
const logoBytes = readFileSync(kernel(LOGO_SRC));
const logoSha = createHash("sha256").update(logoBytes).digest("hex");

const next = `// GENERATED by scripts/sync-kernel.mjs — DO NOT EDIT BY HAND.
// Source: nextwork-kernel @ ${sha} (${version}), kernel commit date ${syncedAt}.
// Pixi wants integer colors, so #rrggbb becomes 0xrrggbb here in the generator.
// To update: bump the kernel/ submodule, then \`npm run kernel:sync\`.

export const KERNEL_META = ${JSON.stringify({ sha, version, syncedAt }, null, 2)};

// public/brand/nextwork-lockup-on-dark.svg, copied byte for byte from the kernel
// master named below. Verify: shasum -a 256 public/brand/nextwork-lockup-on-dark.svg
export const KERNEL_LOGO = ${JSON.stringify({ master: LOGO_SRC, sha256: logoSha }, null, 2)};

export const KERNEL = {
${Object.entries(colors)
  .map(([name, hex]) => `  "${name}": 0x${hex.slice(1)},`)
  .join("\n")}
};
`;

if (check) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (cur.trim() !== next.trim()) {
    drift("kernel-tokens.gen.js is OUT OF SYNC with the kernel submodule.");
  }
  // Exit 1, not 2: a mark that does not match the master is drift the committer
  // must fix, not a missing kernel the contributor may skip.
  if (!existsSync(LOGO_OUT)) {
    drift("public/brand/nextwork-lockup-on-dark.svg is MISSING.");
  }
  const vendoredSha = createHash("sha256").update(readFileSync(LOGO_OUT)).digest("hex");
  if (vendoredSha !== logoSha) {
    drift(
      `public/brand/nextwork-lockup-on-dark.svg does NOT match the kernel master.\n` +
        `  expected ${logoSha}\n  found    ${vendoredSha}\n` +
        `  The logo must be the kernel's bytes — never redrawn, recoloured or re-typeset.`,
    );
  }
  console.log(
    `[sync-kernel] in sync — ${Object.keys(colors).length} colors + logo ${logoSha.slice(0, 12)} ← kernel ${sha} (${version})`,
  );
} else {
  // Atomic: client.js imports this module, so a truncated write (Ctrl-C, full
  // disk) would take the whole board down rather than degrade it.
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, OUT);
  // The logo is copied, never transformed: same bytes in public/ as in the kernel.
  mkdirSync(dirname(LOGO_OUT), { recursive: true });
  const logoTmp = `${LOGO_OUT}.tmp`;
  writeFileSync(logoTmp, logoBytes);
  renameSync(logoTmp, LOGO_OUT);
  console.log(
    `[sync-kernel] OK — ${Object.keys(colors).length} colors → public/kernel-tokens.gen.js, logo ${logoSha.slice(0, 12)} → public/brand/ ← kernel ${sha} (${version})`,
  );
}
