// PR Arcade display client.
//
// Art and audio are generated in the browser rather than fetched: pixel sprites are
// drawn as 8x8 Graphics, baked once into RenderTextures at one texture pixel per art
// pixel and upscaled with nearest-neighbour filtering (that's the chunky look), and
// the 8-bit jingles are WebAudio square/triangle oscillators plus a noise buffer.
// Nothing reaches beyond the Pi's disk: the only fetched assets are the brand
// fonts vendored in public/fonts, served by the same express.static as everything else.
//
// PixiJS is served from public/vendor, a symlink to node_modules/pixi.js/dist that the
// existing express.static already covers, so the kiosk never reaches a CDN and works
// with the network down. `npm ci` (install and deploy both run it) provides the target.
import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
} from "./vendor/pixi.min.mjs";
import { play, playAmbient, resumeAudio } from "./audio.js";
import { KERNEL } from "./kernel-tokens.gen.js";

// The scene is authored at 1080p and scaled to fit whatever the TV reports, so the
// layout is fixed numbers rather than a responsive system nobody will ever resize.
const W = 1920;
const H = 1080;

// The board's semantic palette, resolved from the brand kernel. Names stay
// arcade-local; values come from kernel-tokens.gen.js only. The dark ground is
// the kernel's leather-warm dark family — never blue-black. Accents follow the
// categorical convention; red and plum ride the 400 rungs because their 500s
// fall under 4.5:1 against leather at TV distance.
const C = {
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
};

// Brand type, vendored in public/fonts. Display moments (>=54px: takeover
// banners, marquee title, MVP name, chime) get Suisse Neue with the kernel's
// display tracking; everything smaller is FK Grotesk Neue, untracked — the
// kernel hard-blocks letter-spacing on UI text.
const FONT_UI = '"FK Grotesk Neue", system-ui, sans-serif';
const FONT_DISPLAY = '"Suisse Neue", "FK Grotesk Neue", system-ui, sans-serif';
const label = (text, fontSize, fill, extra) => {
  const display = fontSize >= 54;
  return new Text({
    text,
    style: {
      fontFamily: display ? FONT_DISPLAY : FONT_UI,
      fontWeight: "500",
      fontSize,
      fill,
      letterSpacing: display ? Math.round(fontSize * -0.01) : 0,
      ...extra,
    },
  });
};

const EVENTS = {
  "pr-merged": { name: "MERGED", color: C.amber, icon: "trophy" },
  "review-approved": { name: "APPROVED", color: C.green, icon: "check" },
  "pr-opened": { name: "OPENED", color: C.info, icon: "rocket" },
  "pr-closed": { name: "CLOSED", color: C.dim, icon: "crate" },
  "changes-requested": { name: "CHANGES", color: C.red, icon: "bang" },
  "pr-comment": { name: "COMMENT", color: C.magenta, icon: "bubble" },
};
const CELEBRATIONS = new Set(["pr-merged", "review-approved"]);

// Pixi bakes glyphs when a Text is constructed, and canvas text never triggers
// lazy @font-face loading on its own — so load the brand faces explicitly before
// any Text exists. Never let a missing file hang the kiosk: after 3s the
// system-ui fallbacks in the FONT stacks take over and the board boots anyway.
try {
  await Promise.race([
    Promise.all([
      document.fonts.load('500 62px "Suisse Neue"'),
      document.fonts.load('500 24px "FK Grotesk Neue"'),
      document.fonts.load('400 24px "FK Grotesk Neue"'),
    ]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("font timeout")), 3000)),
  ]);
} catch {
  // Fallback type beats a dark TV.
}

// antialias off keeps the pixel art crisp and is one less thing for the Pi's GPU to do.
const app = new Application();
// Always render at the 1080p design resolution, whatever the TV negotiated — a 4K
// window would quadruple the pixels the Pi pushes per frame, which lands it under
// Pixi's 10fps clock clamp and everything plays in slow motion. The finished 2MP
// frame is scaled to the screen by CSS instead; `pixelated` keeps the chunky look.
await app.init({ background: C.bg, antialias: false, width: W, height: H, resolution: 1 });
document.body.appendChild(app.canvas);
app.canvas.style.position = "absolute";
app.canvas.style.imageRendering = "pixelated";

const world = new Container();
app.stage.addChild(world);
function fitToWindow() {
  const scale = Math.min(innerWidth / W, innerHeight / H);
  app.canvas.style.width = `${W * scale}px`;
  app.canvas.style.height = `${H * scale}px`;
  app.canvas.style.left = `${(innerWidth - W * scale) / 2}px`;
  app.canvas.style.top = `${(innerHeight - H * scale) / 2}px`;
}
addEventListener("resize", fitToWindow);
fitToWindow();

// ?fps: an on-TV diagnostic — frame rate plus which renderer WebGL actually got.
// "V3D" means the Pi's GPU is doing the work; "SwiftShader"/"llvmpipe" means
// software rendering and explains any slow motion better than guessing.
if (location.search.includes("fps")) {
  let rendererName = "unknown";
  try {
    const gl = app.renderer.gl;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    rendererName = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "no-gl";
  } catch {
    rendererName = "webgpu";
  }
  const fpsText = label("", 26, C.green);
  fpsText.position.set(8, 8);
  fpsText.zIndex = 1000;
  app.stage.addChild(fpsText);
  setInterval(() => {
    fpsText.text = `${app.ticker.FPS.toFixed(0)} FPS — ${rendererName}`;
  }, 500);
}

// Draw order: background, panels, ambient effects, then celebration takeovers on top.
const layers = {
  back: new Container(),
  board: new Container(),
  fx: new Container(),
  takeover: new Container(),
};
for (const layer of Object.values(layers)) world.addChild(layer);

// --------------------------------------------------------------------------------
// Pixel art. Each sprite is an 8x8 grid of palette letters; '.' is transparent.
// --------------------------------------------------------------------------------

const PX = {
  w: C.white,
  y: C.amber,
  o: C.orange,
  g: C.green,
  b: C.ink,
  r: C.red,
  m: C.magenta,
  d: KERNEL["brand-600"],
  k: C.bg,
};

const SPRITES = {
  trophy: [
    ".yyyyyy.",
    "oyyyyyyo",
    "oyyyyyyo",
    ".yyyyyy.",
    "..yyyy..",
    "...yy...",
    "..oooo..",
    ".oooooo.",
  ],
  // Keep the ink one pixel clear of the 8x8 edge: a stroke that reaches the grid
  // boundary ends in a flat wall instead of a tip, and at the approval takeover's
  // 12-24x slam scale that wall reads as the sprite being cropped.
  check: [
    "........",
    ".....gg.",
    "....gg..",
    ".g.gg...",
    ".ggg....",
    "..gg....",
    "..g.....",
    "........",
  ],
  rocket: [
    "........",
    "...wwww.",
    "..wwwwww",
    "orwwbwww",
    "orwwbwww",
    "..wwwwww",
    "...wwww.",
    "........",
  ],
  crate: [
    "dddddddd",
    "dwwwwwwd",
    "dwddddwd",
    "dwddddwd",
    "dwddddwd",
    "dwddddwd",
    "dwwwwwwd",
    "dddddddd",
  ],
  // A tapered bar over a square dot: reads as "!" even at 32px.
  bang: [
    "..rrrr..",
    "..rwrr..",
    "..rrrr..",
    "...rr...",
    "...rr...",
    "........",
    "...rr...",
    "...rr...",
  ],
  bubble: [
    ".mmmmmm.",
    "mwwwwwwm",
    "mwkwkwkm",
    "mwwwwwwm",
    ".mmmmmm.",
    "..mm....",
    ".m......",
    "........",
  ],
  star: [
    "...ww...",
    "...ww...",
    ".wwwwww.",
    "wwwwwwww",
    "wwwwwwww",
    ".wwwwww.",
    "...ww...",
    "...ww...",
  ],
  coin: [
    "..yyyy..",
    ".yooooy.",
    "yoyyyyoy",
    "yoyooyoy",
    "yoyooyoy",
    "yoyyyyoy",
    ".yooooy.",
    "..yyyy..",
  ],
  // 16x16 takeover-grade art: at slam scale an 8x8 art pixel is a ~2cm blob on the
  // TV, so the two sprites that get blown up carry four times the detail.
  trophy16: [
    "................",
    "..wyyyyyyyyyyw..",
    ".oyyyyyyyyyyyyo.",
    ".oyywyyyyyywyyo.",
    ".oyywyyyyyywyyo.",
    ".oyyyyyyyyyyyyo.",
    "..oyyyyyyyyyyo..",
    "...oyyyyyyyyo...",
    "....oyyyyyyo....",
    "......yyyy......",
    ".......yy.......",
    ".......yy.......",
    "......oyyo......",
    "....oooyyooo....",
    "...oooooooooo...",
    "................",
  ],
  check16: [
    "................",
    "..............g.",
    ".............gg.",
    "............ggg.",
    "...........ggg..",
    "..........ggg...",
    ".........ggg....",
    ".g......ggg.....",
    ".gg....gggg.....",
    ".ggg..ggg.......",
    "..ggggggg.......",
    "...ggggg........",
    "....ggg.........",
    ".....g..........",
    "................",
    "................",
  ],
};

