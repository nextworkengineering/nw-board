# nw-board (PR Arcade)

Arcade-style GitHub activity board for a Raspberry Pi + office TV. A Node
server receives GitHub webhooks for the Tracked Repos in `config.json`,
translates them into celebration/ambient events, and pushes them over a
WebSocket to a PixiJS front end running fullscreen in Chromium.

See `CONTEXT.md` for the domain vocabulary (Celebration Event, MVP, Quiet
Hours, Backfill, …) and `deploy/README.md` for everything Pi-specific.

## Run locally

Requires Node 20+.

```sh
npm ci
GITHUB_WEBHOOK_SECRET=dev npm start   # http://localhost:3000
```

- `GITHUB_WEBHOOK_SECRET` is required — the server refuses to start without it.
- `GITHUB_TOKEN` is optional locally; without it Backfill is skipped and the
  board fills from live webhooks only.
- `PORT` defaults to 3000.
- Real webhook deliveries need a public URL; production uses Tailscale Funnel.
  To fake an event locally, POST a signed payload to `/webhook` (see
  `test/webhook.test.ts` for the signature format).

## Test

```sh
npm test   # vitest, covers webhook handling, backfill, MVP, sound rules
```

## Brand tokens

Colors come from the NextWork brand kernel, pinned as the `kernel/` git
submodule and compiled into `public/kernel-tokens.gen.js` (committed, so the
Pi never needs the submodule). After a fresh clone, tests need it:

```sh
git submodule update --init kernel
```

To take a newer kernel: bump the submodule, `npm run kernel:sync`, commit the
regenerated file. `npm run kernel:check` (also part of `npm test`) fails when
the committed tokens drift from the submodule. `scripts/sync-kernel.mjs` is
the only writer — never hand-edit the generated file. Brand fonts are vendored
woff2 in `public/fonts/`; type scale, radii and spacing stay app-local.

## Update the deployed board

```sh
ssh <user>@pr-arcade.local pr-arcade/deploy/deploy.sh
```

Pulls, runs `npm ci` only if the lockfile changed, restarts the server and the
kiosk. Details, first-time setup (blank SD card → TV), and troubleshooting:
`deploy/README.md`.

## Watching webhook deliveries

The server logs one line per accepted delivery saying what became of it —
`recorded`, `repeat, dropped`, `ignored <event>/<action>`, or `untracked repo` —
keyed by the `X-GitHub-Delivery` id so you can match it to GitHub's
"Recent Deliveries" page.

On the Pi:

```sh
journalctl -u pr-arcade -f              # live tail
journalctl -u pr-arcade | grep webhook  # delivery outcomes only
```

Locally the same lines go to stdout of `npm start`.

Note: a green 204 in GitHub's webhook UI isn't proof it was ours — a repo can
have other webhooks on it (a chat notifier, say) returning their own 204s.
Check by the hook's `config.url`, then confirm the delivery id in the logs.

## Configuration

`config.json` holds Tracked Repos, Quiet Hours, Day Chime times, and the login →
first-name map. `devDeployWorkflow` is the file name of the deploy-to-dev
workflow whose last successful run names who's in dev. `newsFeedUrl` is the RSS
or Atom feed shown in the bottom ticker; the example uses TechCrunch's AI feed.
Feeds larger than 1 MiB are rejected. The server won't start without the file.

It is **gitignored** — it names your repos and your team, so it stays out of a
public repo. Copy the template and fill it in:

```sh
cp config.example.json config.json
```

Because it's untracked, edit it in place on whatever machine runs the board;
`deploy.sh` pulls straight past it. `setup-wizard.sh` creates it from the
template on a fresh clone and reads the Tracked Repo list back out of it. Existing
installs must add `newsFeedUrl` to their `config.json` and restart the service to
enable the news ticker.

Event sounds: the board plays `public/sounds/jetson.mp3` on a merge,
`public/sounds/omg.mp3` on an approval, and `public/sounds/metrooo.mp3` when a PR
is opened — all three are in git, so a deploy delivers them. The chimes are not:
`public/sounds/oh-my-gosh.mp3` (start of day) and
`public/sounds/super-mario-end.mp3` (end of day) have to be dropped in by hand on
each machine. Without a file the board falls back to that event's 8-bit jingle.
Clips only play for people on the `names` map — a bot or an unmapped login gets
the jingle, so adding a teammate to the map is what opts them in.

Opening a PR is the one Ambient Event with a sound. It keeps its quiet rocket
animation in the feed and never takes the board over, but Quiet Hours and
the roster gate it exactly like a Celebration Event. See `CONTEXT.md`.

A batch of PRs opened at once makes the noise once: the first plays and the rest
animate silently until a 1.5s cooldown expires. Takeovers queue instead, because
each owns the board for 5s — an ambient sound has no visual to wait for, and
twenty queued clips would still be playing long after the feed moved on.

Every clip carries at least 250ms of leading silence so a slow audio sink can't
clip its opening — `CLAUDE.md` has the one-off recipe for padding a new one.

Celebration clips: drop `.gif`/`.webp` files into `public/celebrations/` and a
merge takeover shows one at random in the trophy slot (the WWE-gif move). The
folder is gitignored like the sounds — the clips are somebody's copyrighted
footage, so they live only on the machine running the board. No folder or no
files means the pixel trophy carries the takeover, same as ever. Drop-ins are
picked up per merge, no restart needed.

Secrets live only in `/etc/pr-arcade.env` on the Pi
(`PORT`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`).
