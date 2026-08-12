#!/bin/sh
set -eu

archive=${1:?sandbox release archive is required}
release_sha256=${2:?sandbox release sha256 is required}
service_user=${3:?Runner service user is required}
hub_url_input=${4:?Hub HTTPS origin is required}

candidate=
hub_key_tmp=
env_tmp=
rollback_dir=
mutation_started=0
previous_current=
sandbox_was_active=0
sandbox_was_enabled=0
runner_was_active=0
runner_was_enabled=0

backup_file() {
  target=$1
  name=$2
  test ! -L "$target" || { echo "refusing to replace symlink: $target" >&2; exit 2; }
  if test -f "$target"; then
    cp -p "$target" "$rollback_dir/$name"
    : > "$rollback_dir/$name.present"
  fi
}

restore_file() {
  target=$1
  name=$2
  if test -f "$rollback_dir/$name.present"; then
    cp -p "$rollback_dir/$name" "$target"
  else
    rm -f "$target"
  fi
}

rollback_activation() {
  echo "sandbox activation failed; restoring the previous release and service files" >&2
  restore_file /etc/friday-sandboxd/hub-ed25519.pub hub-ed25519.pub
  restore_file /etc/friday-sandboxd/sandboxd.env sandboxd.env
  restore_file /etc/systemd/system/friday-sandboxd.service friday-sandboxd.service
  restore_file "/etc/friday-runner/$service_user.env" runner.env
  if test -n "$previous_current"; then
    ln -sfn "$previous_current" /opt/friday-sandboxd/current
  else
    rm -f /opt/friday-sandboxd/current
  fi
  systemctl daemon-reload || true
  if test "$sandbox_was_enabled" -eq 1; then systemctl enable friday-sandboxd.service || true; else systemctl disable friday-sandboxd.service || true; fi
  if test "$runner_was_enabled" -eq 1; then systemctl enable "friday-runner@$service_user.service" || true; else systemctl disable "friday-runner@$service_user.service" || true; fi
  if test "$sandbox_was_active" -eq 1; then systemctl restart friday-sandboxd.service || true; else systemctl stop friday-sandboxd.service || true; fi
  if test "$runner_was_active" -eq 1; then systemctl restart "friday-runner@$service_user.service" || true; else systemctl stop "friday-runner@$service_user.service" || true; fi
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if test "$status" -ne 0 && test "$mutation_started" -eq 1; then rollback_activation; fi
  test -z "$candidate" || rm -rf "$candidate"
  test -z "$hub_key_tmp" || rm -f "$hub_key_tmp"
  test -z "$env_tmp" || rm -f "$env_tmp"
  test -z "$rollback_dir" || rm -rf "$rollback_dir"
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "$archive" in /tmp/friday-sandboxd-*.tgz) ;; *) echo "sandbox archive must use a generated /tmp path" >&2; exit 2;; esac
test -f "$archive" && test ! -L "$archive" || { echo "unsafe sandbox archive" >&2; exit 2; }
case "$release_sha256" in *[!a-f0-9]*|'') echo "invalid sandbox release digest" >&2; exit 2;; esac
test "${#release_sha256}" -eq 64 || { echo "invalid sandbox release digest" >&2; exit 2; }
id "$service_user" >/dev/null 2>&1 || { echo "Runner service user does not exist" >&2; exit 2; }
node_bin=$(command -v node)
node_version=$($node_bin --version)
node_major=$(printf '%s' "$node_version" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
node_minor=$(printf '%s' "$node_version" | sed -n 's/^v[0-9][0-9]*\.\([0-9][0-9]*\).*/\1/p')
if test -z "$node_major" || test -z "$node_minor" || test "$node_major" -lt 22 || { test "$node_major" -eq 22 && test "$node_minor" -lt 19; }; then
  echo "Node.js 22.19.0 or newer is required" >&2
  exit 2
fi
hub_url=$("$node_bin" -e 'const value=new URL(process.argv[1]); if(value.protocol!=="https:"||value.username||value.password||value.pathname!=="/"||value.search||value.hash) process.exit(2); process.stdout.write(value.origin)' "$hub_url_input") || { echo "Hub URL must be an HTTPS origin without credentials" >&2; exit 2; }
actual_sha256=$(sha256sum "$archive" | awk '{print $1}')
test "$actual_sha256" = "$release_sha256" || { echo "sandbox release digest mismatch" >&2; exit 2; }
release_id=$(printf '%.16s' "$release_sha256")

install_root=/opt/friday-sandboxd
release_dir=$install_root/releases/$release_id
install -d -o root -g root -m 755 "$install_root/releases" /etc/friday-sandboxd
if test ! -e "$release_dir"; then
  candidate=$install_root/releases/.candidate-$release_id
  rm -rf "$candidate"
  install -d -o root -g root -m 755 "$candidate"
  tar -xzf "$archive" -C "$candidate" --strip-components=1
  test -f "$candidate/apps/sandboxd/dist/index.js" && test -f "$candidate/apps/sandboxd/dist/agent-wrapper.js" && test -L "$candidate/node_modules/@friday/protocol" && test -f "$candidate/agent/Dockerfile" && test -f "$candidate/agent/package-lock.json" && test -f "$candidate/agent/verify-agent-contracts.mjs" || { echo "sandbox release content is incomplete" >&2; exit 2; }
  chown -R root:root "$candidate"
  find "$candidate" -type d -exec chmod 755 {} +
  find "$candidate" -type f -exec chmod 644 {} +
  mv "$candidate" "$release_dir"
  candidate=
fi

agent_image=friday-agent:$release_id
# This is the only intentionally networked build. package-lock.json pins every
# CLI tarball and integrity; runtime Job containers remain --network none.
docker build --pull=false --tag "$agent_image" --file "$release_dir/agent/Dockerfile" "$release_dir" >/dev/null
agent_image_id=$(docker image inspect --format '{{.Id}}' "$agent_image")
case "$agent_image_id" in sha256:????????????????????????????????????????????????????????????????) ;; *) echo "Docker returned an invalid Agent image id" >&2; exit 2;; esac