// Textures are baked once and shared by every sprite that uses them; nothing in an
// animation ever generates a texture.
const textures = new Map();
function texture(name, draw) {
  let cached = textures.get(name);
  if (!cached) {
    const graphics = new Graphics();
    draw(graphics);
    cached = app.renderer.generateTexture({ target: graphics, resolution: 1 });
    cached.source.scaleMode = "nearest";
    graphics.destroy();
    textures.set(name, cached);
  }
  return cached;
}

// Sprites are baked as exact texels on a tiny canvas — Graphics rasterization
// antialiases 1px rects and everything downstream magnifies the mush. A dark
// outline pass (the classic arcade trick) makes every sprite pop off the board.
function pixelTexture(name) {
  let cached = textures.get(name);
  if (cached) return cached;
  const rows = SPRITES[name];
  const canvas = document.createElement("canvas");
  canvas.width = rows[0].length;
  canvas.height = rows.length;
  const ctx = canvas.getContext("2d");
  const inked = (x, y) => PX[rows[y]?.[x]] !== undefined;
  rows.forEach((row, y) =>
    [...row].forEach((char, x) => {
      if (PX[char] !== undefined) {
        ctx.fillStyle = `#${PX[char].toString(16).padStart(6, "0")}`;
        ctx.fillRect(x, y, 1, 1);
      }
    }),
  );
  ctx.fillStyle = `#${C.bg.toString(16).padStart(6, "0")}`;
  rows.forEach((row, y) =>
    [...row].forEach((char, x) => {
      if (
        PX[char] === undefined &&
        [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inked(x + dx, y + dy))
      )
        ctx.fillRect(x, y, 1, 1);
    }),
  );
  cached = Texture.from(canvas);
  cached.source.scaleMode = "nearest";
  textures.set(name, cached);
  return cached;
}

const dotTexture = () => texture("dot", (g) => g.rect(0, 0, 2, 2).fill(C.white));
const ringTexture = () =>
  texture("ring", (g) => g.circle(20, 20, 18).stroke({ width: 3, color: C.white }));

/** A pixel sprite, sized in art pixels: scale 6 means each art pixel is 6 screen px. */
function pixelSprite(name, scale = 6, tint) {
  const sprite = new Sprite(pixelTexture(name));
  sprite.anchor.set(0.5);
  sprite.scale.set(scale);
  if (tint !== undefined) sprite.tint = tint;
  return sprite;
}

// --------------------------------------------------------------------------------
// Background: CRT-flavoured. Static starfield + grid baked into two Graphics, plus
// scanlines and one slow roll band that move — the only per-frame background work.
// --------------------------------------------------------------------------------

function buildBackground() {

  const stars = new Graphics();
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    stars.rect(x, y, 2, 2).fill({ color: C.ink, alpha: 0.08 + Math.random() * 0.2 });
  }
  layers.back.addChild(stars);

  const grid = new Graphics();
  for (let x = 0; x <= W; x += 60) grid.moveTo(x, 0).lineTo(x, H);
  for (let y = 0; y <= H; y += 60) grid.moveTo(0, y).lineTo(W, y);
  grid.stroke({ width: 1, color: C.panelEdge, alpha: 0.18 });
  layers.back.addChild(grid);

  // Scanlines: 270 dark rows in one static Graphics, drawn over the board so the
  // panels get the CRT texture too.
  const scanlines = new Graphics();
  // Leather rather than black: dimming toward the ground color keeps every
  // darkened pixel in the warm family. Leather is lighter, so the alpha rises.
  for (let y = 0; y < H; y += 4) scanlines.rect(0, y, W, 2);
  scanlines.fill({ color: C.bg, alpha: 0.3 });
  scanlines.eventMode = "none";
  world.addChild(scanlines);

  const roll = new Sprite(dotTexture());
  roll.width = W;
  roll.height = 90;
  roll.alpha = 0.035;
  roll.eventMode = "none";
  world.addChild(roll);
  return roll;
}
const rollBand = buildBackground();

/** A panel: the arcade cabinet bezel every part of the board sits in. */
function panel(x, y, width, height, title, titleColor) {
  const box = new Container();
  box.position.set(x, y);
  const frame = new Graphics()
    .roundRect(0, 0, width, height, 10)
    .fill({ color: C.panel, alpha: 0.85 })
    .stroke({ width: 4, color: C.panelEdge });
  box.addChild(frame);
  const bar = new Graphics()
    .roundRect(0, 0, width, 56, 10)
    .fill({ color: C.panelEdge, alpha: 0.55 });
  box.addChild(bar);
  const heading = label(title, 34, titleColor);
  heading.position.set(20, 12);
  box.addChild(heading);
  layers.board.addChild(box);
  return box;
}

// --------------------------------------------------------------------------------
// Marquee: Today's MVP, above everything, with chasing bulbs.
// --------------------------------------------------------------------------------

const marquee = new Container();
marquee.position.set(24, 16);
layers.board.addChild(marquee);
marquee.addChild(
  new Graphics()
    .roundRect(0, 0, 1872, 168, 14)
    .fill({ color: C.panelDeep })
    .stroke({ width: 5, color: C.panelEdge }),
);

// Paper on dark, not an accent: the hero recedes into the cabinet and lets the
// canary bulbs and MVP name carry the marquee's 5% of color.
const title = label("NEXTWORK ARCADE", 62, C.ink, {
  dropShadow: { color: C.bg, distance: 4, blur: 0, angle: Math.PI / 4, alpha: 0.9 },
});
title.position.set(48, 52);
marquee.addChild(title);

const insertCoin = label("INSERT PULL REQUEST", 24, C.dim);
insertCoin.position.set(52, 118);
marquee.addChild(insertCoin);

const mvpCaption = label("TODAY'S MVP", 38, C.ink);
mvpCaption.anchor.set(1, 0);
mvpCaption.position.set(1824, 26);
marquee.addChild(mvpCaption);

// The name is right-anchored so it grows leftwards; the tally sits under its tail.
const mvpName = label("ANYONE'S GAME", 64, C.dim);
mvpName.anchor.set(1, 0);
mvpName.position.set(1824, 72);
marquee.addChild(mvpName);

const mvpTally = label("", 38, C.dim);
mvpTally.anchor.set(1, 1);
// Bottom-aligned with the name's baseline, clear of the marquee's lower border.
mvpTally.position.set(1824, 138);
marquee.addChild(mvpTally);

