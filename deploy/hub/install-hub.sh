#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: sudo ./deploy/hub/install-hub.sh --origin <https-origin> [--network tailscale|private-https]

Recommended: --network tailscale
  Requires Docker Compose and a connected Tailscale client on the Hub. The
  installer configures Tailscale Serve, never Funnel.

Alternative: --network private-https
  Keeps Friday Agent on 127.0.0.1:4310. You must provide an existing private
  HTTPS reverse proxy whose browser Origin exactly matches --origin.

Optional environment:
  FRIDAY_INSTALL_WEB_PASSWORD  Reuse a 12-256 character Owner password.
                               When omitted, a random password is generated.
EOF
}

origin=
network=tailscale
while test "$#" -gt 0; do
  case "$1" in
    --origin) test "$#" -ge 2 || { usage >&2; exit 2; }; origin=$2; shift 2 ;;
    --network) test "$#" -ge 2 || { usage >&2; exit 2; }; network=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

test "$(id -u)" -eq 0 || { echo "Run this installer as root" >&2; exit 2; }
case "$origin" in https://*/*|https://*) ;; *) echo "--origin must be an HTTPS origin" >&2; exit 2;; esac
case "$origin" in *\?*|*\#*) echo "--origin cannot contain a query or fragment" >&2; exit 2;; esac
origin=${origin%/}
case "$origin" in https://*/*) echo "--origin cannot contain a path" >&2; exit 2;; esac
case "$network" in tailscale|private-https) ;; *) echo "--network must be tailscale or private-https" >&2; exit 2;; esac

command -v docker >/dev/null 2>&1 || { echo "Docker is required" >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 2; }
if test "$network" = tailscale; then
  command -v tailscale >/dev/null 2>&1 || { echo "Tailscale is required for --network tailscale" >&2; exit 2; }
  tailscale status >/dev/null 2>&1 || { echo "Connect this Hub to Tailscale before installing Friday Agent" >&2; exit 2; }
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
compose_file=$repo_root/deploy/hub/compose.yml
compose_env=$repo_root/deploy/hub/.env
hub_env=$repo_root/deploy/hub/hub.env
gateway_env=$repo_root/deploy/gateway/gateway.env
test -f "$repo_root/package-lock.json" && test -f "$compose_file" || { echo "Run the installer from a complete Friday Agent checkout" >&2; exit 2; }
if test -e "$compose_env" || test -e "$hub_env" || test -e "$gateway_env"; then
  echo "Friday Agent private environment files already exist; refusing to rotate an existing installation" >&2
  exit 2
fi

token() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }
password=${FRIDAY_INSTALL_WEB_PASSWORD:-}
if test -z "$password"; then password=$(token); fi
password_length=${#password}
test "$password_length" -ge 12 && test "$password_length" -le 256 || { echo "FRIDAY_INSTALL_WEB_PASSWORD must contain 12-256 characters" >&2; exit 2; }
printf '%s' "$password" | grep -Eq '^[A-Za-z0-9._~!@%+=:,/-]+$' || { echo "FRIDAY_INSTALL_WEB_PASSWORD contains characters that are unsafe in an env file" >&2; exit 2; }

owner_token=$(token)
control_token=$(token)
test "${#owner_token}" -eq 43 && test "${#control_token}" -eq 43 || { echo "Secure token generation failed" >&2; exit 2; }

if ! id friday-hub >/dev/null 2>&1; then
  useradd --system --home /var/lib/friday-hub --shell /usr/sbin/nologin friday-hub
fi
hub_uid=$(id -u friday-hub)
hub_gid=$(id -g friday-hub)
install -d -o friday-hub -g friday-hub -m 700 /var/lib/friday-hub/state /var/lib/friday-channel-gateway

umask 077
cat > "$compose_env" <<EOF
FRIDAY_UID=$hub_uid
FRIDAY_GID=$hub_gid
FRIDAY_STATE_DIR=/var/lib/friday-hub/state
FRIDAY_GATEWAY_STATE_DIR=/var/lib/friday-channel-gateway
EOF
cat > "$hub_env" <<EOF
FRIDAY_OWNER_ID=owner
FRIDAY_OWNER_TOKEN=$owner_token
FRIDAY_PUBLIC_ORIGIN=$origin
FRIDAY_WEB_PASSWORD=$password
FRIDAY_WEB_SEARCH_ENABLE=1
FRIDAY_CHANNEL_GATEWAY_CONTROL_URL=http://127.0.0.1:4311/
FRIDAY_CHANNEL_GATEWAY_CONTROL_TOKEN=$control_token
FRIDAY_SELF_WORKSPACE_ID=friday-agent
EOF
chmod 600 "$compose_env" "$hub_env"

cleanup_on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  if test "$status" -ne 0; then
    echo "Hub installation failed; generated private environment files were kept for diagnosis" >&2
  fi
  exit "$status"
}
trap cleanup_on_error EXIT HUP INT TERM

docker compose -f "$compose_file" build hub
docker compose -f "$compose_file" up -d hub
attempt=0
until curl -fsS http://127.0.0.1:4310/health >/dev/null; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 60 || { docker compose -f "$compose_file" logs --tail=80 hub >&2; exit 1; }
  sleep 1
done

ilink_response=$(curl -fsS -X POST \
  -H "Authorization: Bearer $owner_token" \
  -H 'Content-Type: application/json' \
  --data '{"channel":"wechat_ilink"}' \
  http://127.0.0.1:4310/v2/channels/rotate)
ilink_token=$(printf '%s' "$ilink_response" | sed -n 's/.*"token":"\([A-Za-z0-9_-]*\)".*/\1/p')
test "${#ilink_token}" -eq 43 || { echo "Hub returned an invalid iLink ingest token" >&2; exit 1; }
cat > "$gateway_env" <<EOF
FRIDAY_GATEWAY_HUB_URL=http://127.0.0.1:4310
FRIDAY_WECHAT_ILINK_INGEST_TOKEN=$ilink_token
FRIDAY_WECHAT_ILINK_BASE_URL=https://ilinkai.weixin.qq.com/
FRIDAY_WECHAT_ILINK_CHANNEL_VERSION=0.2.1
FRIDAY_WECHAT_ILINK_APP_ID=bot
FRIDAY_GATEWAY_CONTROL_TOKEN=$control_token
FRIDAY_GATEWAY_PORT=4311
EOF
chmod 600 "$gateway_env"
docker compose -f "$compose_file" up -d channel-gateway

if test "$network" = tailscale; then
  tailscale serve --bg --https=443 http://127.0.0.1:4310
fi

trap - EXIT HUP INT TERM
cat <<EOF

Friday Agent Hub is ready.
Web URL:       $origin
Web password:  $password
Owner token:   $owner_token

Save the two credentials now. They remain only in the root-owned Hub env file.
Open the Web console to bind WeChat iLink. To add Telegram, run:
  sudo ./deploy/hub/configure-telegram.sh
EOF