hub_identity=/var/lib/friday-runner/hub-identity.json
test -f "$hub_identity" && test ! -L "$hub_identity" || { echo "Runner has not pinned the Hub identity" >&2; exit 2; }
umask 077
hub_key_tmp=/etc/friday-sandboxd/.hub-ed25519.pub.$$
runuser -u "$service_user" -- "$node_bin" -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(typeof value.publicKeyPem!=="string") process.exit(2); process.stdout.write(value.publicKeyPem)' "$hub_identity" > "$hub_key_tmp"

runner_uid=$(id -u "$service_user")
runner_gid=$(id -g "$service_user")
env_tmp=/etc/friday-sandboxd/.sandboxd.env.$$
{
  printf 'FRIDAY_SANDBOX_SOCKET=/run/friday-sandboxd/sandboxd.sock\n'
  printf 'FRIDAY_SANDBOX_RUNNER_STATE_DIR=/var/lib/friday-runner\n'
  printf 'FRIDAY_SANDBOX_HUB_PUBLIC_KEY_FILE=/etc/friday-sandboxd/hub-ed25519.pub\n'
  printf 'FRIDAY_SANDBOX_HUB_URL=%s\n' "$hub_url"
  printf 'FRIDAY_SANDBOX_MODEL_RELAY_DIR=/run/friday-sandboxd/model-relays\n'
  printf 'FRIDAY_SANDBOX_RUNNER_UID=%s\n' "$runner_uid"
  printf 'FRIDAY_SANDBOX_RUNNER_GID=%s\n' "$runner_gid"
  printf 'FRIDAY_SANDBOX_AGENT_IMAGE=%s\n' "$agent_image"
  printf 'FRIDAY_SANDBOX_AGENT_IMAGE_ID=%s\n' "$agent_image_id"
  printf 'FRIDAY_SANDBOX_CODEX_IMAGE=%s\n' "$agent_image"
  printf 'FRIDAY_SANDBOX_CODEX_IMAGE_ID=%s\n' "$agent_image_id"
  printf 'FRIDAY_SANDBOX_PI_IMAGE=%s\n' "$agent_image"
  printf 'FRIDAY_SANDBOX_PI_IMAGE_ID=%s\n' "$agent_image_id"
  printf 'FRIDAY_SANDBOX_CLAUDE_IMAGE=%s\n' "$agent_image"
  printf 'FRIDAY_SANDBOX_CLAUDE_IMAGE_ID=%s\n' "$agent_image_id"
} > "$env_tmp"

