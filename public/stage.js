// The board's stage: the middle of the screen, where one occasion plays at a time.
// Kept apart from the Pixi scenes in client.js, like audio.js, so the queue, the
// theme reload it holds off and the Target Hit it carries across that reload can
// be tested in Node without a renderer or a page to reload.

// A Target Hit on any other theme is held across the reload into the Arcade
// Theme, so its whole takeover plays in the arcade look. The page that writes it
// and the page that reads it can straddle a deploy, so the key never changes.
const PENDING_CELEBRATION = "pending-celebration";

/**
 * Build the stage for a page loaded in `theme`.
 * - runScene(takeover, done): draw a takeover ({type, event, audible}) and play its
 *   sound, then call `done` once it has left the screen.
 * - reload(theme): reload the page into `theme`. Only ever asked for a theme other
 *   than the one this page loaded with, so a reload cannot loop.
 * - storage: sessionStorage (getItem/setItem/removeItem).
 */
export function createStage({ runScene, reload, storage, theme }) {
  // Celebrations waiting their turn: two merges landing together play one after
  // the other rather than fighting over the middle of the screen.
  const pending = [];
  // Day Chimes and Reminders waiting their turn: one fired the same minute as
  // another (a 09:00 Reminder lands with the 09:00 chime) waits instead of drawing
  // over it. Each is a `show(done)` that must call `done` once.
  const banners = [];
  // One occasion on screen at a time: true while a takeover or a banner is
  // showing. A Reminder and a Scheduled Celebration fired the same minute arrive
  // back to back, and a chime can land mid-merge; without the shared flag each
  // started over the other, texts overlapping and both sounds at once. Whichever
  // waits starts when the other finishes (see the two `done`s).
  let stageBusy = false;
  // Theme switches are reloads, held until nothing is on screen or waiting so a
  // reload never cuts a takeover off, nor a bell mid-sound. Only a theme that
  // differs from the one this page loaded with triggers one.
  let wanted = theme;

  function applyTheme() {
    // Staying put (a switch called off before it happened, or the reload just
    // landed): any held Target Hit plays here rather than being lost.
    if (wanted === theme) {
      playHeld();
      return;
    }
    // A banner on screen keeps stageBusy set, so this also covers every Day Chime
    // and Reminder that is showing or queued.
    if (stageBusy || pending.length > 0 || banners.length > 0) return;
    reload(wanted);
  }

  /** Play the Target Hit the page before this reload held for it, if any. */
  function playHeld() {
    const held = storage.getItem(PENDING_CELEBRATION);
    if (!held) return;
    storage.removeItem(PENDING_CELEBRATION);
    const data = JSON.parse(held);
    takeover(data.type, data, Boolean(data.audible));
  }

  function playNext() {
    if (stageBusy) return;
    if (pending.length === 0) {
      applyTheme();
      return;
    }
    stageBusy = true;
    runScene(pending.shift(), () => {
      stageBusy = false;
      // A banner that waited out this takeover goes before any further takeovers.
      if (banners.length) nextBanner();
      else playNext();
    });
  }

  function nextBanner() {
    if (stageBusy) return;
    const show = banners.shift();
    if (!show) return applyTheme();
    stageBusy = true;
    show(() => {
      stageBusy = false;
      // A takeover that waited out this banner goes before any further banners.
      if (pending.length) playNext();
      else nextBanner();
    });
  }

  /** Queue a Celebration takeover. */
  function takeover(type, event = {}, audible = false) {
    pending.push({ type, event, audible });
    // ponytail: a huge burst of merges would queue up minutes of fanfare; if that ever
    // happens, drop all but the newest few here.
    playNext();
  }

  /** Queue a banner (Day Chime, Reminder): `show(done)` draws it. */
  function banner(show) {
    banners.push(show);
    nextBanner();
  }

  /** Wear `name`: reload into it once the stage is clear, or stay put if it is this page's. */
  function wantTheme(name) {
    wanted = name;
    applyTheme();
  }

  /** A Target Hit plays in the Arcade Theme, reloading into it first if need be. */
  function targetHit(data) {
    if (theme === "arcade") {
      // Cancels any switch away still held behind a takeover: the server has just
      // put the board in arcade, so leaving would only bounce straight back.
      wanted = "arcade";
      takeover(data.type, data, Boolean(data.audible));
    } else {
      storage.setItem(PENDING_CELEBRATION, JSON.stringify(data));
      wantTheme("arcade");
    }
  }

  return { takeover, banner, wantTheme, targetHit, playHeld };
}
