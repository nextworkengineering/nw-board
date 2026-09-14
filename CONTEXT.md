# CONTEXT.md

Glossary for the PR arcade display (Raspberry Pi + TV, GitHub activity).

## Terms

- **Celebration Event** — an event worth fanfare: a PR merged or a review approval. Triggers a prominent animation and a short sound effect.
- **Ambient Event** — any other tracked event (PR opened, PR closed without merge, changes requested, PR comment). Shown as an animation in the background feed, never taking the board over. Silent, with one exception: a PR opened also plays a short sound effect, gated by Quiet Hours and the roster exactly like a Celebration Event. It is still Ambient — the distinction is the takeover, not the noise.
- **Tracked Repo** — a repository on the curated list whose activity feeds the display. Activity from any other repo is ignored.
- **Quiet Hours** — a configured daily window during which Celebration Events animate but make no sound.
- **Backfill** — fetching the current state of Tracked Repos (open PRs, recent activity) at startup, so the display is never empty and missed events don't leave gaps.
- **Feed** — the ambient stream of the last 24 hours of tracked events.
- **MVP** — the Actor with the most PR merges since local midnight. Only merges count; a tie names every contender and the marquee rotates between them. Resets at midnight; a day with no merges yet is Anyone's Game.
- **Day Chime** — a scheduled sound marking the start (09:00) and end (17:00) of the workday, weekdays only. Not tied to any event.
- **Actor** — who did the thing: merged, reviewed, commented, opened. Shown as the team member's first name via the config names map; a login with no mapping shows as-is.
- **In Dev** — the last teammate to trigger a successful run of the `devDeployWorkflow`. Board state, not an event: it sits on the Feed header until someone else deploys. Roster-only — a run triggered by a bot names nobody.
- **In Flight** — the currently open PRs across the Tracked Repos. Board state, not events: an open PR stays visible however long ago it was opened, and leaves when merged or closed.
