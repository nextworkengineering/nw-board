#!/usr/bin/env bash
#
# Installs and enables the two systemd units. Run ON THE PI, as the user the
# display should run as (not root — the kiosk is a user unit and needs your
# session). Safe to re-run.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="$(id -un)"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NPM="$(command -v npm || true)"

if [ -z "$NPM" ]; then
  echo "npm is not on PATH — install Node 22 first (deploy/setup-wizard.sh does it)." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the display user, not root — it uses sudo where it needs to." >&2
  exit 1
fi

if [ ! -f /etc/pr-arcade.env ]; then
  echo "/etc/pr-arcade.env is missing. Run deploy/setup-wizard.sh first." >&2
  exit 1
fi

# The Admin Console normalizes uploaded clips with scripts/normalize-sound.py,
# which shells out to lame to decode and re-encode them.
if ! command -v lame >/dev/null 2>&1; then
  echo "==> Installing lame (for Admin Console sound uploads)"
  sudo apt-get install -y lame
fi

echo "==> Installing server unit (repo: $REPO_DIR, user: $RUN_USER, npm: $NPM)"
sudo install -D -m 644 "$REPO_DIR/deploy/pr-arcade.service" \
  /etc/systemd/system/pr-arcade.service
# Drop-in instead of templating: systemd's own way of saying "same unit, local
# paths". The unit ships without User/WorkingDirectory/ExecStart precisely so
# this is the only place they're defined.
sudo install -d -m 755 /etc/systemd/system/pr-arcade.service.d
sudo tee /etc/systemd/system/pr-arcade.service.d/10-local.conf >/dev/null <<EOF
[Service]
User=$RUN_USER
WorkingDirectory=$REPO_DIR
ExecStart=$NPM start
EOF

echo "==> Holding the server at boot until NTP has set the clock"
# Ask whichever NTP client is running: systemd-time-wait-sync only knows about
# timesyncd, so under chrony it would wait out its whole timeout every boot.
WAIT_UNIT=""
if systemctl is-active --quiet chrony.service; then
  WAIT_UNIT=chrony-wait.service
elif systemctl is-active --quiet systemd-timesyncd.service; then
  WAIT_UNIT=systemd-time-wait-sync.service
fi
if [ -n "$WAIT_UNIT" ] && systemctl cat "$WAIT_UNIT" >/dev/null 2>&1; then
  # Capped: with no network the sync never comes, and a board on a stale clock
  # beats no board. The server only Wants= the sync, so a timeout still starts it.
  sudo install -d -m 755 "/etc/systemd/system/$WAIT_UNIT.d"
  printf '[Service]\nTimeoutStartSec=90\n' |
    sudo tee "/etc/systemd/system/$WAIT_UNIT.d/10-pr-arcade.conf" >/dev/null
  sudo systemctl enable "$WAIT_UNIT"
else
  echo "    no timesyncd or chrony running — the server will start on whatever the clock says" >&2
fi

echo "==> Installing kiosk unit"
install -D -m 644 "$REPO_DIR/deploy/pr-arcade-kiosk.service" \
  "$USER_UNIT_DIR/pr-arcade-kiosk.service"
install -d -m 755 "$USER_UNIT_DIR/pr-arcade-kiosk.service.d"
cat >"$USER_UNIT_DIR/pr-arcade-kiosk.service.d/10-local.conf" <<EOF
[Service]
ExecStart=$REPO_DIR/deploy/kiosk.sh
EOF
chmod +x "$REPO_DIR/deploy/kiosk.sh"

echo "==> Enabling"
sudo systemctl daemon-reload
sudo systemctl enable --now pr-arcade.service

# Everything below needs a user D-Bus. Over SSH without lingering there isn't
# one, and a hard failure here would take out whatever called us — so warn and
# carry on. The unit files are already on disk either way.
if systemctl --user daemon-reload 2>/dev/null &&
   systemctl --user enable pr-arcade-kiosk.service 2>/dev/null; then
  # Only meaningful from the Pi's own desktop session; over SSH the kiosk comes
  # up at the next boot/autologin instead.
  systemctl --user start pr-arcade-kiosk.service 2>/dev/null ||
    echo "    (kiosk not started now — it starts with the desktop session on next boot)"
else
  echo "    WARNING: no user session bus here, so the kiosk unit is installed but"
  echo "    NOT enabled. Run this on the Pi's own desktop session, or:"
  echo "      systemctl --user enable --now pr-arcade-kiosk.service"
fi

echo
echo "Done. Server:  sudo systemctl status pr-arcade"
echo "      Kiosk:   systemctl --user status pr-arcade-kiosk"
echo "      Logs:    journalctl -u pr-arcade -f"
