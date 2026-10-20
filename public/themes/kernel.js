// The Kernel Theme: the board's everyday look, resolved from the brand kernel.
// Values come from kernel-tokens.gen.js only — no raw colors here (see
// test/kernel-tokens.test.ts).
import { KERNEL } from "../kernel-tokens.gen.js";

// Brand type, vendored in public/fonts. Display moments (>=54px: takeover
// banners, marquee title, MVP name, chime) get Suisse Neue with the kernel's
// display tracking; everything smaller is FK Grotesk Neue, untracked — the
// kernel hard-blocks letter-spacing on UI text.
const FONT_UI = '"FK Grotesk Neue", system-ui, sans-serif';
const FONT_DISPLAY = '"Suisse Neue", "FK Grotesk Neue", system-ui, sans-serif';

export default {
  // The board's semantic palette. Names stay arcade-local; values come from
  // kernel-tokens.gen.js only. The dark ground is the kernel's leather-warm dark
  // family — never blue-black. Accents follow the categorical convention; red and
  // plum ride the 400 rungs because their 500s fall under 4.5:1 against leather
  // at TV distance.
  palette: {
    bg: KERNEL["surface-dark"],
    panel: KERNEL["surface-dark-raised"],
    panelDeep: KERNEL["brand-900"],
    panelEdge: KERNEL["brand-700"],
    ink: KERNEL["text-on-dark"],
    dim: KERNEL["text-on-dark-muted"],
    amber: KERNEL["accent-canary"],
    green: KERNEL["accent-emerald"],
    red: KERNEL["error-400"],
    magenta: KERNEL["plum-400"],
    orange: KERNEL["accent-pumpkin"],
    info: KERNEL["information-400"],
    white: KERNEL["warm-white"],
    // Theme keys: spots where the two themes differ by role, not just by value.
    marqueeEdge: KERNEL["brand-700"],
    heroInk: KERNEL["text-on-dark"],
    pixelDim: KERNEL["brand-600"],
    titleShadow: KERNEL["surface-dark"],
    scanline: KERNEL["surface-dark"],
    scanlineAlpha: 0.3,
    // The marquee's own type, and Feed titles: the same paper as everywhere else
    // on this dark ground (they differ only in the Neobrutal Theme).
    marqueeInk: KERNEL["text-on-dark"],
    marqueeDim: KERNEL["text-on-dark-muted"],
    feedTitle: KERNEL["text-on-dark-muted"],
    // Pixel sprites are outlined in the ground color.
    spriteOutline: KERNEL["surface-dark"],
  },
  type: {
    family: (fontSize) => (fontSize >= 54 ? FONT_DISPLAY : FONT_UI),
    weight: "500",
    tracking: (fontSize) => (fontSize >= 54 ? Math.round(fontSize * -0.01) : 0),
    valueTracking: undefined,
    nameMax: 12,
  },
  // The brand faces client.js loads before any Text exists.
  preload: [
    '500 62px "Suisse Neue"',
    '500 24px "FK Grotesk Neue"',
    '400 24px "FK Grotesk Neue"',
  ],
  // undefined: index.html's leather letterbox stays.
  letterbox: undefined,
  sprites: {},
  decorations: {},
};
