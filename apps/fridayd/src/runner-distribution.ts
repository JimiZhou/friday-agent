import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNNER_BUNDLE_PATH = "/v1/runner-install/friday-runner.tgz";
export const DEFAULT_RUNNER_TUNNEL_PORT = 14310;
export const RUNNER_SSH_TARGET_PATTERN = /^(?:[a-z_][a-z0-9_-]*@)?(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][A-Za-z0-9.:-]*)$/;

export async function loadRunnerDistribution(directory = fileURLToPath(new URL("../../../runner-distribution", import.meta.url))) {
  const bytes = await readFile(join(directory, "friday-runner.tgz"));
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) throw new Error("Invalid Runner bundle size");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, releaseId: sha256.slice(0, 16) };
}

export interface RunnerInstallInput {
  readonly hubUrl: string;
  readonly runnerName?: string;
  readonly serviceUser?: string;
}

export interface RunnerSshInstallInput {
  readonly sshTarget: string;
  readonly runnerName?: string;
  readonly serviceUser?: string;
  readonly tunnelPort: number;
  readonly hubPort: number;
}

export interface RunnerEnrollment {
  readonly runnerId: string;
  readonly enrollmentToken: string;
  readonly expiresAt: string;
}

export function validateRunnerSshTarget(value: string): string {
  const target = value.trim();
  if (target.length === 0 || target.length > 255 || !RUNNER_SSH_TARGET_PATTERN.test(target)) throw new Error("Invalid SSH target");
  return target;
}

export function validateRunnerInstallInput(value: unknown): { hubUrl: string; runnerName: string; serviceUser: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected Hub URL, device name and service user");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "hubUrl,runnerName,serviceUser" || typeof record.hubUrl !== "string" || typeof record.runnerName !== "string" || typeof record.serviceUser !== "string") throw new Error("Invalid installation fields");
  const hub = new URL(record.hubUrl);
  if ((hub.protocol !== "https:" && !(hub.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(hub.hostname))) || hub.username || hub.password || hub.pathname !== "/" || hub.search || hub.hash) throw new Error("Hub URL must be an HTTPS origin or loopback HTTP");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(record.serviceUser) || !record.runnerName.trim() || record.runnerName.length > 128 || /[\x00-\x1f\x7f]/.test(record.runnerName)) throw new Error("Invalid device name or service user");
  return { hubUrl: hub.origin, runnerName: record.runnerName.trim(), serviceUser: record.serviceUser };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellValue(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : quote(validateTextOption(value));
}

function validateTextOption(value: string): string {
  if (!value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid device name");
  return value.trim();
}

function validateServiceUser(value: string): string {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value)) throw new Error("Invalid service user");
  return value;
}

function validatePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) throw new Error(`Invalid ${label}`);
  return value;
}

function oneLine(lines: readonly string[]): string {
  return `sh -c ${quote(lines.join("; "))}`;
}

function commonPrologue(): string[] {
  return [
    "set -eu",
    "umask 077",
    "friday_sudo=",
    "if test \"$(id -u)\" -ne 0; then if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then friday_sudo='sudo -n'; fi; fi",
    "friday_tmp=$(mktemp -d)",
    "trap 'rm -rf \"$friday_tmp\"' EXIT HUP INT TERM",
  ];
}

function installationTail(baseUrl: string, enrollment: RunnerEnrollment, sha256: string, runnerName: string, serviceUser: string): string[] {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid bundle digest");
  return [
    `friday_base_url=${quote(baseUrl)}`,
    `curl --fail --silent --show-error --connect-timeout 15 --max-time 120 "$friday_base_url${RUNNER_BUNDLE_PATH}" -o "$friday_tmp/runner.tgz"`,
    `printf '%s  %s\\n' ${quote(sha256)} "$friday_tmp/runner.tgz" | sha256sum -c -`,
    "tar -xzf \"$friday_tmp/runner.tgz\" -C \"$friday_tmp\"",
    `printf '%s\\n' ${quote(JSON.stringify(enrollment))} > "$friday_tmp/enrollment.json"`,
    "friday_node=$(command -v node || true)",
    "if test -z \"$friday_node\"; then for candidate in /var/packages/Node.js_v22/target/usr/local/bin/node /usr/local/bin/node /usr/bin/node; do if test -x \"$candidate\"; then friday_node=$candidate; break; fi; done; fi",
    "test -n \"$friday_node\" || { echo '需要 Node.js >=22.19.0' >&2; exit 1; }",
    `if test "$(id -u)" -ne 0 && test -n "$friday_sudo"; then $friday_sudo "$friday_node" "$friday_tmp/release/install-standalone.mjs" "$friday_tmp/enrollment.json" "$friday_base_url" ${runnerName} ${serviceUser} ${quote(sha256.slice(0, 16))}; else "$friday_node" "$friday_tmp/release/install-standalone.mjs" "$friday_tmp/enrollment.json" "$friday_base_url" ${runnerName} ${serviceUser} ${quote(sha256.slice(0, 16))}; fi`,
  ];
}

export function runnerInstallCommand(input: RunnerInstallInput, enrollment: RunnerEnrollment, sha256: string): string {
  const hub = new URL(input.hubUrl);
  if ((hub.protocol !== "https:" && !(hub.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(hub.hostname))) || hub.username || hub.password || hub.pathname !== "/" || hub.search || hub.hash) throw new Error("Hub URL must be an HTTPS origin or loopback HTTP");
  const runnerName = shellValue(input.runnerName, '"$(hostname -s)"');
  const serviceUser = input.serviceUser === undefined ? '"$(id -un)"' : quote(validateServiceUser(input.serviceUser));
  return oneLine([
    ...commonPrologue(),
    "friday_runner_name=" + runnerName,
    "friday_service_user=" + serviceUser,
    ...installationTail(hub.origin, enrollment, sha256, '"$friday_runner_name"', '"$friday_service_user"'),
  ]);
}