const bulbs = Array.from({ length: 44 }, (_, i) => {
  const bulb = new Sprite(pixelTexture("star"));
  bulb.anchor.set(0.5);
  bulb.scale.set(1.4);
  bulb.tint = C.amber;
  const half = 22;
  const top = i < half;
  bulb.position.set(40 + (i % half) * 84, top ? 10 : 158);
  marquee.addChild(bulb);
  return bulb;
});

// The real NextWork lockup takes the hero slot once it loads. The file is the
// kernel's own master, copied byte for byte and hash-pinned by
// scripts/sync-kernel.mjs, because the mark is never redrawn, recoloured or
// re-typeset — the wordmark in it is outlined paths, not text in a font.
//
// 66px is the tallest the lockup can be here: the brand rule is clear space of
// half the roundel's height on every side, the roundel spans the lockup's full
// height, and the bulb rows sit at y 4.4-15.6 and y 152.4-163.6. Centred on the
// bulb midpoint (84), that caps the height at 68.4.
const LOGO_HEIGHT = 66;
Assets.load({
  src: "/brand/nextwork-lockup-on-dark.svg",
  // Rasterise at an exact half of the master (gcd(1168,242) = 2, so the aspect
  // stays bit-identical). The sprite draws ~318px wide, so rasterising at the
  // full 1168 would minify 3.7:1 through a two-tap filter and mush the roundel's
  // ~2px negative-space gaps.
  data: { width: 584, height: 121 },
})
  .then((texture) => {
    // Must be set before the texture first renders.
    texture.source.autoGenerateMipmaps = true;
    const logo = new Sprite(texture);
    logo.anchor.set(0, 0.5);
    // One scalar, so the scale cannot go non-uniform: stretching the mark is a
    // hard block, and setting width and height separately invites exactly that.
    logo.scale.set(LOGO_HEIGHT / texture.height);
    logo.position.set(48, 84);
    marquee.addChild(logo);
    title.visible = false;
    // Clear of the logo's right-hand clear space, which ends at 399.5.
    insertCoin.anchor.set(0, 0.5);
    insertCoin.position.set(412, 84);
  })
  .catch(() => {
    // No logo on disk: the typed title stays exactly where it is. A missing file
    // must never leave the hero empty on a TV with no keyboard.
  });

// --------------------------------------------------------------------------------
// Feed panel: the last 24h of tracked events, newest at the top.
// --------------------------------------------------------------------------------

const FEED_ROWS = 7;
const feedPanel = panel(24, 204, 1872, 496, "LIVE FEED // LAST 24H", C.ink);

// Wall clock on the feed header — the board doubles as the office clock.
const wallClock = label("", 34, C.ink);
wallClock.anchor.set(1, 0);
wallClock.position.set(1852, 12);
feedPanel.addChild(wallClock);
setInterval(() => {
  const t = new Date()
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
    .toUpperCase();
  if (wallClock.text !== t) wallClock.text = t;
}, 1000);
// The last human to deploy to dev, centred on the header: the board answers
// "who put that on dev?" without anyone opening GitHub.
const devDeployLabel = label("", 34, C.green);
devDeployLabel.anchor.set(0.5, 0);
devDeployLabel.position.set(936, 12);
feedPanel.addChild(devDeployLabel);
/** {actor, at} from the snapshot, or null when nobody on the roster has deployed. */
function setDevDeploy(devDeploy) {
  // First name only, like the marquee: the header has one line.
  devDeployLabel.text = devDeploy
    ? `IN DEV: ${String(devDeploy.actor).split(" ")[0].toUpperCase()}`
    : "";
}

const feedEmpty = label("...WAITING FOR PLAYERS...", 30, C.dim);
feedEmpty.position.set(24, 90);
feedPanel.addChild(feedEmpty);

// One row object per line, reused forever: a feed render retints and retexts them
// rather than building and throwing away 14 rows of display objects.
const feedRows = Array.from({ length: FEED_ROWS }, (_, i) => {
  const row = new Container();
  row.position.set(20, 84 + i * 54);
  row.visible = false;
  const icon = pixelSprite("star", 4);
  icon.position.set(24, 22);
  const kind = label("", 28, C.ink);
  kind.position.set(56, 8);
  // First names are short, so the name and time sit tight together and the
  // title gets everything to the right of the repo pill.
  // Columns sized for the 28px register: APPROVED (the widest kind) ends near
  // x196, so the name column starts at 240 with air to spare.
  const who = label("", 28, C.ink);
  who.position.set(240, 8);
  // Right-anchored: FK Grotesk's digits are proportional, so a left-anchored
  // HH:MM column wanders by up to 30px across twelve rows. Anchoring right puts
  // the ragged edge where the eye is not tracking a column.
  const time = label("", 28, C.dim);
  time.anchor.set(1, 0);
  time.position.set(556, 8);
  // Repo pill: a small rounded chip redrawn per render (width follows the text).
  const pillBg = new Graphics();
  const pillText = label("", 20, C.dim);
  const pill = new Container();
  pill.position.set(580, 6);
  pill.addChild(pillBg, pillText);
  const title = label("", 28, C.dim);
  title.position.set(0, 8); // x set per render, after the pill
  row.addChild(icon, kind, who, time, pill, title);
  feedPanel.addChild(row);
  return { row, icon, kind, who, time, pillBg, pillText, pill, title };
});

// --------------------------------------------------------------------------------
// Weekly WAU: four dashboard KPIs and new WAU per day for this week vs last week.
// --------------------------------------------------------------------------------

const wauPanel = panel(24, 712, 1872, 248, "WEEKLY WAU GROWTH", C.ink);
const wauStatus = label("LOADING...", 24, C.dim);
wauStatus.anchor.set(1, 0);
wauStatus.position.set(1852, 16);
wauPanel.addChild(wauStatus);

function wauCard(x, y, title) {
  const card = new Container();
  card.position.set(x, y);
  card.addChild(
    new Graphics()
      .roundRect(0, 0, 430, 72, 7)
      .fill({ color: C.panelDeep, alpha: 0.72 })
      .stroke({ width: 2, color: C.panelEdge }),
  );
  const caption = label(title, 18, C.dim);
  caption.position.set(14, 8);
  const value = label("—", 36, C.ink);
  value.position.set(14, 29);
  card.addChild(caption, value);
  wauPanel.addChild(card);
  return value;
}

const wauValues = {
  currentWau: wauCard(20, 68, "CURRENT WAU"),
  targetWau: wauCard(464, 68, "WEEKLY TARGET"),
  targetPercent: wauCard(20, 150, "TARGET REACHED"),
  activationPercent: wauCard(464, 150, "ACTIVATION RATE"),
};

const wauChart = new Container();
wauChart.position.set(930, 68);
wauPanel.addChild(wauChart);
const chartTitle = label("NEW WAU / DAY", 20, C.dim);
wauChart.addChild(chartTitle);
const currentLegend = label("● THIS WEEK", 18, C.green);
currentLegend.position.set(500, 2);
wauChart.addChild(currentLegend);
const previousLegend = label("● LAST WEEK", 18, C.info);
previousLegend.position.set(338, 2);
wauChart.addChild(previousLegend);
const chartLines = new Graphics();
wauChart.addChild(chartLines);
const dayLabels = Array.from({ length: 7 }, (_, index) => {
  const day = label(`D${index + 1}`, 16, C.dim);
  day.anchor.set(0.5, 0);
  wauChart.addChild(day);
  return day;
});
const barValues = [0, 1].map(() =>
  Array.from({ length: 7 }, () => {
    const value = label("", 14, C.dim);
    value.anchor.set(0.5, 0);
    wauChart.addChild(value);
    return value;
  }),
);
const compact = (n) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
    .format(n)
    .toLowerCase();
