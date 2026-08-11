#!/bin/sh
set -eu

archive=${1:?release archive is required}
bootstrap_env=${2:?bootstrap environment is required}
service_env=${3:?service environment is required}
workspaces=${4:?workspace list is required}

candidate=
rollback_dir=
mutation_started=0
previous_current=
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
  if test -f "$rollback_dir/$name.present"; then cp -p "$rollback_dir/$name" "$target"; else rm -f "$target"; fi
}

rollback_activation() {
  echo "Runner activation failed; restoring the previous release and service files" >&2
  restore_file "/etc/friday-runner/$FRIDAY_SERVICE_USER.env" runner.env
  restore_file /etc/systemd/system/friday-runner@.service friday-runner.service
  if test -n "$previous_current"; then ln -sfn "$previous_current" /opt/friday-agent/current; else rm -f /opt/friday-agent/current; fi
  systemctl daemon-reload || true
  if test "$runner_was_enabled" -eq 1; then systemctl enable "friday-runner@$FRIDAY_SERVICE_USER.service" || true; else systemctl disable "friday-runner@$FRIDAY_SERVICE_USER.service" || true; fi
  if test "$runner_was_active" -eq 1; then systemctl restart "friday-runner@$FRIDAY_SERVICE_USER.service" || true; else systemctl stop "friday-runner@$FRIDAY_SERVICE_USER.service" || true; fi
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if test "$status" -ne 0 && test "$mutation_started" -eq 1; then rollback_activation; fi
  rm -f "$archive" "$bootstrap_env" "$service_env" "$workspaces" "$0"
  test -z "$candidate" || rm -rf "$candidate"
  test -z "$rollback_dir" || rm -rf "$rollback_dir"
  exit "$status"
}

case "$archive:$bootstrap_env:$service_env:$workspaces" in
  /tmp/friday-bootstrap-*.tgz:/tmp/friday-bootstrap-*.env:/tmp/friday-bootstrap-*.service.env:/tmp/friday-bootstrap-*.workspaces) ;;
  *) echo "bootstrap inputs must use generated /tmp paths" >&2; exit 2 ;;
esac
case "$0" in /tmp/friday-bootstrap-*.sh) ;; *) echo "bootstrap installer must use a generated /tmp path" >&2; exit 2;; esac
for file in "$archive" "$bootstrap_env" "$service_env" "$workspaces"; do
  test -f "$file" && test ! -L "$file" || { echo "unsafe bootstrap input: $file" >&2; exit 2; }
