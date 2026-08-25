# 07 — Pi deployment & setup walkthrough

**What to build:** From blank SD card to a TV showing the board, with one-command updates afterwards. systemd units run the server and the Chromium kiosk (fullscreen, no cursor, auto-start on boot); a deploy script updates code and restarts services over SSH; a guided walkthrough covers the human-only steps: flashing Raspberry Pi OS, joining Tailscale and enabling Funnel, creating the fine-grained PAT, and registering the signed webhooks on the three Tracked Repos.

**Blocked by:** None — implementation is complete; only on-device acceptance remains.

**Status:** ready-for-human

- [ ] Powering on the Pi brings up the kiosk showing the board with no manual intervention
- [ ] The server restarts automatically if it crashes
- [x] Running the deploy script updates the code and restarts services (script logic verified locally; run on-device to confirm)
- [x] The walkthrough gets a fresh Pi through OS, Tailscale + Funnel, PAT creation, and webhook registration, with each step verifiable (run on-device 2026-08-14; several wizard fixes shipped from the run)
- [x] Webhook secret and PAT live in config/env on the Pi, not in the repo

## Comments

Built and adversarially reviewed (NEEDS-FIXES → all 14 findings fixed + dead code deleted). shellcheck -x clean; wizard signing logic, env-file round-trip, and compositor socket detection verified locally against the real server. Remaining acceptance criteria (cold boot → kiosk and crash restart) can only be verified on the physical Pi — hence ready-for-human: run deploy/setup-wizard.sh on the Pi. Requires GITHUB_TOKEN in `/etc/pr-arcade.env` and config.json at repo root.

**On-device run notes (2026-08-14):** deployed under the display user's home as `~/pr-arcade/nw-board`, reachable on the tailnet funnel hostname. Root-caused a silent live-miss to the hook never being registered (repo's only hook was a GitHub→Discord webhook whose 204s looked like success). Remaining: cold-boot-to-kiosk + crash-restart verification.
