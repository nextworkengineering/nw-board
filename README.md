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
- `POSTHOG_PERSONAL_API_KEY` enables the Weekly WAU Growth Tracker. Without it,
  the rest of the board runs and the WAU panel shows its retrying state.
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

## Themes

The board wears one Theme at a time: its palette, type and decorations. Each is a
file in `public/themes/`; `kernel` (the default), `arcade` and `neobrutal` ship
with the repo.

Set the default with `"theme": "<name>"` in `config.json` and restart the server.
It refuses to start on a name with no file.

Switch from the [Admin Console](#admin-console) (until midnight or permanently,
with a button for each), or with `curl` from the machine running the server:

```sh
curl -X POST 'http://127.0.0.1:3000/theme?name=neobrutal'            # wear it until local midnight
curl -X POST 'http://127.0.0.1:3000/theme?name=neobrutal&permanent'  # make it the default
curl -X DELETE http://127.0.0.1:3000/theme                           # back to the default now
```

A live switch lasts until local midnight, `DELETE /theme`, or a server restart,
then the default comes back. `&permanent` rewrites `"theme"` in `config.json`, so
it survives restarts, and shows at once over any live switch. A Weekly WAU target
hit puts on `arcade` until local midnight, the same way as a live switch. Whichever
was set last wins.

Every connected display reloads into the new Theme once no takeover or Day Chime
is playing or queued. Both routes answer only loopback requests without an
`X-Forwarded-For` header; if you put a proxy in front of the board, make sure it
sets that header.

To add a Theme, copy `public/themes/kernel.js` to `public/themes/<name>.js`, change
its values, and add it to `THEMES` in `public/themes/index.js`. Custom fonts go in
`public/fonts/` with an `@font-face` in `public/fonts.css`, and in the Theme's
`preload` list so they load before the board draws. `npm test` fails on a Theme
missing a palette key or a field the client reads, or one left out of `THEMES`.

## Admin Console

A page for changing the board without SSH, at `https://<tailnet-host>:8443` from
any device on the tailnet. From it you can:

- switch the Theme until midnight or permanently, or clear a live switch;
- upload mp3s into the Sound Library, preview or delete them, and assign a clip to
  each sound slot (merge, approval, PR opened, the two Day Chimes, Target Hit);
- schedule Reminders (a text banner, optional clip) and Scheduled Celebrations (a
  takeover with your message, optional clip), one-off on a date or weekly;
- edit Quiet Hours, Day Chime times and the names roster, live, no restart;
- replay the Target Hit.

Changes are written to `config.json`, so they survive restarts. Tracked Repos and
the other keys still need an edit and a restart. Each write is logged with the
Tailscale login that made it (`journalctl -u pr-arcade | grep admin:`).

The console has its own listener on `127.0.0.1:${ADMIN_PORT:-3001}` and nothing
else: the board's port 3000 serves none of it, so the Funnel can't reach it.
`tailscale serve` puts it on the tailnet. `setup-wizard.sh` does this, or once by
hand on the Pi:

```sh
sudo tailscale serve --bg --https=8443 http://127.0.0.1:3001
tailscale serve status    # https://<host>:8443 (tailnet only)
tailscale funnel status   # 8443 must not say "Funnel on"
```

**Never funnel 8443.** The console has no login of its own: the tailnet is the
lock, and anyone who can reach it can change the board.

Uploads are normalized on the Pi by `scripts/normalize-sound.py` (the same script
as by hand, see below), which needs `lame` there (`sudo apt install lame`; the
wizard and `install.sh` install it). Only mp3 is accepted, up to 10 MB and 30 s,
named `a-z`, `0-9` and `-`. The clips land in `public/sounds/uploads/`, which is
gitignored like `config.json`: they live only on the Pi, so back them up with it.
Clips committed in `public/sounds/` can be assigned but not deleted.

The console is tailnet-only, but what it sends the board is not: Reminder and
Celebration text reaches the TV over port 3000's WebSocket, and uploaded clips are
static files under `/sounds/uploads/`, so both are reachable through the Funnel.
Don't put anything private in them, unless the Funnel is scoped to the webhook with
`--set-path=/webhook` (see `deploy/README.md`).

## Configuration

`config.json` holds Tracked Repos, Quiet Hours, Day Chime times, and the login →
first-name map. `devDeployWorkflow` is the file name of the deploy-to-dev
workflow whose last successful run names who's in dev. `newsFeedUrl` is the RSS
or Atom feed shown in the bottom ticker; the example uses TechCrunch's AI feed.
Feeds larger than 1 MiB are rejected. `theme` is the default Theme (see
[Themes](#themes)). The server won't start without the file.

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

Event sounds: the board plays `public/sounds/mustard.mp3` on a merge,
`public/sounds/omg.mp3` on an approval, and `public/sounds/yo-pierre.mp3` when a PR
is opened — all three are in git, so a deploy delivers them. The chimes are not:
`public/sounds/oh-my-gosh.mp3` (start of day) and
`public/sounds/super-mario-end.mp3` (end of day) have to be dropped in by hand on
each machine, or uploaded through the [Admin Console](#admin-console) and assigned
to the chime slots. Without a file the board falls back to that event's 8-bit jingle.
Clips only play for people on the `names` map — a bot or an unmapped login gets
the jingle, so adding a teammate to the map is what opts them in.

Opening a PR is the one Ambient Event with a sound. It keeps its quiet rocket
animation in the feed and never takes the board over, but Quiet Hours and
the roster gate it exactly like a Celebration Event. See `CONTEXT.md`.

A batch of PRs opened at once makes the noise once: the first plays and the rest
animate silently until a 1.5s cooldown expires. Takeovers queue instead, because
each owns the board for 5s — an ambient sound has no visual to wait for, and
twenty queued clips would still be playing long after the feed moved on.

Every clip is normalized to the same loudness and carries at least 250ms of
leading silence so a slow audio sink can't clip its opening. Run a new one
through `scripts/normalize-sound.py` rather than dropping the download in
straight — as bought, the three clips spanned 16 dB, enough that the quietest
was inaudible after the loudest.

Celebration clips: drop `.gif`/`.webp` files into `public/celebrations/` and a
merge takeover shows one at random in the trophy slot (the WWE-gif move). The
folder is gitignored like the sounds — the clips are somebody's copyrighted
footage, so they live only on the machine running the board. No folder or no
files means the pixel trophy carries the takeover, same as ever. Drop-ins are
picked up per merge, no restart needed.

Secrets live only in `/etc/pr-arcade.env` on the Pi
(`PORT`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `POSTHOG_PERSONAL_API_KEY`).
The PostHog key needs `dashboard:read` and `query:read` access to project
`196853`; it stays on the server while the kiosk reads normalized results from
`/wau.json`. Existing installs can add the key to that file and restart
`pr-arcade` to enable the panel.