export function runnerSshInstallCommand(input: RunnerSshInstallInput, enrollment: RunnerEnrollment, sha256: string): string {
  const sshTarget = quote(validateRunnerSshTarget(input.sshTarget));
  const tunnelPort = validatePort(input.tunnelPort, "tunnel port");
  const hubPort = validatePort(input.hubPort, "Hub port");
  const runnerName = shellValue(input.runnerName, '"$(hostname -s)"');
  const serviceUser = input.serviceUser === undefined ? '"$(id -un)"' : quote(validateServiceUser(input.serviceUser));
  const baseUrl = `http://127.0.0.1:${tunnelPort}`;
  const unitPrefix = [
    "[Unit]",
    "Description=Friday Hub SSH tunnel",
    "After=network-online.target",
    "Wants=network-online.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
  ];
  const unitOptions = [
    "ExecStart=$friday_ssh_bin -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -L 127.0.0.1:$friday_tunnel_port:127.0.0.1:$friday_hub_port $friday_ssh_target",
    "Restart=always",
    "RestartSec=5s",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  ];
  const systemUnit = [...unitPrefix, "User=$friday_service_user", ...unitOptions, "", "[Install]", "WantedBy=multi-user.target"]
    .map((line) => line.includes("$friday_") ? `"${line}"` : quote(line));
  const userUnit = [...unitPrefix, ...unitOptions, "", "[Install]", "WantedBy=default.target"]
    .map((line) => line.includes("$friday_") ? `"${line}"` : quote(line));
  return oneLine([
    ...commonPrologue(),
    "friday_ssh_target=" + sshTarget,
    "friday_tunnel_port=" + tunnelPort,
    "friday_hub_port=" + hubPort,
    "friday_runner_name=" + runnerName,
    "friday_service_user=" + serviceUser,
    "printf '%s' \"$friday_service_user\" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || { echo '服务用户名无效' >&2; exit 2; }",
    "printf '%s' \"$friday_ssh_target\" | grep -Eq '^([a-z_][a-z0-9_-]*@)?(\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9][A-Za-z0-9.:-]*)$' || { echo 'SSH 目标无效' >&2; exit 2; }",
    "friday_ssh_bin=$(command -v ssh || true)",
    "test -n \"$friday_ssh_bin\" || { echo '需要 ssh 客户端' >&2; exit 1; }",
    "if test \"$(id -u)\" -eq 0 || test -n \"$friday_sudo\"; then printf '%s\\n' " + systemUnit.join(" ") + " > \"$friday_tmp/tunnel.service\"; $friday_sudo install -m 0644 \"$friday_tmp/tunnel.service\" \"/etc/systemd/system/friday-runner-tunnel-$friday_service_user.service\"; $friday_sudo systemctl daemon-reload; $friday_sudo systemctl enable \"friday-runner-tunnel-$friday_service_user.service\"; $friday_sudo systemctl restart \"friday-runner-tunnel-$friday_service_user.service\"; else test \"$friday_service_user\" = \"$(id -un)\" || { echo '没有 sudo 时只能为当前用户安装 SSH 隧道' >&2; exit 1; }; friday_user_unit_dir=\"${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user\"; mkdir -p \"$friday_user_unit_dir\"; printf '%s\\n' " + userUnit.join(" ") + " > \"$friday_user_unit_dir/friday-runner-tunnel.service\"; systemctl --user daemon-reload 2>/dev/null || { echo '需要可用的 systemd 用户服务，或免密 sudo' >&2; exit 1; }; systemctl --user enable --now friday-runner-tunnel.service; fi",
    "friday_wait=0; while test \"$friday_wait\" -lt 45; do if curl -fsS --connect-timeout 2 \"http://127.0.0.1:$friday_tunnel_port/health\" >/dev/null 2>&1; then break; fi; friday_wait=$((friday_wait + 1)); sleep 1; done",
    "curl -fsS --connect-timeout 5 \"http://127.0.0.1:$friday_tunnel_port/health\" >/dev/null || { echo 'SSH 隧道未就绪；请检查 ssh 免密登录和 journalctl -u friday-runner-tunnel-<用户>' >&2; exit 1; }",
    ...installationTail(baseUrl, enrollment, sha256, '"$friday_runner_name"', '"$friday_service_user"'),
    "if test \"$(id -u)\" -eq 0 || test -n \"$friday_sudo\"; then $friday_sudo mkdir -p \"/etc/systemd/system/friday-runner@$friday_service_user.service.d\"; printf '%s\\n' '[Unit]' \"Wants=friday-runner-tunnel-$friday_service_user.service\" \"After=friday-runner-tunnel-$friday_service_user.service\" | $friday_sudo tee \"/etc/systemd/system/friday-runner@$friday_service_user.service.d/10-tunnel.conf\" >/dev/null; $friday_sudo systemctl daemon-reload; $friday_sudo systemctl restart \"friday-runner@$friday_service_user.service\"; else mkdir -p \"$HOME/.config/systemd/user/friday-runner.service.d\"; printf '%s\\n' '[Unit]' 'Wants=friday-runner-tunnel.service' 'After=friday-runner-tunnel.service' > \"$HOME/.config/systemd/user/friday-runner.service.d/10-tunnel.conf\"; systemctl --user daemon-reload; systemctl --user restart friday-runner.service; fi",
    "echo 'Friday Runner 已安装；SSH 隧道会随系统启动并自动重连。'",
  ]);
}
