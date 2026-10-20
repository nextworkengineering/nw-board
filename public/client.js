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
import { play, playAmbient, playClip, resumeAudio, setSamples } from "./audio.js";
import { THEMES } from "./themes/index.js";

// The scene is authored at 1080p and scaled to fit whatever the TV reports, so the
// layout is fixed numbers rather than a responsive system nobody will ever resize.
const W = 1920;
const H = 1080;

// ?theme=<name>: the board's whole look, one of public/themes (kernel when absent
// or unknown). Read once here and baked into everything built from `C` and
// label(); switching themes reloads the page (see applyTheme below).
const requestedTheme = new URLSearchParams(location.search).get("theme");
const THEME_NAME = Object.hasOwn(THEMES, requestedTheme ?? "") ? requestedTheme : "kernel";
const T = THEMES[THEME_NAME];

// The board's semantic palette; each theme's values and reasoning live in its file.
const C = T.palette;
if (T.letterbox) document.body.style.background = T.letterbox;

const label = (text, fontSize, fill, extra) =>
  new Text({
    text,
    style: {
      fontFamily: T.type.family(fontSize),
      fontWeight: T.type.weight,
      fontSize,
      fill,
      letterSpacing: T.type.tracking(fontSize),
      ...extra,
    },
  });
/**
 * `label` extras naming the face outright (`display` or `ui`) with tracking in em,
 * where Neobrutal's Paper design picks it per element rather than by size. Only
 * Neobrutal sets type.display/type.ui; every other theme gets no extras.
 */
const face = (name, fontSize, em = 0, extra) =>
  T.type[name] && { fontFamily: T.type[name], letterSpacing: fontSize * em, ...extra };