done
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 600 "$bootstrap_env" "$service_env" "$workspaces"
# shellcheck disable=SC1090
. "$bootstrap_env"
: "${FRIDAY_HUB_URL:?}" "${FRIDAY_RUNNER_ID:?}" "${FRIDAY_ENROLLMENT_TOKEN:?}" "${FRIDAY_RUNNER_NAME:?}" "${FRIDAY_SERVICE_USER:?}" "${FRIDAY_RELEASE_ID:?}" "${FRIDAY_RELEASE_SHA256:?}"
case "$FRIDAY_RUNNER_ID" in ????????-????-????-????-????????????) ;; *) echo "invalid Runner id" >&2; exit 2;; esac
case "$FRIDAY_RELEASE_ID$FRIDAY_RELEASE_SHA256" in *[!a-f0-9]*) echo "invalid release digest" >&2; exit 2;; esac
test "${#FRIDAY_RELEASE_ID}" -eq 16 && test "${#FRIDAY_RELEASE_SHA256}" -eq 64 || { echo "invalid release digest" >&2; exit 2; }
id "$FRIDAY_SERVICE_USER" >/dev/null 2>&1 || { echo "service user does not exist" >&2; exit 2; }
service_group=$(id -gn "$FRIDAY_SERVICE_USER")
node_bin=$(command -v node)
node_version=$($node_bin --version)
node_major=$(printf '%s' "$node_version" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
node_minor=$(printf '%s' "$node_version" | sed -n 's/^v[0-9][0-9]*\.\([0-9][0-9]*\).*/\1/p')
if test -z "$node_major" || test -z "$node_minor" || test "$node_major" -lt 22 || { test "$node_major" -eq 22 && test "$node_minor" -lt 19; }; then
  echo "Node.js 22.19.0 or newer is required" >&2
  exit 2
fi
actual_sha=$(sha256sum "$archive" | awk '{print $1}')
test "$actual_sha" = "$FRIDAY_RELEASE_SHA256" || { echo "release digest mismatch" >&2; exit 2; }

install_root=/opt/friday-agent
release_dir=$install_root/releases/$FRIDAY_RELEASE_ID
install -d -o root -g root -m 755 "$install_root/releases" /etc/friday-runner
if test ! -e "$release_dir"; then
  candidate=$install_root/releases/.candidate-$FRIDAY_RELEASE_ID
  rm -rf "$candidate"
  install -d -o root -g root -m 755 "$candidate"
  tar -xzf "$archive" -C "$candidate" --strip-components=1
  test -f "$candidate/apps/runner/dist/index.js" && test -L "$candidate/node_modules/@friday/protocol" || { echo "release content is incomplete" >&2; exit 2; }
  chown -R root:root "$candidate"
  find "$candidate" -type d -exec chmod 755 {} +
  find "$candidate" -type f -exec chmod 644 {} +
  mv "$candidate" "$release_dir"
  candidate=
fi

state_dir=/var/lib/friday-runner
install -d -o "$FRIDAY_SERVICE_USER" -g "$service_group" -m 700 "$state_dir"
token_file=$state_dir/enrollment-token
umask 077
printf '%s\n' "$FRIDAY_ENROLLMENT_TOKEN" > "$token_file"
chown "$FRIDAY_SERVICE_USER:$service_group" "$token_file"
unset FRIDAY_ENROLLMENT_TOKEN

while IFS="$(printf '\t')" read -r workspace_id workspace_path; do
  test -n "$workspace_id" || continue
  runuser -u "$FRIDAY_SERVICE_USER" -- env FRIDAY_RUNNER_STATE_DIR="$state_dir" "$node_bin" "$release_dir/apps/runner/dist/index.js" workspace register "$workspace_id" "$workspace_path"
done < "$workspaces"

if ! runuser -u "$FRIDAY_SERVICE_USER" -- env \
  FRIDAY_HUB_URL="$FRIDAY_HUB_URL" \
  FRIDAY_RUNNER_STATE_DIR="$state_dir" \
  FRIDAY_RUNNER_ID="$FRIDAY_RUNNER_ID" \
  FRIDAY_RUNNER_NAME="$FRIDAY_RUNNER_NAME" \
  FRIDAY_RUNNER_ENROLLMENT_FILE="$token_file" \
  "$node_bin" "$release_dir/apps/runner/dist/index.js" --once; then
  # A lost registration response after successful enrollment must not strand
  # the device. The persistent service can retry its signed registration.
  test ! -e "$token_file" || exit 1
fi
test ! -e "$token_file" || { echo "enrollment token was not consumed" >&2; exit 2; }

runner_env=/etc/friday-runner/$FRIDAY_SERVICE_USER.env
rollback_dir=$(mktemp -d /tmp/friday-runner-rollback.XXXXXX)
chmod 700 "$rollback_dir"
backup_file "$runner_env" runner.env
backup_file /etc/systemd/system/friday-runner@.service friday-runner.service
if test -L "$install_root/current"; then
  previous_current=$(readlink "$install_root/current")
elif test -e "$install_root/current"; then
  echo "Runner current path exists and is not a symlink" >&2
  exit 2
fi
if systemctl is-active --quiet "friday-runner@$FRIDAY_SERVICE_USER.service"; then runner_was_active=1; fi
if systemctl is-enabled --quiet "friday-runner@$FRIDAY_SERVICE_USER.service"; then runner_was_enabled=1; fi
mutation_started=1

ln -sfn "releases/$FRIDAY_RELEASE_ID" "$install_root/current"
install -o root -g root -m 640 "$service_env" "$runner_env"
install -o root -g root -m 644 "$release_dir/friday-runner-managed@.service" /etc/systemd/system/friday-runner@.service
systemctl daemon-reload
systemctl enable --now "friday-runner@$FRIDAY_SERVICE_USER.service"
systemctl is-active --quiet "friday-runner@$FRIDAY_SERVICE_USER.service"