const wauUnavailable = label("WAU DATA UNAVAILABLE — RETRYING", 24, C.dim);
wauUnavailable.anchor.set(0.5);
wauUnavailable.position.set(1378, 154);
wauPanel.addChild(wauUnavailable);

let latestWau = null;
function renderWau(data, stale = false) {
  latestWau = data;
  const snapshot = data;
  wauUnavailable.visible = !snapshot;
  wauChart.visible = Boolean(snapshot);
  for (const value of Object.values(wauValues)) value.text = "—";
  if (!snapshot) {
    wauStatus.text = "UNAVAILABLE // RETRYING";
    wauStatus.style.fill = C.red;
    return;
  }

  const whole = new Intl.NumberFormat().format;
  wauValues.currentWau.text = whole(snapshot.currentWau);
  wauValues.targetWau.text = whole(snapshot.targetWau);
  wauValues.targetPercent.text = `${snapshot.targetPercent}%`;
  wauValues.activationPercent.text = `${snapshot.activationPercent}%`;
  const updated = new Date(snapshot.fetchedAt)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
    .toUpperCase();
  wauStatus.text = stale ? `STALE // ${updated} // RETRYING` : `UPDATED ${updated}`;
  wauStatus.style.fill = stale ? C.red : C.green;

  const plot = { x: 8, y: 38, width: 900, height: 96 };
  const max = Math.max(
    1,
    ...snapshot.daily.flatMap((point) => [point.current, point.previous]),
  );
  const groupWidth = plot.width / 7;
  const barWidth = 38;
  const x = (index) => plot.x + groupWidth * (index + 0.5);
  const y = (value) => plot.y + plot.height - (value / max) * plot.height;
  chartLines
    .clear()
    .moveTo(plot.x, plot.y + plot.height)
    .lineTo(plot.x + plot.width, plot.y + plot.height)
    .stroke({ width: 2, color: C.panelEdge })
    .moveTo(plot.x, plot.y + plot.height / 2)
    .lineTo(plot.x + plot.width, plot.y + plot.height / 2)
    .stroke({ width: 1, color: C.panelEdge, alpha: 0.5 });
  for (const [row, [key, color, offset]] of [
    ["previous", C.info, -barWidth],
    ["current", C.green, 0],
  ].entries()) {
    snapshot.daily.forEach((point, index) => {
      const top = y(point[key]);
      chartLines.rect(x(index) + offset, top, barWidth, plot.y + plot.height - top).fill(color);
      const value = barValues[row][index];
      value.text = compact(point[key]);
      value.style.fill = color;
      value.position.set(x(index) + offset + barWidth / 2, plot.y + plot.height + 4);
    });
  }
  dayLabels.forEach((day, index) => {
    day.text = (snapshot.daily[index].label ?? `D${index + 1}`).slice(0, 3).toUpperCase();
    day.position.set(x(index), plot.y + plot.height + 22);
  });
}

const WAU_REFRESH_MS = 15 * 60 * 1000;
async function loadWau() {
  try {
    const response = await fetch("/wau.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`WAU dashboard returned ${response.status}`);
    const next = await response.json();
    if (
      ![next.currentWau, next.targetWau, next.targetPercent, next.activationPercent].every(
        Number.isFinite,
      ) ||
      !Array.isArray(next.daily) ||
      next.daily.length !== 7
    )
      throw new Error("invalid WAU dashboard data");
    renderWau(next);
  } catch (error) {
    console.warn(error);
    renderWau(latestWau, true);
  }
}

// --------------------------------------------------------------------------------
// AI News ticker: RSS headlines loop forever across a strip at the bottom.
// --------------------------------------------------------------------------------

const TICKER_Y = 968;
const TICKER_H = 96;
const TICKER_GAP = 110;
const TICKER_SPEED = 0.09; // px per ms — a lap of one 1920px screen every ~21s

// Framed like the marquee and the Feed panel: same side margins, same border.
const tickerStrip = new Container();
tickerStrip.addChild(
  new Graphics()
    .roundRect(24, TICKER_Y, 1872, TICKER_H, 10)
    .fill({ color: C.panel, alpha: 0.92 })
    .stroke({ width: 4, color: C.panelEdge }),
);
const tickerContent = new Container();
// The scroll is clipped to the frame so segments don't poke into the margins.
const tickerMask = new Graphics().roundRect(26, TICKER_Y, 1868, TICKER_H, 10).fill(C.white);
tickerStrip.addChild(tickerMask, tickerContent);
tickerContent.mask = tickerMask;
layers.board.addChild(tickerStrip);

/** One pass of the loop: an AI NEWS marker, then every headline as a segment. */
function tickerSequence(headlines) {
  const seq = new Container();
  let x = 0;
  const put = (child) => {
    child.position.x = x;
    seq.addChild(child);
    x += child.width + TICKER_GAP;
  };
  const marker = label("★ AI NEWS ★", 32, C.green);
  marker.position.y = TICKER_Y + 32;
  put(marker);
  if (!headlines.length) {
    const none = label("AI NEWS UNAVAILABLE — RETRYING", 32, C.dim);
    none.position.y = TICKER_Y + 32;
    put(none);
  }
  for (const headline of headlines) {
    const item = new Container();
    const bullet = label("◆", 32, C.amber);
    bullet.position.y = TICKER_Y + 32;
    const text = label(clip(headline, 100), 32, C.ink);
    text.position.set(bullet.width + 24, TICKER_Y + 32);
    item.addChild(bullet, text);
    put(item);
  }
  return { seq, width: x };
}

// --------------------------------------------------------------------------------
// Board state and rendering.
// --------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
let feed = [];

// The server only expires the Feed when it builds a snapshot, so a display left
// connected for days has to drop its own stale entries. Snapshot entries carry the
// server time they happened at; a live event is happening right now.
const stamp = (event) => ({ ...event, at: event.at ?? Date.now() });

const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Set `full` on a Text, trimmed with an ellipsis until it actually fits.
 * Measured rather than estimated: with a proportional font a per-glyph guess is
 * wrong in both directions — it wastes a fifth of a column of narrow text, and
 * overruns the panel on wide text. Only runs on a feed render, never per frame.
 */
function fitText(target, full, maxWidth) {
  target.text = full;
  if (target.width <= maxWidth) return;
  let lo = 0;
  let hi = full.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    target.text = `${full.slice(0, mid)}…`;
    if (target.width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  target.text = `${full.slice(0, lo)}…`;
}
const clock = (at) => new Date(at).toTimeString().slice(0, 5);

function renderFeed() {
  feed = feed.filter((entry) => Date.now() - entry.at < DAY_MS);
  feedEmpty.visible = feed.length === 0;
  for (let i = 0; i < FEED_ROWS; i++) {
    const entry = feed[feed.length - 1 - i];
    const { row, icon, kind, who, time, pillBg, pillText, pill, title } = feedRows[i];
    row.visible = Boolean(entry);
    if (!entry) continue;
    const style = EVENTS[entry.type] ?? { name: entry.type, color: C.dim, icon: "star" };
    icon.texture = pixelTexture(style.icon);
    kind.text = style.name;
    kind.style.fill = style.color;
    // Clipped to the characters that fit each column at this font size rather than
    // wrapped; a Feed row is a glance, not a read.
    who.text = clip(entry.actor ?? "", 12);
    time.text = clock(entry.at);
    pillText.text = clip(entry.repo.split("/").pop(), 16);
    pillText.position.set(11, 6);
    const pillWidth = Math.ceil(pillText.width) + 22;
    pillBg
      .clear()
      .roundRect(0, 0, pillWidth, 34, 6)
      .fill({ color: C.white, alpha: 0.06 })
      .stroke({ color: C.dim, alpha: 0.7, width: 1.5 });
    // Title starts just past the pill and runs to the panel edge.
    title.position.x = pill.position.x + pillWidth + 14;
    fitText(title, `#${entry.number}  ${entry.title}`, 1828 - title.position.x);
    // Older entries fade toward the bottom of the panel, so the eye lands on the top.
    row.alpha = 1 - i * 0.045;
  }
}

// An idle board still has to age entries out; a minute of granularity is plenty.
setInterval(renderFeed, 60_000);

let tickerLoop = 1;
let tickerKey = "";
function renderHeadlines(values) {
  const headlines = values
    .filter((headline) => typeof headline === "string" && headline.trim())
    .map((headline) => headline.trim())
    .slice(0, 10);
  // Re-rasterising the whole strip is a visible hitch on the Pi. Only rebuild when
  // the content changed.
  const key = JSON.stringify(headlines);
  if (key === tickerKey) return;
  tickerKey = key;
  for (const old of tickerContent.removeChildren()) old.destroy({ children: true });
  const first = tickerSequence(headlines);
  tickerLoop = first.width;
  // Enough copies that the strip never shows a gap: the screen plus one full loop.
  // ponytail: rebuilt wholesale every 15 minutes — cheap at news-feed frequency.
  const copies = Math.max(2, Math.ceil(W / tickerLoop) + 1);
  first.seq.position.x = 0;
  tickerContent.addChild(first.seq);
  for (let i = 1; i < copies; i++) {
    const { seq } = tickerSequence(headlines);
    seq.position.x = i * tickerLoop;
    tickerContent.addChild(seq);
  }
  if (tickerX <= -tickerLoop) tickerX = 0;
}

let headlines = [];
const NEWS_REFRESH_MS = 15 * 60 * 1000;

function parseHeadlines(xml) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length)
    throw new Error("invalid news feed XML");
  const rssItems = [...document.getElementsByTagNameNS("*", "item")];
  const entries = rssItems.length
    ? rssItems
    : [...document.getElementsByTagNameNS("*", "entry")];
  return entries
    .map((entry) =>
      [...entry.children]
        .find((child) => child.localName === "title")
        ?.textContent?.trim(),
    )
    .filter(Boolean)
    .slice(0, 10);
}