// Neobrutal's hard shadows hang off every panel, so its panels are narrower and
// shorter to keep clear canary between each shadow and the next panel. Shadowless
// themes keep the full-width board.
const SHADOW = T.decorations.hardShadow ?? 0;
const PANEL_W = SHADOW ? 1864 : 1872;
// The Feed gives up its right-hand 316px to the Status panel: 300 wide, 16 apart.
const FEED_W = PANEL_W - 316;
const chips = T.decorations.chips;

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
// lazy @font-face loading on its own — so load the theme's faces explicitly before
// any Text exists. Never let a missing file hang the kiosk: after 3s the
// system-ui fallbacks in the FONT stacks take over and the board boots anyway.
// A theme with nothing to preload skips the wait.
if (T.preload.length) try {
  await Promise.race([
    Promise.all(T.preload.map((font) => document.fonts.load(font))),
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
// An average hides judder, so it also counts the frames that blew the 60Hz budget
// (>25ms) and the worst one, per 5s. elapsedMS is the raw gap; deltaMS is capped.
// Each 5s line is also posted to the server, which logs it to `journalctl -u pr-arcade`,
// so nobody has to read it off the TV. (Pi OS Chromium drops page console output.)
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
  let slow = 0;
  let worst = 0;
  let pacing = "…";
  app.ticker.add((t) => {
    if (t.elapsedMS > 25) slow++;
    worst = Math.max(worst, t.elapsedMS);
  });
  setInterval(() => {
    pacing = `${slow} slow / worst ${worst.toFixed(0)}ms (5s)`;
    const line = `${app.ticker.FPS.toFixed(0)} FPS — ${rendererName} — ${pacing}`;
    fetch("/fps", { method: "POST", body: line }).catch(() => {});
    slow = 0;
    worst = 0;
  }, 5000);
  setInterval(() => {
    fpsText.text = `${app.ticker.FPS.toFixed(0)} FPS — ${rendererName} — ${pacing}`;
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
  d: C.pixelDim,
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
  // Theme-only art, e.g. the Arcade Theme's crown.
  ...T.sprites,
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
  ctx.fillStyle = `#${C.spriteOutline.toString(16).padStart(6, "0")}`;
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
  // A flat theme (neobrutal) keeps its ground bare: no starfield, grid or roll band.
  layers.back.visible = !T.decorations.flat;

  // Scanlines: 270 dark rows in one static Graphics, drawn over the board so the
  // panels get the CRT texture too.
  const scanlines = new Graphics();
  // Leather rather than black: dimming toward the ground color keeps every
  // darkened pixel in the warm family. Leather is lighter, so the alpha rises.
  for (let y = 0; y < H; y += 4) scanlines.rect(0, y, W, 2);
  scanlines.fill({ color: C.scanline, alpha: C.scanlineAlpha });
  scanlines.eventMode = "none";
  world.addChild(scanlines);

  const roll = new Sprite(dotTexture());
  roll.width = W;
  roll.height = 90;
  roll.alpha = 0.035;
  roll.eventMode = "none";
  roll.visible = !T.decorations.flat;
  world.addChild(roll);
  return roll;
}
const rollBand = buildBackground();

// The Neobrutal Theme's building blocks. Kernel and arcade never reach them: every
// caller is behind a T.decorations key only neobrutal sets.

/**
 * A filled round rect with an `edge` outline over a hard, unblurred shadow `shadow` px
 * down-right. The outline sits inside the rect, as a CSS border does, so x/y/width/height
 * are the box's outer edge.
 */
function slab(g, x, y, width, height, radius, fill, outline, shadow, shadowColor = C.ink, edge = C.ink) {
  if (shadow) g.roundRect(x + shadow, y + shadow, width, height, radius).fill(shadowColor);
  g.roundRect(x, y, width, height, radius).fill(fill);
  return outline ? g.stroke({ width: outline, color: edge, alignment: 1 }) : g;
}

/**
 * Redraw `bg` as a sticker fitted around `text` (unscaled, any anchor), `pad` [x, y]
 * clear inside its outline as in CSS; empty text clears it. `tilt` (degrees) turns
 * the chip and its text about the chip's centre, so the two need a parent of their own.
 */
function sticker(bg, text, fill, { pad = [12, 2], radius = 8, outline = 4, shadow = 4, edge, tilt } = {}) {
  bg.clear();
  if (!text.text) return bg;
  const width = text.width + (pad[0] + outline) * 2;
  const height = text.height + (pad[1] + outline) * 2;
  const x = text.x - text.anchor.x * text.width - pad[0] - outline;
  const y = text.y - text.anchor.y * text.height - pad[1] - outline;
  if (tilt) {
    bg.parent.pivot.set(x + width / 2, y + height / 2);
    bg.parent.position.copyFrom(bg.parent.pivot);
    bg.parent.rotation = (tilt * Math.PI) / 180;
  }
  return slab(bg, x, y, width, height, radius, fill, outline, shadow, C.ink, edge);
}
/** Ink on a light sticker, white on a dark one. */
const stickerInk = (fill) => (T.decorations.chips.whiteOn.includes(fill) ? C.white : C.ink);

/**
 * A container at the takeover card's tilt about the screen centre. The pivot keeps
 * its children in scene coordinates, so the animations that place them are unchanged.
 */
function tilted() {
  const holder = new Container();
  holder.pivot.set(W / 2, H / 2);
  holder.position.set(W / 2, H / 2);
  holder.rotation = (T.decorations.card.tilt * Math.PI) / 180;
  return holder;
}

/** Redraw `g` as the takeover card: `width` x `height` outside, centred on x, at height `cy`. */
function card(g, width, height, cy) {
  const { outline, shadow } = T.decorations.card;
  return slab(g.clear(), (W - width) / 2, cy - height / 2, width, height, 20, C.white, outline, shadow);
}

/**
 * A panel: the arcade cabinet bezel every part of the board sits in. `header`
 * ({fill, ink}, neobrutal only) makes it a white slab under a solid header bar.
 */
function panel(x, y, width, height, title, titleColor, header) {
  const box = new Container();
  box.position.set(x, y);
  if (header) {
    // The bar is filled with square bottom corners, cut off by an ink rule, and the
    // outline goes on last so nothing covers it.
    const { outline, hardShadow } = T.decorations;
    const { bar } = header;
    box.addChild(
      new Graphics()
        .roundRect(hardShadow, hardShadow, width, height, 12)
        .fill(C.panelEdge)
        .roundRect(0, 0, width, height, 12)
        .fill(C.panel)
        .roundRect(0, 0, width, bar + 12, 12)
        .fill(header.fill)
        .rect(0, bar, width, 12)
        .fill(C.panel)
        .moveTo(0, bar)
        .lineTo(width, bar)
        .stroke({ width: outline, color: C.panelEdge })
        .roundRect(0, 0, width, height, 12)
        .stroke({ width: outline, color: C.panelEdge, alignment: 1 }),
    );
  } else {
    const frame = new Graphics()
      .roundRect(0, 0, width, height, 10)
      .fill({ color: C.panel, alpha: 0.85 })
      .stroke({ width: 4, color: C.panelEdge });
    box.addChild(frame);
    const bar = new Graphics()
      .roundRect(0, 0, width, 56, 10)
      .fill({ color: C.panelEdge, alpha: 0.55 });
    box.addChild(bar);
  }
  const heading = label(
    title,
    header?.size ?? 34,
    header?.ink ?? titleColor,
    header && face("display", header.size, -0.01),
  );
  heading.position.set(20, 12);
  if (header) {
    // Centred on the bar, at Paper's 22px inset from the outline.
    heading.anchor.set(0, 0.5);
    heading.position.set(27, header.bar / 2);
  }
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
  T.decorations.marqueeShadow
    ? slab(new Graphics(), 0, 0, PANEL_W, 168, 14, C.panelDeep, 5, SHADOW, T.decorations.marqueeShadow)
    : new Graphics()
        .roundRect(0, 0, PANEL_W, 168, 14)
        .fill({ color: C.panelDeep })
        .stroke({ width: 5, color: C.marqueeEdge }),
);

// Paper on dark, not an accent: the hero recedes into the cabinet and lets the
// canary bulbs and MVP name carry the marquee's 5% of color.
const title = label("NEXTWORK ARCADE", 62, C.heroInk, {
  dropShadow: { color: C.titleShadow, distance: 4, blur: 0, angle: Math.PI / 4, alpha: 0.9 },
});
title.position.set(48, 52);
marquee.addChild(title);

const insertCoin = label("INSERT PULL REQUEST", chips ? 22 : 24, C.marqueeDim, face("ui", 22, 0.04));
insertCoin.position.set(52, 118);
marquee.addChild(insertCoin);

// The marquee's right-hand column ends 48px in from its edge.
const MVP_X = PANEL_W - 48;
const mvpCaption = label("TODAY'S MVP", chips ? 30 : 38, C.marqueeInk, face("ui", 30, 0.02));
mvpCaption.anchor.set(1, 0);
mvpCaption.position.set(MVP_X, 26);
marquee.addChild(mvpCaption);

// The name is right-anchored so it grows leftwards; the tally sits under its tail.
const mvpName = label("ANYONE'S GAME", 64, C.marqueeDim);
mvpName.anchor.set(1, 0);
mvpName.position.set(MVP_X, 72);
marquee.addChild(mvpName);

const mvpTally = label("", chips ? 30 : 38, chips ? C.ink : C.marqueeDim, face("display", 30, 0, { lineHeight: 36 }));
mvpTally.anchor.set(1, 1);
// Bottom-aligned with the name's baseline, clear of the marquee's lower border.
// Neobrutal's sticker (12px padding, 3px outline) ends at the column edge instead.
mvpTally.position.set(MVP_X - (chips ? 15 : 0), 138);
// Neobrutal's sticker behind the tally, redrawn with it in setMvp; the holder is
// what tilts the pair.
const mvpTallyChip = new Graphics();
const mvpTallyHolder = new Container();
mvpTallyHolder.addChild(mvpTallyChip, mvpTally);
marquee.addChild(mvpTallyHolder);

// The flat Neobrutal marquee is print, not a lit sign: no bulbs.
const bulbs = T.decorations.flat ? [] : Array.from({ length: 44 }, (_, i) => {
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
    if (T.decorations.crown) {
      // Tipped onto the top-left of the roundel, over the bulbs: 15x9 art at
      // 16/3 draws 80x48, its top-left corner 21px left of and 24px above the
      // logo's, rotated 14 degrees counter-clockwise about that corner.
      const crown = new Sprite(pixelTexture("crown"));
      crown.scale.set(16 / 3);
      crown.position.set(48 - 21, 84 - LOGO_HEIGHT / 2 - 24);
      crown.rotation = (-14 * Math.PI) / 180;
      marquee.addChild(crown);
    }
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
// Where the first row sits and the step between rows; Neobrutal's shorter panel
// packs them tighter.
const ROW_Y = SHADOW ? 80 : 84;
const ROW_PITCH = SHADOW ? 52 : 54;
const feedHeader = T.decorations.headers?.feed;
const FEED_H = SHADOW ? 464 : 496;
const feedPanel = panel(24, 204, FEED_W, FEED_H, "LIVE FEED // LAST 24H", C.ink, feedHeader);

// Wall clock on the feed header — the board doubles as the office clock.
const wallClock = label("", feedHeader?.size ?? 34, feedHeader?.ink ?? C.ink, feedHeader && face("display", feedHeader.size));
wallClock.anchor.set(1, 0);
wallClock.position.set(FEED_W - 20, 12);
if (feedHeader) {
  wallClock.anchor.set(1, 0.5);
  wallClock.position.set(FEED_W - 27, feedHeader.bar / 2);
}
feedPanel.addChild(wallClock);
setInterval(() => {
  const t = new Date()
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
    .toUpperCase();
  if (wallClock.text !== t) wallClock.text = t;
}, 1000);
// The last human to deploy to dev, centred on the header: the board answers
// "who put that on dev?" without anyone opening GitHub.
const devDeployLabel = label("", chips ? 26 : 34, chips ? C.ink : C.green, face("display", 26, 0, { lineHeight: 32 }));
devDeployLabel.anchor.set(0.5, 0);
devDeployLabel.position.set(FEED_W / 2, 12);
if (feedHeader) {
  devDeployLabel.anchor.set(0.5);
  devDeployLabel.position.set(FEED_W / 2, feedHeader.bar / 2);
}
const devDeployChip = new Graphics();
feedPanel.addChild(devDeployChip, devDeployLabel);
/** {actor, at} from the snapshot, or null when nobody on the roster has deployed. */
function setDevDeploy(devDeploy) {
  // First name only, like the marquee: the header has one line.
  devDeployLabel.text = devDeploy
    ? `IN DEV: ${String(devDeploy.actor).split(" ")[0].toUpperCase()}`
    : "";
  if (chips) sticker(devDeployChip, devDeployLabel, chips.dev, { pad: [14, 2], radius: 10 });
}

const feedEmpty = label("...WAITING FOR PLAYERS...", 30, C.dim);
feedEmpty.position.set(24, 90);
feedPanel.addChild(feedEmpty);

// One row object per line, reused forever: a feed render retints and retexts them
// rather than building and throwing away 14 rows of display objects. A row follows
// the entry it shows, not its slot: `key` names that entry, so a new event slides
// the old rows down a line instead of re-rasterising every Text on the panel.
const feedRows = Array.from({ length: FEED_ROWS }, (_, i) => {
  const row = new Container();
  // Neobrutal: Paper's 26px inset, columns 24px apart, everything centred on its
  // 52px row.
  row.position.set(chips ? 31 : 20, ROW_Y + i * ROW_PITCH);
  row.visible = false;
  const icon = pixelSprite("star", 4);
  icon.position.set(24, 22);
  // Neobrutal's event name is a sticker instead, so it takes the icon's slot.
  icon.visible = !chips;
  const kindChip = new Graphics();
  const kind = label("", chips ? 24 : 28, C.ink, face("display", 24, 0, { lineHeight: 30 }));
  kind.position.set(chips ? 16 : 56, chips ? 11 : 8);
  // First names are short, so the name and time sit tight together and the
  // title gets everything to the right of the repo pill.
  // Columns sized for the 28px register: APPROVED (the widest kind) ends near
  // x196, so the name column starts at 240 with air to spare.
  const who = label("", 28, C.ink);
  who.position.set(chips ? 212 : 240, 8);
  // Right-anchored: FK Grotesk's digits are proportional, so a left-anchored
  // HH:MM column wanders by up to 30px across twelve rows. Anchoring right puts
  // the ragged edge where the eye is not tracking a column.
  const time = label("", 28, C.dim);
  time.anchor.set(1, 0);
  time.position.set(chips ? 529 : 556, 8);
  // Repo pill: a small rounded chip redrawn per render (width follows the text).
  const pillBg = new Graphics();
  const pillText = label(
    "",
    20,
    chips ? C.ink : C.dim,
    face("ui", 20, 0, { lineHeight: 24 }) ??
      (T.type.pillTracking === undefined ? undefined : { letterSpacing: T.type.pillTracking }),
  );
  const pill = new Container();
  pill.position.set(chips ? 578 : 580, chips ? 9 : 6);
  pill.addChild(pillBg, pillText);
  const title = label("", 28, C.feedTitle);
  title.position.set(0, 8); // x set per render, after the pill
  row.addChild(icon, kindChip, kind, who, time, pill, title);
  feedPanel.addChild(row);
  return { row, icon, kindChip, kind, who, time, pillBg, pillText, pill, title, key: null };
});

// --------------------------------------------------------------------------------
// Service Status: GitHub, Sentry and GCP lights, right of the Feed.
// --------------------------------------------------------------------------------

const statusHeader = T.decorations.headers?.status;
const statusPanel = panel(24 + FEED_W + 16, 204, 300, FEED_H, "STATUS", C.ink, statusHeader);
// Neobrutal: Paper's 27px inset, like the heading; elsewhere the heading's 20.
const STATUS_INSET = statusHeader ? 27 : 20;
// Light-top to text-bottom of one row; the rows share the body's slack equally.
const STATUS_ROW_H = 64;
const statusBar = statusHeader?.bar ?? 56;
const statusGap = (FEED_H - statusBar - 3 * STATUS_ROW_H) / 4;
const STATUS_TEXT_W = 300 - 2 * STATUS_INSET;
const statusRows = ["GITHUB", "SENTRY", "GCP"].map((name, i) => {
  const y = statusBar + statusGap * (i + 1) + STATUS_ROW_H * i;
  const light = new Graphics();
  light.position.set(STATUS_INSET + 16, y + 16);
  const title = label(name, 30, C.ink, face("display", 30, -0.01));
  title.anchor.set(0, 0.5);
  title.position.set(STATUS_INSET + 32 + 14, y + 16);
  const text = label("", 20, C.dim, face("ui", 20, 0, { lineHeight: 24 }));
  text.anchor.set(0, 0.5);
  text.position.set(STATUS_INSET, y + 53);
  // Text too long for the panel scrolls inside this window rather than being cut.
  const scrollWindow = new Graphics().rect(STATUS_INSET, y + 39, STATUS_TEXT_W, 28).fill(C.white);
  text.mask = scrollWindow;
  statusPanel.addChild(light, title, text, scrollWindow);
  return { name, light, text, full: null, loop: 0 };
});
const STATUS_LIGHT = { ok: C.green, minor: C.amber, major: C.red, unknown: C.dim };
// Neobrutal's canary text would vanish on its white panel, so minor reads in ink.
const STATUS_INK = { ok: C.dim, minor: chips ? C.ink : C.amber, major: C.red, unknown: C.dim };

let latestStatus = null;
/**
 * Text that fits sits still. Longer text runs as a loop, `full • full`, that steps
 * left one whole pixel per 60Hz frame like the ticker; `loop` is one lap's width.
 * Unchanged text keeps its place, so a refresh doesn't jump the scroll back.
 */
function setStatusText(row, full) {
  if (row.full === full) return;
  row.full = full;
  row.loop = 0;
  row.text.x = STATUS_INSET;
  row.text.text = full;
  if (row.text.width <= STATUS_TEXT_W) return;
  row.text.text = `${full}   •   `;
  row.loop = Math.round(row.text.width);
  row.text.text = `${full}   •   ${full}`;
}
app.ticker.add((t) => {
  const frames = Math.max(1, Math.round(t.deltaMS / (1000 / 60)));
  for (const row of statusRows) {
    if (!row.loop) continue;
    row.text.x -= frames;
    if (row.text.x <= STATUS_INSET - row.loop) row.text.x += row.loop;
  }
});

/** Stale data keeps its words but dims every light: a light is a claim about now. */
function renderStatus(data, stale = false) {
  latestStatus = data;
  for (const row of statusRows) {
    const { name, light, text } = row;
    const service = data?.services?.find((entry) => entry.name === name);
    const level = Object.hasOwn(STATUS_LIGHT, service?.level ?? "") ? service.level : "unknown";
    light.clear().circle(0, 0, 16).fill(stale || !service ? C.dim : STATUS_LIGHT[level]);
    if (T.decorations.stats) light.stroke({ width: T.decorations.stats.outline, color: C.ink, alignment: 1 });
    text.style.fill = service ? STATUS_INK[level] : C.dim;
    setStatusText(row, service ? String(service.text) : "CHECKING…");
  }
}

const STATUS_REFRESH_MS = 2 * 60 * 1000;
async function loadStatus() {
  try {
    const response = await fetch("/status.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`status returned ${response.status}`);
    const next = await response.json();
    if (!Array.isArray(next.services)) throw new Error("invalid status data");
    renderStatus(next, Date.now() - Date.parse(next.fetchedAt) > 2 * STATUS_REFRESH_MS);
  } catch (error) {
    console.warn(error);
    renderStatus(latestStatus, latestStatus !== null);
  }
}

// --------------------------------------------------------------------------------
// Weekly Unique User Growth: four dashboard KPIs and new WUU per day for this week vs last week.
// --------------------------------------------------------------------------------

const wauHeader = T.decorations.headers?.wau;
const wauPanel = panel(24, SHADOW ? 688 : 712, PANEL_W, 272, "WEEKLY UNIQUE USER GROWTH", C.ink, wauHeader);
const wauStatus = label("LOADING...", wauHeader ? 22 : 24, C.dim);
wauStatus.anchor.set(1, 0);
wauStatus.position.set(1852, 16);
if (wauHeader) {
  wauStatus.anchor.set(1, 0.5);
  wauStatus.position.set(PANEL_W - 27, wauHeader.bar / 2);
}
wauPanel.addChild(wauStatus);

/** `hot` (neobrutal only) fills the box with the theme's highlight. */
function wauCard(x, y, title, hot) {
  const stats = T.decorations.stats;
  const card = new Container();
  card.position.set(x, y);
  card.addChild(
    stats
      ? slab(new Graphics(), 0, 0, 430, 62, 8, hot ? stats.hot : stats.fill, stats.outline, 0)
      : new Graphics()
          .roundRect(0, 0, 430, 72, 7)
          .fill({ color: C.panelDeep, alpha: 0.72 })
          .stroke({ width: 2, color: C.panelEdge }),
  );
  // Neobrutal's caption reads in ink on the highlight.
  const caption = label(title, 18, stats && hot ? C.ink : C.dim, face("ui", 18, 0.04));
  caption.position.set(14, 8);
  const value = label("—", stats ? 34 : 36, C.ink);
  value.position.set(14, 29);
  if (stats) {
    // Neobrutal sets the caption and value on one line, the value flush right.
    caption.anchor.set(0, 0.5);
    caption.position.set(20, 31);
    value.anchor.set(1, 0.5);
    value.position.set(410, 31);
  }
  card.addChild(caption, value);
  wauPanel.addChild(card);
  return value;
}

// Neobrutal's boxes sit inside Paper's 16/22 body padding, a 14px gutter apart.
const [cardX, cardY] = T.decorations.stats ? [[27, 471], [77, 153]] : [[20, 464], [68, 150]];
const wauValues = {
  currentWau: wauCard(cardX[0], cardY[0], "CURRENT WUU"),
  targetWau: wauCard(cardX[1], cardY[0], "WEEKLY TARGET"),
  targetPercent: wauCard(cardX[0], cardY[1], "TARGET REACHED", true),
  activationPercent: wauCard(cardX[1], cardY[1], "ACTIVATION RATE"),
};

// On Target: a status light between the cards and the chart, boxed like a card.
const onTargetTile = new Container();
const onTargetLight = new Graphics();
const onTargetCaption = label("ON TARGET", 18, C.dim, face("ui", 18, 0.04));
// The only centred caption on the panel: it heads the light below it.
onTargetCaption.anchor.set(0.5, 0);
onTargetCaption.position.set(112, 8);
if (T.decorations.stats) {
  onTargetTile.position.set(935, 77);
  onTargetTile.addChild(slab(new Graphics(), 0, 0, 224, 138, 8, T.decorations.stats.fill, T.decorations.stats.outline, 0));
  onTargetCaption.anchor.set(0.5);
  onTargetCaption.position.set(112, 27);
} else {
  onTargetTile.position.set(914, 68);
  onTargetTile.addChild(
    new Graphics()
      .roundRect(0, 0, 224, 154, 7)
      .fill({ color: C.panelDeep, alpha: 0.72 })
      .stroke({ width: 2, color: C.panelEdge }),
  );
}
onTargetTile.addChild(onTargetCaption, onTargetLight);
wauPanel.addChild(onTargetTile);
const ON_TARGET = { on: C.green, behind: C.amber, "far-behind": C.red };

const chart = T.decorations.chart;
const wauChart = new Container();
wauChart.position.set(chart ? 1187 : 1158, chart ? 77 : 68);
// Neobrutal: Paper's 650px plot, its baseline 112 down the chart.
const plot = chart ? { x: 0, y: 30, width: 650, height: 82 } : { x: 8, y: 38, width: 672, height: 96 };
wauPanel.addChild(wauChart);
const chartType = face("ui", 18, 0.04, { lineHeight: 22 });
const chartTitle = label("NEW WUU / DAY", chart ? 18 : 20, C.dim, chartType);
wauChart.addChild(chartTitle);
const currentLegend = label(chart ? "THIS WEEK" : "● THIS WEEK", 18, chart ? C.ink : C.amber, chartType && { lineHeight: 22 });
currentLegend.position.set(500, 2);
wauChart.addChild(currentLegend);
const previousLegend = label(chart ? "LAST WEEK" : "● LAST WEEK", 18, chart ? C.ink : C.info, chartType && { lineHeight: 22 });
previousLegend.position.set(338, 2);
wauChart.addChild(previousLegend);
if (chart) {
  // Paper's order, flush with the chart's right edge: swatch, 8px, label, 22px gap.
  currentLegend.position.set(plot.width + 2 - currentLegend.width, 0);
  previousLegend.position.set(currentLegend.x - 46 - previousLegend.width, 0);
}
// Neobrutal's legend keys are outlined swatches: its canary text would vanish on white.
if (chart)
  for (const [legend, color] of [[previousLegend, C.info], [currentLegend, C.amber]])
    wauChart.addChild(
      new Graphics()
        .rect(legend.x - 22.5, legend.y + 4.5, 13, 13)
        .fill(color)
        .stroke({ width: chart.outline, color: C.ink }),
    );
const chartLines = new Graphics();
wauChart.addChild(chartLines);
const dayLabels = Array.from({ length: 7 }, (_, index) => {
  const day = label(`D${index + 1}`, 16, chart ? C.ink : C.dim);
  day.anchor.set(0.5, 0);
  wauChart.addChild(day);
  return day;
});
const barValues = [0, 1].map(() =>
  Array.from({ length: 7 }, () => {
    // A theme may override the value's tracking (see valueTracking in its file).
    // Neobrutal's bars are 30px, so a tad smaller to keep a pair's values apart.
    const value = label(
      "",
      chart ? 13 : 14,
      C.dim,
      T.type.valueTracking === undefined ? undefined : { letterSpacing: T.type.valueTracking },
    );
    value.anchor.set(0.5, 0);
    wauChart.addChild(value);
    return value;
  }),
);
const compact = (n) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
    .format(n)
    .toLowerCase();
const wauUnavailable = label("WUU DATA UNAVAILABLE — RETRYING", 24, C.dim);
wauUnavailable.anchor.set(0.5);
wauUnavailable.position.set(wauChart.x + plot.x + plot.width / 2, 154);
wauPanel.addChild(wauUnavailable);

let latestWau = null;
function renderWau(data, stale = false) {
  latestWau = data;
  const snapshot = data;
  wauUnavailable.visible = !snapshot;
  wauChart.visible = Boolean(snapshot);
  onTargetTile.visible = Boolean(snapshot);
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
  wauStatus.style.fill = stale ? C.red : (wauHeader?.ink ?? C.green);
  // Old cached payloads carry no onTarget: an empty tile, not a guess.
  const light = ON_TARGET[snapshot.onTarget];
  onTargetLight.clear();
  if (light && T.decorations.stats)
    onTargetLight.circle(112, 80, 32).fill(light).stroke({ width: T.decorations.stats.outline, color: C.ink, alignment: 1 });
  else if (light) onTargetLight.circle(112, 94, 36).fill(light);

  const max = Math.max(
    1,
    ...snapshot.daily.flatMap((point) => [point.current, point.previous]),
  );
  const groupWidth = plot.width / 7;
  const barWidth = chart ? 30 : 38;
  const x = (index) => plot.x + groupWidth * (index + 0.5);
  const y = (value) => plot.y + plot.height - (value / max) * plot.height;
  chartLines
    .clear()
    .moveTo(plot.x, plot.y + plot.height)
    .lineTo(plot.x + plot.width, plot.y + plot.height)
    .stroke({ width: chart?.baseline ?? 2, color: C.panelEdge })
    .moveTo(plot.x, plot.y + plot.height / 2)
    .lineTo(plot.x + plot.width, plot.y + plot.height / 2)
    .stroke({ width: 1, color: C.panelEdge, alpha: 0.5 });
  for (const [row, [key, color, offset]] of [
    ["previous", C.info, -barWidth],
    ["current", C.amber, 0],
  ].entries()) {
    snapshot.daily.forEach((point, index) => {
      const top = y(point[key]);
      chartLines.rect(x(index) + offset, top, barWidth, plot.y + plot.height - top).fill(color);
      if (chart) chartLines.stroke({ width: chart.outline, color: C.ink });
      const value = barValues[row][index];
      value.text = compact(point[key]);
      value.style.fill = chart?.valueInk ?? color;
      value.position.set(x(index) + offset + barWidth / 2, plot.y + plot.height + 4);
    });
  }
  // Under each day so far, a green tick if it beat the same day last week (today's
  // is the Target Hit), else a grey cross. Old cached payloads carry no today: no marks.
  const today = Number.isInteger(snapshot.today) && snapshot.today >= 0 && snapshot.today < 7
    ? snapshot.today
    : -1;
  const markY = plot.y + plot.height + 50;
  for (let index = 0; index <= today; index++) {
    const { current, previous } = snapshot.daily[index];
    const cx = x(index);
    if (current > previous)
      chartLines
        .moveTo(cx - 7, markY)
        .lineTo(cx - 2, markY + 5)
        .lineTo(cx + 7, markY - 5)
        .stroke({ width: 3, color: C.green });
    else
      chartLines
        .moveTo(cx - 5, markY - 5)
        .lineTo(cx + 5, markY + 5)
        .moveTo(cx + 5, markY - 5)
        .lineTo(cx - 5, markY + 5)
        .stroke({ width: 3, color: C.dim });
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
    if (!response.ok) throw new Error(`WUU dashboard returned ${response.status}`);
    const next = await response.json();
    if (
      ![next.currentWau, next.targetWau, next.targetPercent, next.activationPercent].every(
        Number.isFinite,
      ) ||
      !Array.isArray(next.daily) ||
      next.daily.length !== 7
    )
      throw new Error("invalid WUU dashboard data");
    // The server answers 200 with its last good numbers when PostHog fails, so a Pi
    // that lost its network overnight would otherwise show yesterday's WUU as UPDATED.
    renderWau(next, Date.now() - Date.parse(next.fetchedAt) > 2 * WAU_REFRESH_MS);
  } catch (error) {
    console.warn(error);
    renderWau(latestWau, true);
  }
}

// --------------------------------------------------------------------------------
// AI News ticker: RSS headlines loop forever across a strip at the bottom.
// --------------------------------------------------------------------------------

const TICKER_Y = SHADOW ? 980 : 992;
const TICKER_H = SHADOW ? 76 : 72;
// 32px type centred in the strip; Neobrutal's 34px sets a 42px line.
const TICKER_TEXT_Y = TICKER_Y + (SHADOW ? 17 : 20);
const TICKER_GAP = chips ? 36 : 110;
const TICKER_STEP = 2; // px per 60Hz frame — 120 px/s, a lap of one 1920px screen every 16s

// Framed like the marquee and the Feed panel: same side margins, same border.
const tickerStrip = new Container();
tickerStrip.addChild(
  T.decorations.tickerFill
    ? slab(new Graphics(), 24, TICKER_Y, PANEL_W, TICKER_H, 12, T.decorations.tickerFill, T.decorations.outline, SHADOW)
    : new Graphics()
        .roundRect(24, TICKER_Y, PANEL_W, TICKER_H, 10)
        .fill({ color: C.panel, alpha: 0.92 })
        .stroke({ width: 4, color: C.panelEdge }),
);
const tickerContent = new Container();
// The scroll is clipped to the frame so segments don't poke into the margins.
// Neobrutal clips inside its 5px outline, as Paper does.
const tickerMask = SHADOW
  ? new Graphics().roundRect(29, TICKER_Y + 5, PANEL_W - 10, TICKER_H - 10, 7).fill(C.white)
  : new Graphics().roundRect(26, TICKER_Y, PANEL_W - 4, TICKER_H, 10).fill(C.white);
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
  if (chips) {
    // Neobrutal: the marker is a flat, tilted sticker, padded inside its slot.
    const marker = label("AI NEWS", 28, stickerInk(chips.news), face("display", 28, 0, { lineHeight: 34 }));
    marker.position.set(16, TICKER_Y + TICKER_H / 2 - 17);
    const chip = new Graphics();
    const tilt = new Container();
    tilt.addChild(chip, marker);
    sticker(chip, marker, chips.news, { pad: [16, 4], outline: 0, shadow: 0, tilt: -3 });
    const slot = new Container();
    slot.addChild(tilt);
    put(slot);
  } else {
    const marker = label("★ AI NEWS ★", 32, C.green);
    marker.position.y = TICKER_TEXT_Y;
    put(marker);
  }
  if (!headlines.length) {
    const none = label("AI NEWS UNAVAILABLE — RETRYING", 32, C.dim);
    none.position.y = TICKER_TEXT_Y;
    put(none);
  }
  for (const headline of headlines) {
    const item = new Container();
    // Neobrutal's bullet: an 18px outlined canary square on its corner.
    const bullet = chips
      ? new Graphics().rect(-7.5, -7.5, 15, 15).fill(C.amber).stroke({ width: 3, color: C.ink })
      : label("◆", 32, C.amber);
    if (chips) {
      bullet.rotation = Math.PI / 4;
      bullet.position.set(9, TICKER_Y + TICKER_H / 2);
    } else bullet.position.y = TICKER_TEXT_Y;
    const text = label(clip(headline, 100), chips ? 34 : 32, C.ink, face("ui", 34, 0, { lineHeight: 42 }));
    text.position.set(chips ? 18 + TICKER_GAP : bullet.width + 24, TICKER_TEXT_Y);
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

// Everything a row draws, and nothing else. Not the whole entry: a live event is
// stamped with this display's clock and may carry audible/teammate, while the
// snapshot that follows it carries the server's `at` and neither flag — so the
// same event would key differently and be retexted twice. The minute is what the
// row shows of `at`, which keeps the two copies equal.
const feedKey = (entry) =>
  JSON.stringify([entry.type, entry.repo, entry.number, entry.title, entry.actor, clock(entry.at)]);

function renderFeed() {
  feed = feed.filter((entry) => Date.now() - entry.at < DAY_MS);
  feedEmpty.visible = feed.length === 0;
  const visible = feed.slice(-FEED_ROWS).reverse();
  const keys = visible.map(feedKey);
  // Rows already showing a visible entry keep it; the rest are free to retext.
  const placed = [];
  const free = [];
  for (const slot of feedRows) {
    const i = keys.findIndex((key, j) => key === slot.key && !placed[j]);
    if (i >= 0) placed[i] = slot;
    else free.push(slot);
  }
  visible.forEach((entry, i) => {
    const slot = placed[i] ?? free.pop();
    if (!placed[i]) {
      slot.key = keys[i];
      retextRow(slot, entry);
    }
    slot.row.position.y = ROW_Y + i * ROW_PITCH;
    // Older entries fade toward the bottom of the panel, so the eye lands on the top.
    slot.row.alpha = 1 - i * 0.045;
    slot.row.visible = true;
  });
  for (const slot of free) {
    slot.row.visible = false;
    slot.key = null;
  }
}

function retextRow({ icon, kindChip, kind, who, time, pillBg, pillText, pill, title }, entry) {
  const style = EVENTS[entry.type] ?? { name: entry.type, color: C.dim, icon: "star" };
  icon.texture = pixelTexture(style.icon);
  kind.text = style.name;
  if (chips) {
    kind.style.fill = stickerInk(style.color);
    sticker(kindChip, kind, style.color);
  } else kind.style.fill = style.color;
  // Clipped to the characters that fit each column at this font size rather than
  // wrapped; a Feed row is a glance, not a read.
  who.text = clip(entry.actor ?? "", T.type.nameMax);
  time.text = clock(entry.at);
  pillText.text = clip(entry.repo.split("/").pop(), 16);
  // Neobrutal: Paper's 14/2 padding inside a 3px outline.
  const pad = chips ? [17, 5] : [11, 6];
  pillText.position.set(...pad);
  const pillWidth = Math.ceil(pillText.width) + pad[0] * 2;
  const pillHeight = pillText.height + pad[1] * 2;
  if (chips)
    pillBg
      .clear()
      .roundRect(0, 0, pillWidth, pillHeight, pillHeight / 2)
      .fill(chips.pill)
      .stroke({ color: C.ink, width: 3, alignment: 1 });
  else
    pillBg
      .clear()
      .roundRect(0, 0, pillWidth, 34, 6)
      .fill({ color: C.white, alpha: 0.06 })
      .stroke({ color: C.dim, alpha: 0.7, width: 1.5 });
  // Title starts just past the pill and runs to the panel edge.
  title.position.x = pill.position.x + pillWidth + (chips ? 24 : 14);
  fitText(title, `#${entry.number}  ${entry.title}`, FEED_W - (chips ? 62 : 44) - title.position.x);
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
  // A whole number, so the copies sit on whole pixels and a wrap never lands the
  // strip between two.
  tickerLoop = Math.ceil(first.width);
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
  if (tickerContent.x <= -tickerLoop) tickerContent.x = 0;
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

// Whole-pixel steps locked to the frame: the strip only ever sits on whole pixels
// (fractional positions under pixelated rendering read as shimmer, not motion),
// and every 60Hz frame moves exactly TICKER_STEP. Rounding a px-per-ms speed
// instead gave 1,2,1,2px steps — a steady judder. A dropped frame takes the steps
// it missed, so the speed holds.
// ponytail: counts frames at 60Hz, so a 120Hz dev monitor scrolls at double speed;
// the Pi's TV is 60Hz. Derive the step from the measured refresh rate if that matters.
app.ticker.add((t) => {
  const frames = Math.max(1, Math.round(t.deltaMS / (1000 / 60)));
  tickerContent.x -= TICKER_STEP * frames;
  if (tickerContent.x <= -tickerLoop) tickerContent.x += tickerLoop;
});

// Today's MVP on the marquee. A lead change is an event in its own right, so the name
// flashes white and pulses the way the score used to when it moved.
const FLASH_MS = 500;
let flashLeft = 0;
let mvpFill = C.marqueeDim;
let currentMvp = null;
let mvpNames = [];
let mvpIndex = 0;
function drawMvpName() {
  // First name only: the board has one line of marquee, not a full name.
  mvpName.text = mvpNames.length
    ? String(mvpNames[mvpIndex % mvpNames.length]).split(" ")[0]
    : "ANYONE'S GAME";
  // Right-align the pair: the tally hangs off the end of the name (clear of its
  // sticker's padding when it has one).
  mvpName.position.x =
    MVP_X - (mvpNames.length ? Math.ceil(mvpTally.width) + (chips ? 44 : 14) : 0);
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
  if (chips)
    sticker(mvpTallyChip, mvpTally, chips.tally, { radius: 10, outline: 3, shadow: 0, edge: C.white, tilt: -4 });
  mvpFill = mvp ? C.amber : C.marqueeDim;
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
// be tested without booting Pixi. Every generated jingle is under four seconds.

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
  // Design-space box in the trophy slot, above the banner (shorter and lifted
  // with the trophy over Neobrutal's taller card).
  const bw = 640;
  const bh = ON_CARD ? 280 : 340;
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
    box.style.top = `${Math.round(top + (230 - LIFT - bh / 2) * scale)}px`;
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
// One occasion on screen at a time: true while a takeover or a banner (Day Chime,
// Reminder) is showing. A Reminder and a Scheduled Celebration fired the same
// minute arrive back to back, and a chime can land mid-merge; without the shared
// flag each started over the other, texts overlapping and both sounds at once.
// Whichever waits starts when the other finishes (see the two `done`s).
let stageBusy = false;

function celebrate(type, event = {}, audible = false) {
  pending.push({ type, event, audible });
  // ponytail: a huge burst of merges would queue up minutes of fanfare; if that ever
  // happens, drop all but the newest few here.
  playNextCelebration();
}

// Theme switches are reloads with ?theme= rewritten, held until no takeover is
// playing or queued so a reload never cuts one off. Only a theme that differs
// from the one this page loaded with triggers one, so a reload cannot loop.
let wantTheme = THEME_NAME;
// Day Chimes and Reminders on screen or waiting their turn (see queueBanner): a
// reload would cut the bell off mid-sound.
let chimes = 0;
function applyTheme() {
  // Staying put (a switch called off before it happened, or the reload just
  // landed): any held Target Hit plays here rather than being lost.
  if (wantTheme === THEME_NAME) {
    playHeldCelebration();
    return;
  }
  if (stageBusy || pending.length > 0 || chimes > 0) return;
  // Split by hand rather than URLSearchParams, which would rewrite ?fps as ?fps=.
  const params = location.search
    .slice(1)
    .split("&")
    // A bare ?arcade is the pre-?theme= spelling; drop it with any old theme.
    .filter((param) => param && !["theme", "arcade"].includes(param.split("=")[0]));
  // The kernel theme is the default, so its URL stays clean.
  if (wantTheme !== "kernel") params.push(`theme=${wantTheme}`);
  const query = params.length ? `?${params.join("&")}` : "";
  location.replace(`${location.pathname}${query}${location.hash}`);
}
// A Target Hit on the kernel theme is held across the reload into the Arcade
// Theme, so its whole takeover plays in the arcade look.
const PENDING_CELEBRATION = "pending-celebration";
function playHeldCelebration() {
  const held = sessionStorage.getItem(PENDING_CELEBRATION);
  if (!held) return;
  sessionStorage.removeItem(PENDING_CELEBRATION);
  const data = JSON.parse(held);
  celebrate(data.type, data, Boolean(data.audible));
}

function playNextCelebration() {
  if (stageBusy) return;
  if (pending.length === 0) {
    applyTheme();
    return;
  }
  const next = pending.shift();
  stageBusy = true;
  // A Scheduled Celebration brings its own clip (or none) instead of a slot's.
  if (next.audible && next.type === "scheduled-celebration")
    playClip(next.event.sound, "pr-merged");
  // Old servers send no `teammate`; treat its absence as "play the sample".
  else if (next.audible) play(next.type, next.event.teammate !== false);
  const scene =
    {
      "pr-merged": mergedTakeover,
      "wau-target-hit": wauTakeover,
      "scheduled-celebration": scheduledTakeover,
    }[next.type] ?? approvedTakeover;
  scene(next.event, () => {
    stageBusy = false;
    // A banner that waited out this takeover goes before any further takeovers.
    if (banners.length) nextBanner();
    else playNextCelebration();
  });
}

// Neobrutal sets takeovers and chimes on a card. The card's ground is the theme's
// flat canary, so its dim goes all the way.
const ON_CARD = Boolean(T.decorations.card);
// The card stands taller than the old band, so the trophy and stamp ride higher to
// clear its top edge.
const LIFT = ON_CARD ? 80 : 0;

/**
 * Shared takeover backdrop: dim the board, name the PR, headline in the middle,
 * and credit whoever earned it (`verb` reads "merged by" / "approved by").
 * Neobrutal (T.decorations.card) sets the copy in ink on a tilted white card, the
 * credit on a sticker above the headline; `fit` re-lays the card after the copy is
 * rewritten, so callers animate from the headline's `y` as `fit` left it.
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
  const copy = ON_CARD ? tilted() : scene;
  const cardBg = ON_CARD ? new Graphics() : null;
  const creditChip = ON_CARD ? new Graphics() : null;
  if (ON_CARD) {
    scene.addChild(copy);
    copy.addChild(cardBg);
  }

  const banner = label(
    headline,
    ON_CARD ? 150 : 132,
    ON_CARD ? C.ink : color,
    ON_CARD
      ? face("display", 150, -0.02)
      : { dropShadow: { color: C.bg, distance: 6, blur: 0, angle: Math.PI / 4, alpha: 1 } },
  );
  banner.anchor.set(0.5);
  banner.position.set(W / 2, H / 2 - 60);
  copy.addChild(banner);

  const caption = label(
    event.repo
      ? `${event.repo.split("/").pop()} #${event.number}  ${clip(event.title ?? "", 46)}`
      : "",
    ON_CARD ? 40 : 36,
    C.ink,
    face("ui", 40, 0, { lineHeight: 48 }),
  );
  caption.anchor.set(0.5);
  caption.position.set(W / 2, H / 2 + 60);
  copy.addChild(caption);

  // No login means GitHub named nobody; a bare "merged by" credits no one, so skip it.
  const by = event.actor ? `${verb} ${clip(event.actor, 39)}` : "";
  const credit = label(
    ON_CARD ? by.toUpperCase() : by,
    ON_CARD ? 30 : 44,
    ON_CARD ? stickerInk(T.decorations.chips.credit) : color,
    face("display", 30, 0, { lineHeight: 36 }),
  );
  credit.anchor.set(0.5);
  credit.position.set(W / 2, H / 2 + 130);
  // The credit and its sticker fade in together; callers fade `creditRow`.
  const creditRow = new Container();
  if (ON_CARD) creditRow.addChild(creditChip);
  creditRow.addChild(credit);
  copy.addChild(creditRow);
  const fit = () => {
    if (!ON_CARD) return;
    // Paper's card: credit sticker (4/22 padding in a 5px outline), headline and
    // caption, stacked 26px apart inside 60/56 padding and an 8px outline, centred.
    // An empty row takes no room. At least 1240 wide, or the headline's bounce (6%)
    // with Paper's 60px sides.
    const rows = [
      [credit, credit.text ? credit.height + 18 : 0],
      [banner, banner.height],
      [caption, caption.text ? caption.height : 0],
    ].filter(([, height]) => height);
    const content = rows.reduce((sum, [, height]) => sum + height + 26, -26);
    const width = Math.max(banner.width * 1.06, caption.width, credit.width + 54) + 136;
    card(cardBg, Math.min(Math.max(1240, width), W - 80), content + 132, H / 2);
    // The card stands content + 132 tall (padding and outlines); rows start 68 in.
    let y = H / 2 - content / 2 + 2;
    for (const [row, height] of rows) {
      row.y = y + height / 2;
      y += height + 26;
    }
    sticker(creditChip, credit, T.decorations.chips.credit, { pad: [22, 4], radius: 12, outline: 5, shadow: 6, tilt: 3 });
  };
  fit();
  return { scene, dim, banner, caption, credit, creditRow, fit };
}

/**
 * Wrap `text` to `width` and step its font down until it stands no taller than
 * `height`. Admin Console copy runs to 120 characters: shrinking that onto one line
 * would leave a sliver nobody can read across the room. The floor stays on the
 * display face; returns the scale still needed if even the floor is too tall.
 */
function fitWrapped(text, width, height) {
  Object.assign(text.style, { wordWrap: true, wordWrapWidth: width, breakWords: true, align: "center" });
  while (text.height > height && text.style.fontSize > 56) {
    const size = Math.max(56, Math.round(text.style.fontSize * 0.85));
    Object.assign(text.style, {
      fontSize: size,
      fontFamily: T.type.family(size),
      letterSpacing: T.type.tracking(size),
    });
  }
  return Math.min(1, height / text.height);
}

/** pr-merged: the big one — flash, confetti rain, fireworks, bouncing headline. */
function mergedTakeover(event, done) {
  const { scene, dim, banner, caption, creditRow } = takeoverScene(
    "PR MERGED!",
    C.amber,
    event,
    "merged by",
  );
  const bannerY = banner.y;

  // A dropped-in clip takes the trophy slot; no clips (or a clip whose file has
  // since been rotated away), the trophy keeps its job.
  const trophy = pixelSprite("trophy16", 7);
  trophy.position.set(W / 2, H / 2 - 240 - LIFT);
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
      dim.alpha = Math.min(progress * 4, ON_CARD ? 1 : 0.85) * (progress > 0.85 ? (1 - progress) / 0.15 : 1);
      banner.scale.set(Math.min(elapsed / 220, 1) * (1 + Math.sin(elapsed / 160) * 0.06));
      banner.y = bannerY + Math.sin(elapsed / 200) * 18;
      caption.alpha = Math.min(elapsed / 400, 1);
      creditRow.alpha = Math.min(elapsed / 400, 1);
      trophy.rotation = Math.sin(elapsed / 260) * 0.25;
      trophy.y = H / 2 - 240 - LIFT + Math.sin(elapsed / 180) * 14;
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

/**
 * wau-target-hit: today's new WUU beating the same weekday last week. Rarer than
 * a merge and nobody's PR, so it holds the board longer: the confetti keeps
 * raining and the fireworks re-fire until the dim lifts.
 */
function wauTakeover(event, done) {
  // No PR and no Actor, so the shared caption and credit start empty and get the
  // target's own copy instead.
  const { scene, dim, banner, caption, credit, creditRow, fit } = takeoverScene(
    "CONGRATULATIONS!",
    C.amber,
    {},
    "",
  );
  const day = typeof event.label === "string" && event.label ? event.label.toUpperCase() : "";
  caption.text = `WE BEAT LAST ${day || "WEEK"}'S NEW WUU`;
  const whole = new Intl.NumberFormat().format;
  if ([event.current, event.previous].every(Number.isFinite))
    credit.text = `${whole(event.current)} NEW WUU TODAY  /  ${whole(event.previous)} LAST ${day.slice(0, 3) || "WEEK"}`;
  fit();
  const bannerY = banner.y;

  const trophy = pixelSprite("trophy16", 7);
  trophy.position.set(W / 2, H / 2 - 240 - LIFT);
  const clip = showCelebrationClip(15_000, () => {
    if (!trophy.destroyed) trophy.visible = true;
  });
  trophy.visible = !clip;
  scene.addChild(trophy);

  // Sparks first so the confetti can have whatever is left of the particle ceiling.
  const SPARKS = 36;
  const launch = (spark) => {
    spark.position.set(W / 2, H / 2 - 120);
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 8;
    spark.vx = Math.cos(angle) * speed;
    spark.vy = Math.sin(angle) * speed;
  };
  const fireworks = particles(scene, SPARKS, () => {
    const spark = new Sprite(pixelTexture("star"));
    spark.anchor.set(0.5);
    spark.scale.set(3);
    spark.tint = [C.amber, C.magenta, C.ink][Math.floor(Math.random() * 3)];
    spark.spin = 0.1;
    launch(spark);
    return spark;
  });

  const drop = (piece) => {
    piece.x = Math.random() * W;
    piece.vx = (Math.random() - 0.5) * 2;
    piece.vy = 3 + Math.random() * 5;
  };
  const confetti = particles(scene, MAX_PARTICLES - SPARKS, () => {
    const piece = new Sprite(dotTexture());
    piece.anchor.set(0.5);
    piece.scale.set(6 + Math.random() * 6);
    piece.tint = [C.amber, C.magenta, C.green, C.ink, C.orange][
      Math.floor(Math.random() * 5)
    ];
    piece.y = -Math.random() * H;
    piece.spin = (Math.random() - 0.5) * 0.3;
    drop(piece);
    return piece;
  });

  const BURST_MS = 1500;
  let burst = 0;
  runScene(
    layers.takeover,
    scene,
    12_000,
    (progress, elapsed, delta) => {
      dim.alpha = Math.min(progress * 12, ON_CARD ? 1 : 0.85) * (progress > 0.9 ? (1 - progress) / 0.1 : 1);
      banner.scale.set(Math.min(elapsed / 220, 1) * (1 + Math.sin(elapsed / 160) * 0.06));
      banner.y = bannerY + Math.sin(elapsed / 200) * 18;
      caption.alpha = Math.min(elapsed / 400, 1);
      creditRow.alpha = Math.min(elapsed / 400, 1);
      trophy.rotation = Math.sin(elapsed / 260) * 0.25;
      trophy.y = H / 2 - 240 - LIFT + Math.sin(elapsed / 180) * 14;
      stepParticles(confetti, delta, 0.12);
      // Recycle what falls off the bottom so the rain lasts; stop as the dim
      // lifts, so the last of it drains away instead of vanishing mid-air.
      for (const piece of confetti) {
        if (piece.y > H + 40 && progress < 0.88) {
          piece.y = -40;
          drop(piece);
        }
      }
      if (Math.floor(elapsed / BURST_MS) > burst) {
        burst = Math.floor(elapsed / BURST_MS);
        fireworks.forEach(launch);
      }
      stepParticles(fireworks, delta, 0.1);
      for (const spark of fireworks) spark.alpha = 1 - (elapsed % BURST_MS) / BURST_MS;
    },
    () => {
      clip?.();
      done?.();
    },
  );
}

/**
 * scheduled-celebration: an Admin Console message given the merge's confetti and
 * fireworks. No PR and no Actor, so the caption and credit stay empty and the
 * headline takes the middle of the card, wrapped to fit. Longer than a merge, so
 * the whole message gets read.
 */
function scheduledTakeover(event, done) {
  const { scene, dim, banner, fit } = takeoverScene(String(event.text ?? ""), C.amber, {}, "");
  const scale = fitWrapped(banner, 1640, 300);
  banner.scale.set(scale);
  fit();
  // Nothing sits around the headline: the card's middle (see takeoverScene's fit),
  // or the band's.
  const y = ON_CARD ? banner.y : H / 2 + 25;
  banner.y = y;

  // Behind the copy, just above the dim: a merge's two words survive confetti on
  // top, a sentence does not.
  const fx = scene.addChildAt(new Container(), 1);
  const confetti = particles(fx, 110, () => {
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

  const fireworks = particles(fx, 36, () => {
    const spark = new Sprite(pixelTexture("star"));
    spark.anchor.set(0.5);
    spark.scale.set(3);
    spark.tint = [C.amber, C.magenta, C.ink][Math.floor(Math.random() * 3)];
    spark.position.set(W / 2, y);
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
    8000,
    (progress, elapsed, delta) => {
      dim.alpha = Math.min(progress * 6, ON_CARD ? 1 : 0.85) * (progress > 0.88 ? (1 - progress) / 0.12 : 1);
      banner.scale.set(scale * Math.min(elapsed / 220, 1) * (1 + Math.sin(elapsed / 160) * 0.06));
      banner.y = y + Math.sin(elapsed / 200) * 18;
      stepParticles(confetti, delta, 0.12);
      stepParticles(fireworks, delta, 0.1);
      for (const spark of fireworks) spark.alpha = 1 - progress;
    },
    done,
  );
}

/** review-approved: a stamp slamming down inside an expanding shockwave ring. */
function approvedTakeover(event, done) {
  const { scene, dim, banner, caption, creditRow } = takeoverScene(
    "APPROVED!",
    C.green,
    event,
    "approved by",
  );
  // The card's headline stays where takeoverScene's fit laid it.
  if (!ON_CARD) banner.y = H / 2 - 40;

  const ring = new Sprite(ringTexture());
  ring.anchor.set(0.5);
  ring.tint = C.green;
  ring.position.set(W / 2, banner.y);
  scene.addChildAt(ring, 1);

  const stamp = pixelSprite("check16", 10, C.green);
  stamp.position.set(W / 2, H / 2 - 250 - LIFT);
  scene.addChild(stamp);

  const sparks = particles(scene, 48, () => {
    const spark = new Sprite(pixelTexture("star"));
    spark.anchor.set(0.5);
    spark.scale.set(2.5);
    spark.tint = C.green;
    spark.position.set(W / 2, banner.y);
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
      dim.alpha = Math.min(progress * 5, ON_CARD ? 1 : 0.8) * (progress > 0.85 ? (1 - progress) / 0.15 : 1);
      // The stamp drops fast, overshoots, settles.
      const drop = Math.min(elapsed / 320, 1);
      stamp.scale.set(24 - 12 * drop + Math.sin(drop * Math.PI) * 4);
      stamp.alpha = drop;
      banner.scale.set(drop < 1 ? drop * 0.9 : 1 + Math.sin(elapsed / 150) * 0.04);
      caption.alpha = Math.min(elapsed / 400, 1);
      creditRow.alpha = Math.min(elapsed / 400, 1);
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

/** Returns whether the scene runs; `done` only fires for one that did. */
function ambientScene(container, duration, update, done) {
  if (ambientLive >= 6) {
    container.destroy({ children: true });
    return false;
  }
  ambientLive++;
  runScene(layers.fx, container, duration, update, () => {
    ambientLive--;
    done?.();
  });
  return true;
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
  // Inside the Feed's right edge, so the drift never crosses the Status panel.
  crate.position.set(FEED_W - 80, 320);
  scene.addChild(crate);
  ambientScene(scene, 1400, (progress, elapsed) => {
    crate.x = FEED_W - 80 + progress * 60;
    crate.y = 320 + progress * progress * 900;
    crate.rotation = progress * 3;
    crate.alpha = 1 - progress * 0.6;
  });
}

/** changes-requested: a red bang shakes over the Feed and the panel edge flashes. */
function changesRequestedAnimation() {
  const scene = new Container();
  const flash = new Graphics()
    .roundRect(24, 204, PANEL_W, 756, 10)
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

// Day Chimes and Reminders share the middle of the screen, so one fired the same
// minute as another (a 09:00 Reminder lands with the 09:00 chime) waits its turn
// instead of drawing over it. `show` gets the `done` it must call once.
// It also waits out a takeover, and a takeover waits for it (see stageBusy).
const banners = [];
function queueBanner(show) {
  banners.push(show);
  chimes++;
  nextBanner();
}
function nextBanner() {
  if (stageBusy) return;
  const show = banners.shift();
  if (!show) return applyTheme();
  stageBusy = true;
  show(() => {
    stageBusy = false;
    chimes--;
    // A takeover that waited out this banner goes before any further banners.
    if (pending.length) playNextCelebration();
    else nextBanner();
  });
}

/** Day Chime: a banner sweeps across the marquee line and the bell plays. */
function chime(at = "", last = at === "17:00") {
  queueBanner((done) => chimeScene(at, last, done));
}

function chimeScene(at, endOfDay, done) {
  // Neobrutal sets the chime on the takeover card, every line in ink.
  const scene = ON_CARD ? tilted() : new Container();
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

  const banner = label(
    headline,
    54,
    ON_CARD ? C.ink : C.heroInk,
    ON_CARD
      ? undefined
      : { dropShadow: { color: C.bg, distance: 4, blur: 0, angle: Math.PI / 4, alpha: 1 } },
  );
  const stand = label(standCall, 42, C.ink);
  const congrats = congratsText ? label(congratsText, 42, ON_CARD ? C.ink : C.amber) : null;
  const rows = congrats ? [banner, stand, congrats] : [banner, stand];

  if (ON_CARD) {
    const widest = Math.min(1840, Math.max(...rows.map((row) => row.width)));
    scene.addChild(card(new Graphics(), Math.min(widest + 160, W - 40), rows.length * 76 + 80, H / 2));
  } else {
    const backing = new Sprite(dotTexture());
    backing.anchor.set(0.5);
    backing.width = W;
    backing.height = congrats ? 300 : 230;
    backing.tint = C.bg;
    backing.alpha = 0.85;
    backing.position.set(W / 2, H / 2);
    scene.addChild(backing);
  }
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
  const shown = ambientScene(scene, 10_000, (progress, elapsed) => {
    const fade =
      progress < 0.05 ? progress / 0.05 : progress > 0.92 ? (1 - progress) / 0.08 : 1;
    scene.alpha = fade;
    banner.scale.set((0.9 + Math.min(fade, 1) * 0.1) * bannerFit);
    // The extra lines fade in one beat apart.
    rows.forEach((row, i) => {
      if (i > 0) row.alpha = Math.min(Math.max((elapsed - 600 * i) / 500, 0), 1) * fade;
    });
  }, done);
  if (!shown) done();
}

/**
 * Reminder: an Admin Console message on the Day Chime's banner for the same 10s,
 * with its clip (or the bell's jingle) when Quiet Hours allow. Not a takeover and
 * never a Feed row. Somebody scheduled it, so unlike the chime it does not yield
 * to the ambient-scene cap.
 */
function reminder({ text, sound = null, audible = false }, done) {
  if (audible) playClip(sound, "day-chime");
  const scene = ON_CARD ? tilted() : new Container();
  const line = label(
    String(text ?? ""),
    72,
    ON_CARD ? C.ink : C.heroInk,
    ON_CARD
      ? undefined
      : { dropShadow: { color: C.bg, distance: 4, blur: 0, angle: Math.PI / 4, alpha: 1 } },
  );
  const fit = fitWrapped(line, 1760, 240);
  const height = line.height * fit;
  if (ON_CARD) {
    scene.addChild(card(new Graphics(), Math.min(line.width * fit + 160, W - 40), height + 120, H / 2));
  } else {
    const backing = new Sprite(dotTexture());
    backing.anchor.set(0.5);
    backing.width = W;
    backing.height = height + 140;
    backing.tint = C.bg;
    backing.alpha = 0.85;
    backing.position.set(W / 2, H / 2);
    scene.addChild(backing);
  }
  line.anchor.set(0.5);
  line.position.set(W / 2, H / 2);
  scene.addChild(line);

  runScene(layers.fx, scene, 10_000, (progress) => {
    const fade =
      progress < 0.05 ? progress / 0.05 : progress > 0.92 ? (1 - progress) / 0.08 : 1;
    scene.alpha = fade;
    line.scale.set((0.9 + fade * 0.1) * fit);
  }, done);
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
//    devDeploy:{actor,at}|null,                 (last teammate to deploy to dev)
//    theme:"<name>"}                            (theme to wear; absent/unknown = no opinion)
//   on connect and after every recorded event, then bare domain
//   events {type, repo, number, title, actor}; actor is the GitHub login of whoever
//   did it (merger, reviewer, commenter), always a string and "" when GitHub named
// nobody. Events that make a sound — the Celebrations plus pr-opened — carry
// audible:true|false (Quiet Hours) and teammate:true|false (clip or jingle);
// every other Ambient Event carries neither and stays silent. And
//   {type:"day-chime", at:"HH:MM", last} marks the start and end of the workday;
//   last:true is the day's final chime (old servers send none: 17:00 is the end).
//   {type:"wau-target-hit", audible, label, current, previous} is a Celebration
//   with no PR (today's new WUU beating the same weekday last week; label is the
//   weekday): it takes the board over but never joins the Feed.
//   {type:"reminder", text, sound, audible} is a scheduled banner and
//   {type:"scheduled-celebration", text, sound, audible} a scheduled takeover, both
//   from the Admin Console; sound is "sounds/….mp3" or null (jingle). No Feed row.
//   The snapshot's sounds:{slot:"sounds/….mp3"} names the Admin Console's assigned
//   slots; absent (old servers) keeps the clips the page has.
// --------------------------------------------------------------------------------

function handleMessage(data) {
  if (data.type === "day-chime") {
    chime(data.at ?? "", data.last ?? data.at === "17:00");
    return;
  }
  if (data.type === "reminder") {
    queueBanner((done) => reminder(data, done));
    return;
  }
  if (data.type === "scheduled-celebration") {
    celebrate(data.type, data, Boolean(data.audible));
    return;
  }
  // Not a PR, so no Feed row — renderFeed would trip over the missing repo.
  if (data.type === "wau-target-hit") {
    if (THEME_NAME === "arcade") {
      // Cancels any switch away still held behind a takeover: the server has just
      // put the board in arcade, so leaving would only bounce straight back.
      wantTheme = "arcade";
      celebrate(data.type, data, Boolean(data.audible));
    } else {
      sessionStorage.setItem(PENDING_CELEBRATION, JSON.stringify(data));
      wantTheme = "arcade";
      applyTheme();
    }
    return;
  }
  if (data.type === "snapshot") {
    // Absent from old servers, or a theme this page doesn't know: no opinion, so
    // no reload.
    if (typeof data.theme === "string" && Object.hasOwn(THEMES, data.theme)) {
      wantTheme = data.theme;
      applyTheme();
    }
    if (data.sounds) setSamples(data.sounds);
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
renderStatus(null);
renderHeadlines([]);
void loadWau();
void loadStatus();
void loadHeadlines();
setInterval(() => void loadWau(), WAU_REFRESH_MS);
setInterval(() => void loadStatus(), STATUS_REFRESH_MS);
setInterval(() => void loadHeadlines(), NEWS_REFRESH_MS);

// The Target Hit that switched this page into the Arcade Theme plays now.
playHeldCelebration();

// Visual QA hook: the canvas can only be checked by a human, so every animation and
// every sound can be fired from the browser console.
//   arcade.demo()                      — one of everything, in order
//   arcade.event({type:"pr-merged", repo:"a/b", number:7, title:"x", audible:true})
//   arcade.celebrate("review-approved") / arcade.ambient("pr-comment") / arcade.chime("09:00")
//   arcade.celebrate("wau-target-hit") — the Target Hit takeover with sample numbers
//   arcade.celebrate("scheduled-celebration") / arcade.reminder("Standup in 5")
//     — the Admin Console's scheduled takeover and banner with sample copy
//   arcade.play("pr-merged")           — sound only
//   arcade.ambient() animates silently; pr-opened's sound rides the audible flag, so
//   hear it with arcade.play("pr-opened") or arcade.event({...,"audible":true})
//   arcade.setMvp({names:["Maximus"],count:12}) / arcade.setMvp(null) — marquee MVP
//   arcade.setDevDeploy({actor:"Maximus"}) / arcade.setDevDeploy(null) — feed header
//   arcade.setWau() / arcade.setWau(undefined, true) / arcade.setWau(null, true)
//     — sample success / stale / unavailable WUU states
//   arcade.setStatus({fetchedAt, services:[{name:"GITHUB", level:"minor", text:"..."}]})
//     / arcade.setStatus(null) — Status panel lights, (data, true) for stale
//   arcade.setHeadlines(["A very important AI headline"]) — bottom news ticker
//   ?theme=arcade — load in a theme from public/themes (arcade is the pre-reskin
//     look a Target Hit puts on until midnight); the server's snapshot `theme`
//     field reloads the page into whichever theme it names
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
  today: 2, // Monday, still short of last Monday: ticks for Sat and Sun, a cross for Mon
  onTarget: "behind",
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
  celebrate: (type = "pr-merged", audible = true) =>
    celebrate(
      type,
      type === "wau-target-hit"
        ? { type, label: "Monday", current: 2214, previous: 2103 }
        : type === "scheduled-celebration"
          ? { type, text: "Happy birthday Maximus! Cake in the kitchen at 3pm", sound: null }
          : sample(type),
      audible,
    ),
  reminder: (text = "Sprint review in 10 minutes. Grab a coffee and bring your demos!", sound = null) =>
    handleMessage({ type: "reminder", text, sound, audible: true }),
  ambient,
  chime,
  play,
  setMvp,
  setDevDeploy,
  setWau: (data, stale = false) => renderWau(data === undefined ? sampleWau : data, stale),
  setStatus: renderStatus,
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
