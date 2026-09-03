# Brand assets

`nextwork-lockup-on-dark.svg` is the NextWork full lockup, copied **byte for byte**
from the brand kernel. Its master is:

    kernel/agent/visual/assets/logos/Paper lock up - full.svg

"Paper" names the **ink colour**, not the background: Paper files are filled
`#F8F5F0` and belong on dark grounds, Leather files are `#1B1918` and belong on
light ones. Reading it the other way gets you an invisible logo.

## Never hand-edit this file

The mark is fixed tier in the kernel: do not redraw, recolour, re-typeset,
stretch, rotate, add effects to, or box it. `scripts/sync-kernel.mjs` is the only
writer, and `npm run kernel:check` (part of `npm test`) fails with exit 1 if the
committed bytes stop matching the kernel master — that check exists specifically
to catch a logo that has been invented or edited rather than retrieved.

Verify by hand:

    shasum -a 256 public/brand/nextwork-lockup-on-dark.svg

To take a newer logo, bump the `kernel/` submodule and run `npm run kernel:sync`.

Note: this repo has no CI, and `deploy.sh` does not init submodules, so the gate
only runs when a human runs `npm test` with the kernel submodule present.
