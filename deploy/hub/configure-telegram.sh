#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: sudo ./deploy/hub/configure-telegram.sh

Set these environment variables first; they are intentionally not accepted as
command-line arguments:
  FRIDAY_TELEGRAM_BOT_TOKEN  Token issued by @BotFather
  FRIDAY_TELEGRAM_OWNER_ID   Numeric Telegram user ID allowed to chat with Friday

The script stores the Bot Token only in deploy/gateway/gateway.env (mode 0600),
rotates the Hub-scoped ingest token, pairs one Owner, and restarts the Gateway.
EOF
}

test "$(id -u)" -eq 0 || { echo "Run this helper as root" >&2; exit 2; }
bot_token=${FRIDAY_TELEGRAM_BOT_TOKEN:-}
owner_id=${FRIDAY_TELEGRAM_OWNER_ID:-}
test -n "$bot_token" && test -n "$owner_id" || { usage >&2; exit 2; }
printf '%s' "$bot_token" | grep -Eq '^[0-9]{5,}:[A-Za-z0-9_-]{20,}$' || { echo "Telegram Bot Token format is invalid" >&2; exit 2; }
printf '%s' "$owner_id" | grep -Eq '^[0-9]{1,32}$' || { echo "Telegram Owner ID must be numeric" >&2; exit 2; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
hub_env=$repo_root/deploy/hub/hub.env
gateway_env=$repo_root/deploy/gateway/gateway.env
compose_file=$repo_root/deploy/hub/compose.yml
test -f "$hub_env" && test -f "$gateway_env" || { echo "Install the Hub before configuring Telegram" >&2; exit 2; }
owner_token=$(sed -n 's/^FRIDAY_OWNER_TOKEN=//p' "$hub_env")
test "${#owner_token}" -eq 43 || { echo "Hub Owner token is missing or invalid" >&2; exit 2; }

telegram_response=$(curl -fsS -X POST \
  -H "Authorization: Bearer $owner_token" \
  -H 'Content-Type: application/json' \
  --data '{"channel":"telegram"}' \
  http://127.0.0.1:4310/v2/channels/rotate)
telegram_token=$(printf '%s' "$telegram_response" | sed -n 's/.*"token":"\([A-Za-z0-9_-]*\)".*/\1/p')
test "${#telegram_token}" -eq 43 || { echo "Hub returned an invalid Telegram ingest token" >&2; exit 1; }
curl -fsS -X POST \
  -H "Authorization: Bearer $owner_token" \
  -H 'Content-Type: application/json' \
  --data "{\"channel\":\"telegram\",\"senderId\":\"$owner_id\"}" \
  http://127.0.0.1:4310/v2/channels/pair >/dev/null

temporary=$(mktemp "$repo_root/deploy/gateway/gateway.env.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
grep -v '^FRIDAY_TELEGRAM_' "$gateway_env" > "$temporary"
printf 'FRIDAY_TELEGRAM_INGEST_TOKEN=%s\nFRIDAY_TELEGRAM_BOT_TOKEN=%s\n' "$telegram_token" "$bot_token" >> "$temporary"
install -o root -g root -m 600 "$temporary" "$gateway_env"
rm -f "$temporary"
trap - EXIT HUP INT TERM
docker compose -f "$compose_file" up -d channel-gateway
echo "Telegram is paired to Owner ID $owner_id. Group chats and all other senders are rejected."
