#!/bin/sh
set -eu

archive=${1:?release archive is required}
release_sha256=${2:?release sha256 is required}
service_user=${3:?Runner service user is required}

candidate=
rollback_dir=
mutation_started=0
previous_current=
runner_was_active=0
runner_was_enabled=0

rollback_activation() {
  echo "Runner upgrade failed; restoring the previous release and service unit" >&2
  if test -n "$previous_current"; then ln -sfn "$previous_current" /opt/friday-agent/current; fi
  if test -f "$rollback_dir/friday-runner.service"; then cp -p "$rollback_dir/friday-runner.service" /etc/systemd/system/friday-runner@.service; fi
  systemctl daemon-reload || true
  if test "$runner_was_enabled" -eq 1; then systemctl enable "friday-runner@$service_user.service" || true; else systemctl disable "friday-runner@$service_user.service" || true; fi
  if test "$runner_was_active" -eq 1; then systemctl restart "friday-runner@$service_user.service" || true; else systemctl stop "friday-runner@$service_user.service" || true; fi
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if test "$status" -ne 0 && test "$mutation_started" -eq 1; then rollback_activation; fi
  test -z "$candidate" || rm -rf "$candidate"
  test -z "$rollback_dir" || rm -rf "$rollback_dir"
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "$archive" in /tmp/friday-runner-upgrade-*.tgz) ;; *) echo "Runner archive must use a generated /tmp path" >&2; exit 2;; esac
test -f "$archive" && test ! -L "$archive" || { echo "unsafe Runner archive" >&2; exit 2; }
case "$release_sha256" in *[!a-f0-9]*|'') echo "invalid Runner release digest" >&2; exit 2;; esac
test "${#release_sha256}" -eq 64 || { echo "invalid Runner release digest" >&2; exit 2; }
id "$service_user" >/dev/null 2>&1 || { echo "Runner service user does not exist" >&2; exit 2; }
node_bin=$(command -v node)
node_version=$($node_bin --version)
node_major=$(printf '%s' "$node_version" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
node_minor=$(printf '%s' "$node_version" | sed -n 's/^v[0-9][0-9]*\.\([0-9][0-9]*\).*/\1/p')
if test -z "$node_major" || test -z "$node_minor" || test "$node_major" -lt 22 || { test "$node_major" -eq 22 && test "$node_minor" -lt 19; }; then
  echo "Node.js 22.19.0 or newer is required" >&2
  exit 2
fi
actual_sha=$(sha256sum "$archive" | awk '{print $1}')
test "$actual_sha" = "$release_sha256" || { echo "Runner release digest mismatch" >&2; exit 2; }
release_id=$(printf '%.16s' "$release_sha256")

install_root=/opt/friday-agent
test -L "$install_root/current" || { echo "Runner current release is not an existing symlink" >&2; exit 2; }
previous_current=$(readlink "$install_root/current")
case "$previous_current" in releases/????????????????) ;; *) echo "Runner current release is unsafe" >&2; exit 2;; esac
runner_env=/etc/friday-runner/$service_user.env
test -f "$runner_env" && test ! -L "$runner_env" || { echo "Runner environment is missing or unsafe" >&2; exit 2; }
test -f /var/lib/friday-runner/runner-device.json && test ! -L /var/lib/friday-runner/runner-device.json || { echo "Runner device identity is missing or unsafe" >&2; exit 2; }
test -f /var/lib/friday-runner/hub-identity.json && test ! -L /var/lib/friday-runner/hub-identity.json || { echo "Runner Hub identity is missing or unsafe" >&2; exit 2; }
grep -q '^FRIDAY_SANDBOX_SOCKET=/run/friday-sandboxd/sandboxd.sock$' "$runner_env" || { echo "Runner is not bound to the managed Sandbox socket" >&2; exit 2; }

release_dir=$install_root/releases/$release_id
install -d -o root -g root -m 755 "$install_root/releases"
if test ! -e "$release_dir"; then
  candidate=$install_root/releases/.candidate-$release_id
  rm -rf "$candidate"
  install -d -o root -g root -m 755 "$candidate"
  tar -xzf "$archive" -C "$candidate" --strip-components=1
  test -f "$candidate/apps/runner/dist/index.js" && test -L "$candidate/node_modules/@friday/protocol" && test -f "$candidate/friday-runner-managed@.service" || { echo "Runner release content is incomplete" >&2; exit 2; }
  chown -R root:root "$candidate"
  find "$candidate" -type d -exec chmod 755 {} +
  find "$candidate" -type f -exec chmod 644 {} +
  mv "$candidate" "$release_dir"
  candidate=
fi

runuser -u "$service_user" -- env FRIDAY_RUNNER_STATE_DIR=/var/lib/friday-runner "$node_bin" "$release_dir/apps/runner/dist/index.js" --print-capabilities >/dev/null

rollback_dir=$(mktemp -d /tmp/friday-runner-upgrade-rollback.XXXXXX)
chmod 700 "$rollback_dir"
cp -p /etc/systemd/system/friday-runner@.service "$rollback_dir/friday-runner.service"
if systemctl is-active --quiet "friday-runner@$service_user.service"; then runner_was_active=1; fi
if systemctl is-enabled --quiet "friday-runner@$service_user.service"; then runner_was_enabled=1; fi
mutation_started=1

ln -sfn "releases/$release_id" "$install_root/current"
install -o root -g root -m 644 "$release_dir/friday-runner-managed@.service" /etc/systemd/system/friday-runner@.service
systemctl daemon-reload
systemctl restart "friday-runner@$service_user.service"
sleep 2
systemctl is-active --quiet "friday-runner@$service_user.service"
test "$(readlink "$install_root/current")" = "releases/$release_id"

mutation_started=0
printf 'release_id=%s\nprevious_release=%s\n' "$release_id" "$previous_current"