async function loadHeadlines() {
  try {
    const response = await fetch("/news.xml", { cache: "no-store" });
    if (!response.ok) throw new Error(`news feed returned ${response.status}`);
    const next = parseHeadlines(await response.text());
    if (!next.length) throw new Error("news feed has no headlines");
    headlines = next;
    renderHeadlines(headlines);
  } catch (error) {
    console.warn(error);
    // Keep the last successful feed. On a cold start the empty render already says
    // the feed is unavailable and that another attempt is coming.
    if (!headlines.length) renderHeadlines([]);
  }
}

// The float accumulator scrolls; the container lands on whole pixels — fractional
// positions under pixelated rendering read as shimmer, not motion.
let tickerX = 0;
app.ticker.add((t) => {
  tickerX -= TICKER_SPEED * t.deltaMS;
  if (tickerX <= -tickerLoop) tickerX += tickerLoop;
  tickerContent.x = Math.round(tickerX);
});

// Today's MVP on the marquee. A lead change is an event in its own right, so the name
// flashes white and pulses the way the score used to when it moved.
const FLASH_MS = 500;
let flashLeft = 0;
let mvpFill = C.dim;
let currentMvp = null;
let mvpNames = [];
let mvpIndex = 0;
function drawMvpName() {
  // First name only: the board has one line of marquee, not a full name.
  mvpName.text = mvpNames.length
    ? String(mvpNames[mvpIndex % mvpNames.length]).split(" ")[0]
    : "ANYONE'S GAME";
  // Right-align the pair: the tally hangs off the end of the name.
  mvpName.position.x = 1824 - (mvpNames.length ? Math.ceil(mvpTally.width) + 14 : 0);
}
// A tie shares the crown, so the marquee cycles the contenders. Rotation is not a
// lead change: no flash, only a new set of contenders earns one — and the timer
// re-arms on every change so the first contender gets a full turn under the flash.
let mvpRotate;
function setMvp(mvp) {
  const names = mvp ? mvp.names : [];
  const changed = names.join("\n") !== mvpNames.join("\n");
  mvpNames = names;
  if (changed) {
    mvpIndex = 0;
    clearInterval(mvpRotate);
    mvpRotate = setInterval(() => {
      if (mvpNames.length < 2) return;
      mvpIndex = (mvpIndex + 1) % mvpNames.length;
      drawMvpName();
    }, 3000);
  }
  mvpTally.text = mvp ? `×${mvp.count}` : "";
  mvpFill = mvp ? C.amber : C.dim;
  drawMvpName();
  if (changed) flashLeft = FLASH_MS;
  mvpName.style.fill = changed ? C.white : mvpFill;
}

// --------------------------------------------------------------------------------
// Animation plumbing: one ticker, scenes that destroy themselves, a particle ceiling.
// --------------------------------------------------------------------------------

// ponytail: 150 live particles is the ceiling the Pi 4 was budgeted for; raise it
// only after watching the frame rate on the actual device.
const MAX_PARTICLES = 150;

/**
 * Add `container` to a layer, drive it with the shared ticker for `duration` ms,
 * then take it off the stage and destroy it. Textures are cached and shared, so
 * destroying children never destroys a texture.
 */
function runScene(layer, container, duration, update, done) {
  layer.addChild(container);
  let elapsed = 0;
  const tick = (ticker) => {
    elapsed += ticker.deltaMS;
    const progress = Math.min(elapsed / duration, 1);
    update(progress, elapsed, ticker.deltaTime);
    if (elapsed >= duration) {
      app.ticker.remove(tick);
      container.destroy({ children: true });
      done?.();
    }
  };
  app.ticker.add(tick);
}

/** A burst of tinted pixel particles. Returns the array for the scene to step. */
function particles(container, count, make) {
  const budget = Math.min(count, MAX_PARTICLES);
  return Array.from({ length: budget }, () => {
    const piece = make();
    container.addChild(piece);
    return piece;
  });
}

function stepParticles(pieces, delta, gravity = 0.18) {
  for (const piece of pieces) {
    piece.x += piece.vx * delta;
    piece.y += piece.vy * delta;
    piece.vy += gravity * delta;
    piece.rotation += piece.spin * delta;
  }
}

// Sound lives in audio.js so its asynchronous autoplay/device recovery path can
// be tested without booting Pixi. Every generated jingle is under three seconds.

// --------------------------------------------------------------------------------
// Celebration takeovers. Queued: two merges landing together play one after the
// other rather than fighting over the middle of the screen.
// --------------------------------------------------------------------------------

// Celebration clips (the WWE gifs): the canvas can't play a gif, so a clip
// rides a DOM <img> above it, placed with the same fit math the canvas uses.
// The list comes from the server at boot (gitignored drop-in folder, same deal
// as the event sounds); empty list means the trophy carries the takeover alone.
const celebrationClips = { list: [] };
// Re-read rather than trusting the list from boot: this kiosk never reloads, so
// a list cached at boot would never see a clip dropped in afterwards, and would
// keep naming one that had been removed.
function loadCelebrationClips() {
  return fetch("/celebrations")
    .then((r) => r.json())
    .then((list) => {
      if (Array.isArray(list)) celebrationClips.list = list;
    })
    .catch(() => {});
}
loadCelebrationClips();
setInterval(loadCelebrationClips, 60 * 60 * 1000);

/**
 * Show a clip in the takeover's trophy slot. Returns a remove function, or null
 * when there is nothing to show. `onFail` runs if the file turns out to be gone.
 */
