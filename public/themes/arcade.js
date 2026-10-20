// The Arcade Theme: the board's pre-reskin synthwave look, worn from a WUU
// Target Hit until local midnight. Same palette keys as the kernel theme, so
// every display object built from `C` picks these up unchanged. This is the one
// place outside kernel-tokens.gen.js that may hold raw colors — they are the old
// look by definition, not kernel tokens.

// The Arcade Theme's type: one monospace face, tracked wide, at every size.
const FONT_ARCADE = 'ui-monospace, "DejaVu Sans Mono", "Courier New", monospace';

export default {
  palette: {
    bg: 0x0b0b1a,
    panel: 0x141433,
    panelDeep: 0x1a0f2e,
    panelEdge: 0x2b2b6b,
    ink: 0x9fe8ff,
    dim: 0x5b6ba8,
    amber: 0xffe066,
    green: 0x66ddaa,
    red: 0xff5c7a,
    magenta: 0xff7ce5,
    orange: 0xff9a3c,
    info: 0x9fe8ff,
    white: 0xffffff,
    // The hero spots the kernel reskin took magenta out of: marquee border, typed
    // title, chime headline.
    marqueeEdge: 0xff7ce5,
    heroInk: 0xff7ce5,
    pixelDim: 0x3a3a6a,
    titleShadow: 0x9fe8ff,
    scanline: 0x000000,
    scanlineAlpha: 0.22,
    marqueeInk: 0x9fe8ff,
    marqueeDim: 0x5b6ba8,
    feedTitle: 0x5b6ba8,
    spriteOutline: 0x0b0b1a,
  },
  type: {
    family: () => FONT_ARCADE,
    weight: "normal",
    tracking: () => 2,
    // Untracked in the Arcade Theme too: tracked monospace runs "2.4k" wider than
    // its 38px bar and into the neighbour's value.
    valueTracking: 0,
    // Tracked monospace fits one character fewer before the Feed's time column.
    nameMax: 11,
  },
  // The Arcade Theme never uses the brand faces, so it skips the font wait.
  preload: [],
  // The arcade letterbox was black, painted over index.html's leather.
  letterbox: "black",
  sprites: {
    // The Arcade Theme's crown on the logo. A transparent border, because
    // pixelTexture only outlines inside the grid: without it the outer edge of the
    // art would get no dark outline.
    crown: [
      "...............",
      ".w.....w.....w.",
      ".yy...yyy...yy.",
      ".yyy.yyyyy.yyy.",
      ".yyyyyyyyyyyyy.",
      ".ymyyyyryyyygy.",
      ".yyyyyyyyyyyyy.",
      ".ooooooooooooo.",
      "...............",
    ],
  },
  decorations: { crown: true },
};
