# CONTEXT.md

Glossary for the PR arcade display (Raspberry Pi + TV, GitHub activity).

## Terms

- **Celebration Event** — an event worth fanfare: a PR merged, a review approval, or a Target Hit. Triggers a prominent animation and a short sound effect.
- **Target Hit** — the WAU panel's weekly target reaching 100%. A Celebration Event not tied to a PR: takes the board over (longer than a merge) with applause, gated by Quiet Hours. Fires once per crossing from below 100%, so a restart that boots already over target stays quiet.
- **Theme** — the board's whole look: palette, type, decorations. Exactly one at a time. Board state, not an event: the config names the default, a live override from the Pi swaps it until local midnight (or until cleared), and a Target Hit wears the Arcade Theme until local midnight the same way. A permanent switch from the Pi rewrites the config's default instead, so it survives restarts. Whichever was set last wins.
- **Arcade Theme** — the Theme that is the board's old pre-reskin look (its palette and monospace type), worn from a Target Hit until local midnight. A display connecting mid-day still gets it, and midnight puts the configured Theme back.
- **Ambient Event** — any other tracked event (PR opened, PR closed without merge, changes requested, PR comment). Shown as an animation in the background feed, never taking the board over. Silent, with one exception: a PR opened also plays a short sound effect, gated by Quiet Hours and the roster exactly like a Celebration Event. It is still Ambient — the distinction is the takeover, not the noise.
- **Tracked Repo** — a repository on the curated list whose activity feeds the display. Activity from any other repo is ignored.
- **Quiet Hours** — a configured daily window during which Celebration Events animate but make no sound.
- **Backfill** — fetching the current state of Tracked Repos (open PRs, recent activity) at startup, so the display is never empty and missed events don't leave gaps.
- **Feed** — the ambient stream of the last 24 hours of tracked events.
- **MVP** — the Actor with the most PR merges since local midnight. Only merges count; a tie names every contender and the marquee rotates between them. Resets at midnight; a day with no merges yet is Anyone's Game.
- **Day Chime** — a scheduled sound at each configured time (09:00 and 17:00 by default), weekdays only. The day's last chime is the end-of-day one; any earlier one is a start-of-day chime. Not tied to any event.
- **Reminder** — a scheduled text banner with an optional clip, either one-off on a date or weekly on chosen days. Never takes the board over and never joins the Feed. Its sound is gated by Quiet Hours; the banner shows regardless.
- **Scheduled Celebration** — a scheduled takeover with a custom message and an optional clip, one-off on a date or weekly on chosen days. A Celebration Event not tied to a PR, like a Target Hit: gated by Quiet Hours, and never joins the Feed.
- **Sound Library** — every clip the board can play: the ones committed in `public/sounds/` plus the ones uploaded through the Admin Console. Each sound slot (merge, approval, PR opened, the Day Chimes, Target Hit) plays the clip assigned to it, or its default. Every upload is normalized before it joins the Library.
- **Admin Console** — the tailnet-only page for changing board state without SSH: Theme, the Sound Library and slot assignments, Reminders and Scheduled Celebrations, Quiet Hours, Day Chimes and names, and replaying the Target Hit. Its writes persist to `config.json` and survive restarts, except a live Theme switch, which lasts until local midnight like one made on the Pi. Never reachable through the Funnel.
- **Actor** — who did the thing: merged, reviewed, commented, opened. Shown as the team member's first name via the config names map; a login with no mapping shows as-is.
- **In Dev** — the last teammate to trigger a successful run of the `devDeployWorkflow`. Board state, not an event: it sits on the Feed header until someone else deploys. Roster-only — a run triggered by a bot names nobody.
- **In Flight** — the currently open PRs across the Tracked Repos. Board state, not events: an open PR stays visible however long ago it was opened, and leaves when merged or closed.