function showCelebrationClip(maxMs, onFail) {
  const list = celebrationClips.list;
  if (!list.length) return null;
  const pick = list[Math.floor(Math.random() * list.length)];
  const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;
  // Design-space box in the trophy slot, above the banner.
  const bw = 640;
  const bh = 340;
  const box = document.createElement("div");
  box.style.position = "absolute";
  box.style.zIndex = "10";
  // The canvas re-fits on resize, so the clip has to follow it or an HDMI
  // resolution change mid-takeover leaves it hanging off the frame.
  let scale = 1;
  const place = () => {
    scale = Math.min(innerWidth / W, innerHeight / H);
    const left = (innerWidth - W * scale) / 2;
    const top = (innerHeight - H * scale) / 2;
    box.style.width = `${Math.round(bw * scale)}px`;
    box.style.height = `${Math.round(bh * scale)}px`;
    box.style.left = `${Math.round(left + (W / 2 - bw / 2) * scale)}px`;
    box.style.top = `${Math.round(top + (230 - bh / 2) * scale)}px`;
  };
  place();
  const img = document.createElement("img");
  img.src = `/celebrations/${encodeURIComponent(pick)}`;
  img.style.width = "100%";
  img.style.height = "100%";
  img.style.objectFit = "cover";
  img.style.border = `${Math.max(2, Math.round(4 * scale))}px solid ${hex(C.panelEdge)}`;
  img.style.borderRadius = `${Math.round(10 * scale)}px`;
  img.style.background = hex(C.bg);
  img.style.boxSizing = "border-box";
  box.appendChild(img);
  const remove = () => {
    removeEventListener("resize", place);
    box.remove();
  };
  // A file that has since been removed must not leave an empty frame on the TV:
  // hand the slot back to the caller and re-read the list so the next merge
  // picks from what actually exists.
  img.addEventListener("error", () => {
    remove();
    loadCelebrationClips();
    onFail?.();
  });
  addEventListener("resize", place);
  document.body.appendChild(box);
  // The caller clears this when its scene ends. The timer is only a backstop:
  // scene time is ticker time, which Pixi clamps at 100ms per frame, so on a Pi
  // running slow a wall-clock timeout would pull the clip long before the
  // takeover finishes.
  const backstop = setTimeout(remove, maxMs);
  return () => {
    clearTimeout(backstop);
    remove();
  };
}

const pending = [];
let takeoverBusy = false;

function celebrate(type, event = {}, audible = false) {
  pending.push({ type, event, audible });
  // ponytail: a huge burst of merges would queue up minutes of fanfare; if that ever
  // happens, drop all but the newest few here.
  playNextCelebration();
}

function playNextCelebration() {
  if (takeoverBusy || pending.length === 0) return;
  const next = pending.shift();
  takeoverBusy = true;
  // Old servers send no `teammate`; treat its absence as "play the sample".
  if (next.audible) play(next.type, next.event.teammate !== false);
  const scene = next.type === "pr-merged" ? mergedTakeover : approvedTakeover;
  scene(next.event, () => {
    takeoverBusy = false;
    playNextCelebration();
  });
}

/**
 * Shared takeover backdrop: dim the board, name the PR, headline in the middle,
 * and credit whoever earned it (`verb` reads "merged by" / "approved by").
 */
function takeoverScene(headline, color, event, verb) {
  const scene = new Container();
  const dim = new Sprite(dotTexture());
  dim.width = W;
  dim.height = H;
  // Dim toward leather, not black: knocking the board back to the ground color
  // is the warm-dark move, and a black wash cools every pixel under it.
  dim.tint = C.bg;
  dim.alpha = 0;
  scene.addChild(dim);

  const banner = label(headline, 132, color, {
    dropShadow: { color: C.bg, distance: 6, blur: 0, angle: Math.PI / 4, alpha: 1 },
  });
  banner.anchor.set(0.5);
  banner.position.set(W / 2, H / 2 - 60);
  scene.addChild(banner);

  const caption = label(
    event.repo
      ? `${event.repo.split("/").pop()} #${event.number}  ${clip(event.title ?? "", 46)}`
      : "",
    36,
    C.ink,
  );
  caption.anchor.set(0.5);
  caption.position.set(W / 2, H / 2 + 60);
  scene.addChild(caption);

  // No login means GitHub named nobody; a bare "merged by" credits no one, so skip it.
  const credit = label(event.actor ? `${verb} ${clip(event.actor, 39)}` : "", 44, color);
  credit.anchor.set(0.5);
  credit.position.set(W / 2, H / 2 + 130);
  scene.addChild(credit);
  return { scene, dim, banner, caption, credit };
}

/** pr-merged: the big one — flash, confetti rain, fireworks, bouncing headline. */
function mergedTakeover(event, done) {
  const { scene, dim, banner, caption, credit } = takeoverScene(
    "PR MERGED!",
    C.amber,
    event,
    "merged by",
  );

  // A dropped-in clip takes the trophy slot; no clips (or a clip whose file has
  // since been rotated away), the trophy keeps its job.
  const trophy = pixelSprite("trophy16", 7);
  trophy.position.set(W / 2, H / 2 - 240);
  const clip = showCelebrationClip(15_000, () => {
    if (!trophy.destroyed) trophy.visible = true;
  });
  trophy.visible = !clip;
  scene.addChild(trophy);

  const confetti = particles(scene, 110, () => {
    const piece = new Sprite(dotTexture());
    piece.anchor.set(0.5);
    piece.scale.set(6 + Math.random() * 6);
    piece.tint = [C.amber, C.magenta, C.green, C.ink, C.orange][
      Math.floor(Math.random() * 5)
    ];
    piece.position.set(Math.random() * W, -Math.random() * H);
    piece.vx = (Math.random() - 0.5) * 2;
    piece.vy = 3 + Math.random() * 5;
    piece.spin = (Math.random() - 0.5) * 0.3;
    return piece;
  });

  const fireworks = particles(scene, 36, () => {
    const spark = new Sprite(pixelTexture("star"));
    spark.anchor.set(0.5);
    spark.scale.set(3);
    spark.tint = [C.amber, C.magenta, C.ink][Math.floor(Math.random() * 3)];
    spark.position.set(W / 2, H / 2 - 120);
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 8;
    spark.vx = Math.cos(angle) * speed;
    spark.vy = Math.sin(angle) * speed;
    spark.spin = 0.1;
    return spark;
  });

  runScene(
    layers.takeover,
    scene,
    5000,
    (progress, elapsed, delta) => {
      dim.alpha = Math.min(progress * 4, 0.85) * (progress > 0.85 ? (1 - progress) / 0.15 : 1);
      banner.scale.set(Math.min(elapsed / 220, 1) * (1 + Math.sin(elapsed / 160) * 0.06));
      banner.y = H / 2 - 60 + Math.sin(elapsed / 200) * 18;
      caption.alpha = Math.min(elapsed / 400, 1);
      credit.alpha = Math.min(elapsed / 400, 1);
      trophy.rotation = Math.sin(elapsed / 260) * 0.25;
      trophy.y = H / 2 - 240 + Math.sin(elapsed / 180) * 14;
      stepParticles(confetti, delta, 0.12);
      stepParticles(fireworks, delta, 0.1);
      for (const spark of fireworks) spark.alpha = 1 - progress;
    },
    () => {
      clip?.();
      done?.();
    },
  );
}