runner_env=/etc/friday-runner/$service_user.env
test -f "$runner_env" && test ! -L "$runner_env" || { echo "Runner environment is missing or unsafe" >&2; exit 2; }
if grep -q '^FRIDAY_SANDBOX_SOCKET=' "$runner_env"; then
  grep -q '^FRIDAY_SANDBOX_SOCKET=/run/friday-sandboxd/sandboxd.sock$' "$runner_env" || { echo "Runner has a conflicting sandbox socket" >&2; exit 2; }
fi

rollback_dir=$(mktemp -d /tmp/friday-sandboxd-rollback.XXXXXX)
chmod 700 "$rollback_dir"
backup_file /etc/friday-sandboxd/hub-ed25519.pub hub-ed25519.pub
backup_file /etc/friday-sandboxd/sandboxd.env sandboxd.env
backup_file /etc/systemd/system/friday-sandboxd.service friday-sandboxd.service
backup_file "$runner_env" runner.env
if test -L "$install_root/current"; then
  previous_current=$(readlink "$install_root/current")
elif test -e "$install_root/current"; then
  echo "sandbox current path exists and is not a symlink" >&2
  exit 2
fi
if systemctl is-active --quiet friday-sandboxd.service; then sandbox_was_active=1; fi
if systemctl is-enabled --quiet friday-sandboxd.service; then sandbox_was_enabled=1; fi
if systemctl is-active --quiet "friday-runner@$service_user.service"; then runner_was_active=1; fi
if systemctl is-enabled --quiet "friday-runner@$service_user.service"; then runner_was_enabled=1; fi
mutation_started=1

install -o root -g root -m 600 "$hub_key_tmp" /etc/friday-sandboxd/hub-ed25519.pub
unlink "$hub_key_tmp"
hub_key_tmp=
install -o root -g root -m 600 "$env_tmp" /etc/friday-sandboxd/sandboxd.env
unlink "$env_tmp"
env_tmp=
install -o root -g root -m 644 "$release_dir/friday-sandboxd.service" /etc/systemd/system/friday-sandboxd.service
if ! grep -q '^FRIDAY_SANDBOX_SOCKET=' "$runner_env"; then
  printf 'FRIDAY_SANDBOX_SOCKET=/run/friday-sandboxd/sandboxd.sock\n' >> "$runner_env"
fi
chmod 640 "$runner_env"
ln -sfn "releases/$release_id" "$install_root/current"

systemctl daemon-reload
systemctl enable friday-sandboxd.service
systemctl restart friday-sandboxd.service
systemctl restart "friday-runner@$service_user.service"
sleep 2
systemctl is-active --quiet friday-sandboxd.service
systemctl is-active --quiet "friday-runner@$service_user.service"
stable_pid=$(systemctl show --property=MainPID --value friday-sandboxd.service)
case "$stable_pid" in ''|0|*[!0-9]*) echo "sandbox service did not expose a stable MainPID" >&2; exit 2;; esac
sleep 3
systemctl is-active --quiet friday-sandboxd.service
test "$(systemctl show --property=MainPID --value friday-sandboxd.service)" = "$stable_pid" || { echo "sandbox service did not remain stable after activation" >&2; exit 2; }
test "$(stat -c %a /etc/friday-sandboxd/sandboxd.env)" = 600
test "$(stat -c %a /etc/friday-sandboxd/hub-ed25519.pub)" = 600
printf 'release_id=%s\nagent_image_id=%s\n' "$release_id" "$agent_image_id"
