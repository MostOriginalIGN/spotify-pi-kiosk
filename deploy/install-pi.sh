#!/usr/bin/env bash
set -euo pipefail

DEFAULT_APP_DIR=/opt/spotify-kiosk
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

prompt() {
  local message="$1"
  local default="${2:-}"
  local reply
  if [ -n "$default" ]; then
    read -r -p "$message [$default]: " reply
    printf '%s' "${reply:-$default}"
  else
    read -r -p "$message: " reply
    printf '%s' "$reply"
  fi
}

prompt_yes_no() {
  local message="$1"
  local default="${2:-y}"
  local reply
  read -r -p "$message [${default}]: " reply
  reply="${reply:-$default}"
  case "$reply" in
    y|Y|yes|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_secret() {
  local message="$1"
  local reply
  read -r -s -p "$message: " reply
  printf '\n' >&2
  printf '%s' "$reply"
}

write_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  node - "$file" "$key" "$value" <<'NODE'
const fs = require("node:fs");
const [file, key, value] = process.argv.slice(2);
const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
let found = false;
const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const line = /[\s#="'`]/.test(value) ? `${key}="${escaped}"` : `${key}=${value}`;
const next = lines.map((entry) => {
  if (entry.startsWith(`${key}=`)) {
    found = true;
    return line;
  }
  return entry;
});
if (!found) next.push(line);
fs.writeFileSync(file, `${next.join("\n").replace(/\n+$/, "")}\n`);
NODE
}

if [ -z "${INSTALL_APP_DIR_CONFIRMED:-}" ]; then
  echo
  echo "Spotify Kiosk installer"
  echo "======================="
  echo
  echo "This will install:"
  echo "  App files:     ${DEFAULT_APP_DIR}/"
  echo "  Config:        ${DEFAULT_APP_DIR}/.env"
  echo "  Data:          ${DEFAULT_APP_DIR}/data/"
  echo "  Systemd unit:  spotify-kiosk.service"
  echo "  Browser unit:  spotify-kiosk-browser.service (user session)"
  echo
  echo "Change the path if you use a different layout or disk."
  echo

  if prompt_yes_no "Use ${DEFAULT_APP_DIR}?" "y"; then
    APP_DIR="$DEFAULT_APP_DIR"
  else
    APP_DIR="$(prompt "Install directory" "$DEFAULT_APP_DIR")"
    APP_DIR="${APP_DIR%/}"
  fi

  if [ -z "$APP_DIR" ] || [ "$APP_DIR" = "/" ]; then
    echo "Invalid install directory."
    exit 1
  fi

  if ! prompt_yes_no "Proceed with install to ${APP_DIR}?" "y"; then
    echo "Cancelled."
    exit 0
  fi

  export APP_DIR INSTALL_APP_DIR_CONFIRMED=1

  if [ "$(id -u)" -ne 0 ]; then
    echo
    echo "sudo password needed for ${APP_DIR}, systemd services, and system packages."
    exec sudo -E env APP_DIR="$APP_DIR" INSTALL_APP_DIR_CONFIRMED=1 bash "$SCRIPT_DIR/install-pi.sh"
  fi
fi

APP_DIR="${APP_DIR:-$DEFAULT_APP_DIR}"

USER_NAME="${SUDO_USER:-${USER:-$(whoami)}}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
USER_UID="$(id -u "$USER_NAME")"
HOST_LABEL="$(hostname -s 2>/dev/null || hostname)"
DEFAULT_DEVICE_NAME="$HOST_LABEL"

require_node_version() {
  local version major
  version="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${version%%.*}"
  if [ -z "$major" ] || [ "$major" -lt 20 ]; then
    echo "Node.js 20+ is required (found: ${version:-none})."
    echo "Install a newer Node build, then run this script again."
    echo "See https://github.com/nodesource/distributions or use nvm."
    exit 1
  fi
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js not found. Installing nodejs and npm from apt..."
  apt-get update
  apt-get install -y nodejs npm
fi
require_node_version

echo "Installing for user: ${USER_NAME} (${USER_HOME})"
echo "Install directory: ${APP_DIR}"
echo

SPOTIFY_CLIENT_ID="$(prompt "Spotify Client ID")"
SPOTIFY_CLIENT_SECRET="$(prompt_secret "Spotify Client Secret")"
SPOTIFY_DEVICE_NAME="$(prompt "Spotify device name (must match the name in the Spotify app)" "$DEFAULT_DEVICE_NAME")"
PUBLIC_BASE_URL="$(prompt "Public base URL for OAuth redirect" "http://127.0.0.1:4928")"
SPOTIFY_REDIRECT_URI="${PUBLIC_BASE_URL%/}/api/auth/callback"

echo
echo "Spotify Connect hint overlay (shown periodically on the now-playing screen):"
if prompt_yes_no "Show the 'Connect from the Spotify app' hint?" "y"; then
  DEVICE_HINT_ENABLED=1
  DEVICE_HINT_INTERVAL_MS="$(prompt "Hint interval in minutes" "5")"
  DEVICE_HINT_INTERVAL_MS="$((DEVICE_HINT_INTERVAL_MS * 60000))"
else
  DEVICE_HINT_ENABLED=0
  DEVICE_HINT_INTERVAL_MS=300000
fi

echo
SETUP_RASPOTIFY=false
EDIT_RASPOTIFY_CONF=false
RASPOTIFY_DEVICE_NAME="$SPOTIFY_DEVICE_NAME"

if prompt_yes_no "Configure Raspotify integration?" "n"; then
  SETUP_RASPOTIFY=true
  if ! systemctl list-unit-files raspotify.service >/dev/null 2>&1; then
    echo
    echo "Raspotify is not installed yet."
    if prompt_yes_no "Install Raspotify now (apt)?" "y"; then
      curl -sSL https://dtcooper.github.io/raspotify/install.sh | sh
    else
      echo "Install Raspotify yourself, then re-run this script or finish setup manually."
    fi
  fi

  RASPOTIFY_DEVICE_NAME="$(prompt "Raspotify device name (LIBRESPOT_NAME)" "$SPOTIFY_DEVICE_NAME")"
  if prompt_yes_no "Edit /etc/raspotify/conf after install?" "n"; then
    EDIT_RASPOTIFY_CONF=true
  fi
fi

echo
echo "Copying app to ${APP_DIR}..."
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude data \
  "$SOURCE_DIR/" "$APP_DIR/"
chown -R "$USER_NAME:$USER_NAME" "$APP_DIR"

ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
fi

write_env_value "$ENV_FILE" "SPOTIFY_CLIENT_ID" "$SPOTIFY_CLIENT_ID"
write_env_value "$ENV_FILE" "SPOTIFY_CLIENT_SECRET" "$SPOTIFY_CLIENT_SECRET"
write_env_value "$ENV_FILE" "SPOTIFY_DEVICE_NAME" "$SPOTIFY_DEVICE_NAME"
write_env_value "$ENV_FILE" "PUBLIC_BASE_URL" "$PUBLIC_BASE_URL"
write_env_value "$ENV_FILE" "SPOTIFY_REDIRECT_URI" "$SPOTIFY_REDIRECT_URI"
write_env_value "$ENV_FILE" "DEVICE_HINT_ENABLED" "$DEVICE_HINT_ENABLED"
write_env_value "$ENV_FILE" "DEVICE_HINT_INTERVAL_MS" "$DEVICE_HINT_INTERVAL_MS"
if [ "$SETUP_RASPOTIFY" = true ]; then
  write_env_value "$ENV_FILE" "SPOTIFY_SYNC_CONNECT_TOKEN" "1"
  write_env_value "$ENV_FILE" "SPOTIFY_CONNECT_TOKEN_PATH" "./data/connect-token.env"
fi
chown "$USER_NAME:$USER_NAME" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Installing npm dependencies and building..."
cd "$APP_DIR"
sudo -u "$USER_NAME" npm install
sudo -u "$USER_NAME" npm run build
sudo -u "$USER_NAME" npm prune --omit=dev

echo "Installing systemd units..."
render_unit() {
  sed \
    -e "s|@APP_DIR@|${APP_DIR}|g" \
    -e "s|@USER@|${USER_NAME}|g" \
    -e "s|@USER_HOME@|${USER_HOME}|g" \
    -e "s|@USER_UID@|${USER_UID}|g" \
    "$1"
}
render_unit "$APP_DIR/deploy/spotify-kiosk.service" > /etc/systemd/system/spotify-kiosk.service

install -m 0755 "$APP_DIR/deploy/spotify-kiosk-raspotify-event" /usr/local/bin/spotify-kiosk-raspotify-event
install -d -m 0755 "$USER_HOME/.config/systemd/user"
render_unit "$APP_DIR/deploy/spotify-kiosk-browser.service" > "$USER_HOME/.config/systemd/user/spotify-kiosk-browser.service"
chown "$USER_NAME:$USER_NAME" "$USER_HOME/.config/systemd/user/spotify-kiosk-browser.service"

if [ "$SETUP_RASPOTIFY" = true ]; then
  mkdir -p /etc/systemd/system/raspotify.service.d
  install -m 0644 <(render_unit "$APP_DIR/deploy/raspotify-spotify-kiosk.conf") \
    /etc/systemd/system/raspotify.service.d/spotify-kiosk.conf

  mkdir -p /etc/raspotify
  if [ ! -f /etc/raspotify/conf ]; then
    touch /etc/raspotify/conf
  fi

  if ! grep -q '^LIBRESPOT_ONEVENT=' /etc/raspotify/conf 2>/dev/null; then
    printf '\nLIBRESPOT_ONEVENT="/usr/local/bin/spotify-kiosk-raspotify-event"\n' >> /etc/raspotify/conf
  fi

  if [ -n "$RASPOTIFY_DEVICE_NAME" ] && ! grep -q '^LIBRESPOT_NAME=' /etc/raspotify/conf 2>/dev/null; then
    printf 'LIBRESPOT_NAME="%s"\n' "$RASPOTIFY_DEVICE_NAME" >> /etc/raspotify/conf
  fi

  if [ "$EDIT_RASPOTIFY_CONF" = true ]; then
    "${EDITOR:-nano}" /etc/raspotify/conf
  fi
fi

systemctl daemon-reload
systemctl enable spotify-kiosk.service
systemctl restart spotify-kiosk.service

if [ "$SETUP_RASPOTIFY" = true ] && systemctl list-unit-files raspotify.service >/dev/null 2>&1; then
  systemctl restart raspotify.service
fi

XDG_RUNTIME_DIR="/run/user/${USER_UID}"
if [ -d "$XDG_RUNTIME_DIR" ]; then
  sudo -u "$USER_NAME" env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" systemctl --user daemon-reload
  sudo -u "$USER_NAME" env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" systemctl --user disable --now touchkio.service 2>/dev/null || true
  sudo -u "$USER_NAME" env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" systemctl --user enable --now spotify-kiosk-browser.service
else
  echo "No graphical session yet — after first login run:"
  echo "  systemctl --user enable --now spotify-kiosk-browser.service"
fi

echo
echo "Installation complete."
echo
echo "Finish setup:"
echo "  1. In the Spotify Developer Dashboard, add this redirect URI:"
echo "       ${SPOTIFY_REDIRECT_URI}"
echo "  2. Open the kiosk UI at ${PUBLIC_BASE_URL} and log in with Spotify."
echo "  3. Make sure SPOTIFY_DEVICE_NAME in ${ENV_FILE} matches the device name in the Spotify app."
if [ "$SETUP_RASPOTIFY" = true ]; then
  echo "  4. Raspotify config lives at /etc/raspotify/conf (LIBRESPOT_NAME, LIBRESPOT_ONEVENT)."
  echo "     After login: sudo systemctl restart raspotify.service"
fi
echo
echo "Useful commands:"
echo "  sudo systemctl restart spotify-kiosk.service"
echo "  systemctl --user restart spotify-kiosk-browser.service"
echo