/** review-approved: a stamp slamming down inside an expanding shockwave ring. */
function approvedTakeover(event, done) {
  const { scene, dim, banner, caption, credit } = takeoverScene(
    "APPROVED!",
    C.green,
    event,
    "approved by",
  );
  banner.y = H / 2 - 40;

  const ring = new Sprite(ringTexture());
  ring.anchor.set(0.5);
  ring.tint = C.green;
  ring.position.set(W / 2, H / 2 - 40);
  scene.addChildAt(ring, 1);

  const stamp = pixelSprite("check16", 10, C.green);
  stamp.position.set(W / 2, H / 2 - 250);
  scene.addChild(stamp);

  const sparks = particles(scene, 48, () => {
    const spark = new Sprite(pixelTexture("star"));
    spark.anchor.set(0.5);
    spark.scale.set(2.5);
    spark.tint = C.green;
    spark.position.set(W / 2, H / 2 - 40);
    const angle = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 6;
    spark.vx = Math.cos(angle) * speed;
    spark.vy = Math.sin(angle) * speed;
    spark.spin = 0.05;
    return spark;
  });

  runScene(
    layers.takeover,
    scene,
    5000,
    (progress, elapsed, delta) => {
      dim.alpha = Math.min(progress * 5, 0.8) * (progress > 0.85 ? (1 - progress) / 0.15 : 1);
      // The stamp drops fast, overshoots, settles.
      const drop = Math.min(elapsed / 320, 1);
      stamp.scale.set(24 - 12 * drop + Math.sin(drop * Math.PI) * 4);
      stamp.alpha = drop;
      banner.scale.set(drop < 1 ? drop * 0.9 : 1 + Math.sin(elapsed / 150) * 0.04);
      caption.alpha = Math.min(elapsed / 400, 1);
      credit.alpha = Math.min(elapsed / 400, 1);
      ring.scale.set(1 + progress * 34);
      ring.alpha = Math.max(0, 0.9 - progress * 1.2);
      stepParticles(sparks, delta, 0.06);
      for (const spark of sparks) spark.alpha = 1 - progress;
    },
    done,
  );
}

// --------------------------------------------------------------------------------
// Ambient animations: small, silent, one per event type, allowed to overlap.
// --------------------------------------------------------------------------------

// ponytail: at most 6 ambient scenes at once — a burst of comments should not turn
// into a screen full of sprites. Extra events still land in the Feed.
let ambientLive = 0;

function ambientScene(container, duration, update) {
  if (ambientLive >= 6) {
    container.destroy({ children: true });
    return;
  }
  ambientLive++;
  runScene(layers.fx, container, duration, update, () => ambientLive--);
}

/** pr-opened: a rocket flies in from the left and docks on the In Flight panel. */
function prOpenedAnimation() {
  const scene = new Container();
  const rocket = pixelSprite("rocket", 10);
  rocket.position.set(-80, 700);
  scene.addChild(rocket);
  const trail = particles(scene, 12, () => {
    const puff = new Sprite(dotTexture());
    puff.anchor.set(0.5);
    puff.scale.set(5);
    puff.tint = C.orange;
    puff.alpha = 0;
    puff.vx = 0;
    puff.vy = 0;
    puff.spin = 0;
    return puff;
  });
  // Flies the width of the screen just above the Now Playing ticker it's joining.
  ambientScene(scene, 1600, (progress, elapsed) => {
    rocket.x = -80 + progress * (W + 160);
    rocket.y = 900 - progress * 60 + Math.sin(elapsed / 120) * 12;
    rocket.alpha = progress > 0.85 ? (1 - progress) / 0.15 : 1;
    const puff = trail[Math.floor(elapsed / 90) % trail.length];
    puff.position.set(rocket.x - 40, rocket.y + 6);
    puff.alpha = 0.7;
    for (const smoke of trail) smoke.alpha *= 0.94;
  });
}

/** pr-closed: the PR's crate tips off the In Flight wall and falls away. */
function prClosedAnimation() {
  const scene = new Container();
  const crate = pixelSprite("crate", 9, C.red);
  crate.position.set(1540, 320);
  scene.addChild(crate);
  ambientScene(scene, 1400, (progress, elapsed) => {
    crate.x = 1540 + progress * 60;
    crate.y = 320 + progress * progress * 900;
    crate.rotation = progress * 3;
    crate.alpha = 1 - progress * 0.6;
  });
}

/** changes-requested: a red bang shakes over the Feed and the panel edge flashes. */
function changesRequestedAnimation() {
  const scene = new Container();
  const flash = new Graphics()
    .roundRect(24, 204, 1872, 756, 10)
    .stroke({ width: 6, color: C.red });
  scene.addChild(flash);
  const bang = pixelSprite("bang", 12);
  bang.position.set(1060, 480);
  scene.addChild(bang);
  ambientScene(scene, 1200, (progress, elapsed) => {
    const shake = Math.sin(elapsed / 40) * 14 * (1 - progress);
    bang.x = 1060 + shake;
    bang.rotation = shake / 120;
    flash.alpha = Math.abs(Math.sin(elapsed / 110)) * (1 - progress);
    bang.alpha = 1 - progress * 0.5;
  });
}

/** pr-comment: a speech bubble pops off the newest Feed row and drifts up. */
function prCommentAnimation() {
  const scene = new Container();
  const bubble = pixelSprite("bubble", 8);
  bubble.position.set(300, 500);
  scene.addChild(bubble);
  ambientScene(scene, 1200, (progress, elapsed) => {
    bubble.y = 500 - progress * 180;
    bubble.x = 300 + Math.sin(elapsed / 180) * 24;
    bubble.scale.set(8 * Math.min(elapsed / 160, 1));
    bubble.alpha = 1 - progress ** 2;
  });
}

const AMBIENT = {
  "pr-opened": prOpenedAnimation,
  "pr-closed": prClosedAnimation,
  "changes-requested": changesRequestedAnimation,
  "pr-comment": prCommentAnimation,
};
const ambient = (type) => AMBIENT[type]?.();

/** Day Chime: a banner sweeps across the marquee line and the bell plays. */
function chime(at = "") {
  const scene = new Container();
  const endOfDay = at === "17:00";
  play(endOfDay ? "day-chime" : "day-start");
  // Headline stays arcade; the practical call-to-action rides beneath it.
  const headline = endOfDay
    ? `${at}  GAME OVER — GREAT RUN TEAM`
    : `${at}  GOOD MORNING TEAM — PRESS START`;
  const standCall = endOfDay ? "TIME FOR STAND DOWN" : "TIME FOR STAND UP";
  // Sign-off honours whoever wore the crown when the whistle blew.
  const congratsText =
    endOfDay && currentMvp
      ? `CONGRATULATIONS TO TODAY'S MVP${currentMvp.names.length > 1 ? "S" : ""}, ${currentMvp.names.map((n) => String(n).toUpperCase()).join(" & ")} — YOU CRUSHED IT!`
      : null;

  const banner = label(headline, 54, C.ink, {
    dropShadow: { color: C.bg, distance: 4, blur: 0, angle: Math.PI / 4, alpha: 1 },
  });
  const stand = label(standCall, 42, C.ink);
  const congrats = congratsText ? label(congratsText, 42, C.amber) : null;
  const rows = congrats ? [banner, stand, congrats] : [banner, stand];

  const backing = new Sprite(dotTexture());
  backing.anchor.set(0.5);
  backing.width = W;
  backing.height = congrats ? 300 : 230;
  backing.tint = C.bg;
  backing.alpha = 0.85;
  backing.position.set(W / 2, H / 2);
  scene.addChild(backing);
  // A three-way MVP tie runs this line past both screen edges at 42px, so any
  // row wider than the content width is scaled down to fit rather than clipped.
  const fitRow = (row) => (row.width > 1840 ? 1840 / row.width : 1);
  const bannerFit = fitRow(banner);
  rows.forEach((row, i) => {
    row.anchor.set(0.5);
    // The banner's scale is animated below, so its fit rides along there.
    if (row !== banner) row.scale.set(fitRow(row));
    row.position.set(W / 2, H / 2 + (i - (rows.length - 1) / 2) * 76);
    if (i > 0) row.alpha = 0;
    scene.addChild(row);
  });

  // A chime is an occasion: it owns the screen for a while.
  ambientScene(scene, 10_000, (progress, elapsed) => {
    const fade =
      progress < 0.05 ? progress / 0.05 : progress > 0.92 ? (1 - progress) / 0.08 : 1;
    scene.alpha = fade;
    banner.scale.set((0.9 + Math.min(fade, 1) * 0.1) * bannerFit);
    // The extra lines fade in one beat apart.
    rows.forEach((row, i) => {
      if (i > 0) row.alpha = Math.min(Math.max((elapsed - 600 * i) / 500, 0), 1) * fade;
    });
  });
}

