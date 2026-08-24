#!/usr/bin/env bash
#
# Launched by pr-arcade-kiosk.service. Waits for a desktop session and for the
# board to be served, turns off the cursor and screen blanking, then runs
# Chromium fullscreen forever.
#
# The port lives here and in /etc/pr-arcade.env — change both.

set -euo pipefail

# PR_ARCADE_FPS=1 adds the ?fps overlay: frame rate + which GPU/renderer WebGL got.
URL="http://localhost:3000/${PR_ARCADE_FPS:+?fps}"

# Wait for something to draw on: this service can start before the compositor
# after a cold boot. Detected rather than hardcoded in the unit, because the
# wayland socket name varies by session (wayfire, labwc, X-only).
RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DISPLAY="${DISPLAY:-:0}"
for _ in $(seq 1 60); do
  for sock in "$RUNTIME"/wayland-[0-9]*; do
    # -S skips the .lock files sitting next to the socket.
    if [ -S "$sock" ]; then export WAYLAND_DISPLAY="${sock##*/}"; fi
  done
  if [ -n "${WAYLAND_DISPLAY:-}" ] || [ -e /tmp/.X11-unix/X0 ]; then break; fi
  sleep 1
done

# The board renders 1080p; a 4K output makes V3D composite ~8MP twice per frame
# (10 FPS territory), and many TVs only take 4K at 30Hz anyway. Force 1080p60 and
# let the TV's scaler do the stretch. Best-effort: a TV with no such mode keeps
# whatever the compositor picked.
if command -v wlr-randr >/dev/null 2>&1 && [ -n "${WAYLAND_DISPLAY:-}" ]; then
  OUTPUT="$(wlr-randr | awk 'NR==1 {print $1}')"
  if [ -n "$OUTPUT" ]; then
    wlr-randr --output "$OUTPUT" --mode 1920x1080@60 2>/dev/null \
      || echo "kiosk: could not force 1080p on $OUTPUT; check wlr-randr" >&2
  fi
fi

# Chromium caches whatever it loads first, so don't start it until the server
# is actually answering — otherwise the TV shows a connection-refused page.
until curl -sfo /dev/null "$URL"; do sleep 2; done

# X11 only (incl. XWayland). On a pure Wayland session this is a no-op and
# blanking is handled by `raspi-config nonint do_blanking 1` instead.
if command -v xset >/dev/null 2>&1; then
  xset s off -dpms s noblank || true
fi

# Hide the mouse pointer. The page already asks for none (CSS cursor:none), but
# the arrow Chromium shows while the page is still loading comes from the cursor
# theme — and under Wayland unclutter can't touch it. deploy/blank-cursor is a
# theme whose every cursor is one transparent pixel; both libwayland-cursor and
# libXcursor read these env vars, so no session type ever draws an arrow.
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export XCURSOR_THEME=blank-cursor
export XCURSOR_PATH="$DEPLOY_DIR:/usr/share/icons:$HOME/.local/share/icons"
# X11 belt-and-braces: hides the pointer even off the Chromium window. Dies with
# the service (same cgroup); a no-op under Wayland.
if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 0 &
fi

# Chromium picks its audio output device once, at startup, and never re-picks. The
# mode change above re-negotiates HDMI, which drops and re-registers the sink — and
# on a deploy-triggered restart the server is already up, so the wait above returns
# instantly and Chromium can beat the sink back. Losing that race is silent: the
# board renders perfectly and never makes a sound again until the kiosk restarts.
# Best-effort, like the mode force — a Pi without pactl just carries on.
if command -v pactl >/dev/null 2>&1; then
  for _ in $(seq 1 20); do
    if [ -n "$(pactl list short sinks 2>/dev/null)" ]; then break; fi
    sleep 1
  done
  if [ -z "$(pactl list short sinks 2>/dev/null)" ]; then
    echo "kiosk: no audio sink after 20s; the board will be silent" >&2
  fi
fi

CHROMIUM="$(command -v chromium-browser || command -v chromium || true)"
if [ -z "$CHROMIUM" ]; then
  echo "no chromium-browser/chromium on PATH" >&2
  exit 1
fi

# --autoplay-policy is load-bearing: without it Chromium mutes the jingles
# because a display-only page never gets a user gesture.
# --password-store=basic keeps Chromium away from GNOME Keyring: under autologin
# no password was typed, the keyring can't auto-unlock, and it pops a dialog on
# every boot. The kiosk stores no credentials, so the keyring buys nothing.
# The GPU flags are load-bearing on a Pi: under XWayland Chromium often falls
# back to software WebGL (SwiftShader/llvmpipe) and the whole board runs in
# slow motion. ozone-platform-hint=auto picks native Wayland when the session
# has it, which is where V3D acceleration actually works.
exec "$CHROMIUM" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --password-store=basic \
  --ozone-platform-hint=auto \
  --ignore-gpu-blocklist \
  --enable-gpu-rasterization \
  --enable-zero-copy \
  "$URL"