// --------------------------------------------------------------------------------
// The heartbeat: bulbs, roll band, blinking prompt, MVP flash. One ticker for
// the whole client — scenes add and remove their own callbacks on this same ticker.
// --------------------------------------------------------------------------------

let phase = 0;
app.ticker.add((ticker) => {
  phase += ticker.deltaMS;
  const chase = phase / 90;
  for (let i = 0; i < bulbs.length; i++)
    bulbs[i].alpha = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(chase - i * 0.5));
  rollBand.y = ((rollBand.y + ticker.deltaTime * 1.6) % (H + 200)) - 100;
  insertCoin.alpha = Math.floor(phase / 600) % 2 ? 0.25 : 1;

  // Lead-change juice: scale decays every frame (cheap), but the fill is set twice —
  // re-rasterising 92px text every frame is not something the Pi needs to do.
  if (flashLeft > 0) {
    flashLeft -= ticker.deltaMS;
    mvpName.scale.set(1 + 0.12 * Math.max(0, flashLeft / FLASH_MS));
    if (flashLeft <= 0) {
      mvpName.scale.set(1);
      mvpName.style.fill = mvpFill;
    }
  }
});

// --------------------------------------------------------------------------------
// Display protocol (server -> client only):
//   {type:"snapshot", feed:[{<domain event>, at}],
//    openPrs:[{repo,number,title,actor}],       (openPrs.actor is the PR's author)
//    mvp:{names,count}|null,                    (all Actors tied for today's lead)
//    devDeploy:{actor,at}|null}                 (last teammate to deploy to dev)
//   on connect and after every recorded event, then bare domain
//   events {type, repo, number, title, actor}; actor is the GitHub login of whoever
//   did it (merger, reviewer, commenter), always a string and "" when GitHub named
// nobody. Events that make a sound — the Celebrations plus pr-opened — carry
// audible:true|false (Quiet Hours) and teammate:true|false (clip or jingle);
// every other Ambient Event carries neither and stays silent. And
//   {type:"day-chime", at:"HH:MM"} marks the start and end of the workday.
// --------------------------------------------------------------------------------

function handleMessage(data) {
  if (data.type === "day-chime") {
    chime(data.at ?? "");
    return;
  }
  if (data.type === "snapshot") {
    feed = data.feed.map(stamp);
    currentMvp = data.mvp;
    setMvp(currentMvp);
    setDevDeploy(data.devDeploy);
  } else {
    feed.push(stamp(data));
    if (CELEBRATIONS.has(data.type)) celebrate(data.type, data, Boolean(data.audible));
    else {
      ambient(data.type);
      // pr-opened is the one Ambient Event with a sound: it stays in the feed rather
      // than taking the board over, but the server flags it like a Celebration. The
      // flags and the burst cooldown both live in audio.js, where they are testable.
      playAmbient(data);
    }
  }
  renderFeed();
}

let backoff = 500;
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}`);

  socket.addEventListener("open", () => {
    backoff = 500;
  });

  socket.addEventListener("message", (message) => handleMessage(JSON.parse(message.data)));

  // The TV has no keyboard, so it has to recover from a dropped socket alone.
  socket.addEventListener("close", () => {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  });
}
connect();

renderFeed();
renderWau(null);
renderHeadlines([]);
void loadWau();
void loadHeadlines();
setInterval(() => void loadWau(), WAU_REFRESH_MS);
setInterval(() => void loadHeadlines(), NEWS_REFRESH_MS);

// Visual QA hook: the canvas can only be checked by a human, so every animation and
// every sound can be fired from the browser console.
//   arcade.demo()                      — one of everything, in order
//   arcade.event({type:"pr-merged", repo:"a/b", number:7, title:"x", audible:true})
//   arcade.celebrate("review-approved") / arcade.ambient("pr-comment") / arcade.chime("09:00")
//   arcade.play("pr-merged")           — sound only
//   arcade.ambient() animates silently; pr-opened's sound rides the audible flag, so
//   hear it with arcade.play("pr-opened") or arcade.event({...,"audible":true})
//   arcade.setMvp({names:["Maximus"],count:12}) / arcade.setMvp(null) — marquee MVP
//   arcade.setDevDeploy({actor:"Maximus"}) / arcade.setDevDeploy(null) — feed header
//   arcade.setWau() / arcade.setWau(undefined, true) / arcade.setWau(null, true)
//     — sample success / stale / unavailable WAU states
//   arcade.setHeadlines(["A very important AI headline"]) — bottom news ticker
const sample = (type) => ({
  type,
  repo: "example-org/demo",
  number: 42,
  title: "Demo pull request",
  actor: "demo-user",
});
const sampleWau = {
  fetchedAt: new Date().toISOString(),
  currentWau: 5906,
  targetWau: 17518,
  targetPercent: 33.7,
  activationPercent: 4.5,
  daily: [2869, 1679, 1503, 0, 0, 0, 0].map((current, index) => ({
    day: index + 1,
    label: ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"][index],
    current,
    previous: [2384, 1945, 2103, 2267, 1748, 1882, 1860][index],
  })),
};
// ?demo: auto-run the full tour shortly after load — lets a plain URL show the
// board off with no console. Audio needs one click/tap (browser autoplay rules);
// the resume listener below turns that first click into sound for the rest.
if (location.search.includes("demo")) setTimeout(() => window.arcade.demo(), 1500);
addEventListener("pointerdown", () => resumeAudio(), { once: true });

window.arcade = {
  app, // arcade.app.ticker.stop() / .update(t) steps an animation frame by frame
  celebrate: (type = "pr-merged", audible = true) => celebrate(type, sample(type), audible),
  ambient,
  chime,
  play,
  setMvp,
  setDevDeploy,
  setWau: (data, stale = false) => renderWau(data === undefined ? sampleWau : data, stale),
  setHeadlines: renderHeadlines,
  event: handleMessage,
  demo() {
    // Every animation and sound in order, then back to the real board state:
    // 4 ambients -> fake MVP + both takeovers (queued) -> both Day Chimes ->
    // restore the MVP the server last sent.
    // pr-opened is the one Ambient Event with a sound, so the tour has to fire both
    // halves by hand. Not via handleMessage: that would push a fake PR into the live
    // feed, which the tour has no way to take back.
    ["pr-opened", "pr-comment", "changes-requested", "pr-closed"].forEach((type, i) =>
      setTimeout(() => {
        ambient(type);
        if (type === "pr-opened") play(type);
      }, i * 1600),
    );
    // The fake MVP goes into currentMvp too, so the 17:00 chime's congrats line
    // has a name to honour; restored afterwards unless a real snapshot already did.
    const real = currentMvp;
    const fake = { names: ["Maximus"], count: 12 };
    setTimeout(() => {
      currentMvp = fake;
      setMvp(fake);
    }, 6400);
    setTimeout(() => window.arcade.celebrate("pr-merged"), 6600);
    setTimeout(() => window.arcade.celebrate("review-approved"), 6800);
    setTimeout(() => chime("09:00"), 17_500);
    setTimeout(() => chime("17:00"), 28_500);
    setTimeout(() => {
      if (currentMvp === fake) currentMvp = real;
      setMvp(currentMvp);
    }, 39_500);
  },
};
