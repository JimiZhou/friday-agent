import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("Hub deployment preserves loopback-only ingress and filesystem isolation", async () => {
  const [compose, dockerfile, ignore, installer, telegram] = await Promise.all([
    read("deploy/hub/compose.yml"),
    read("deploy/hub/Dockerfile"),
    read(".dockerignore"),
    read("deploy/hub/install-hub.sh"),
    read("deploy/hub/configure-telegram.sh"),
  ]);

  assert.match(compose, /network_mode: host/);
  assert.match(compose, /FRIDAY_HOST: 127\.0\.0\.1/);
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.doesNotMatch(compose, /public-ingress|caddy/i);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /FRIDAY_UID:\?set FRIDAY_UID/);
  assert.match(dockerfile, /FROM node:22\.22\.0-bookworm-slim/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /apps\/pi-worker\/dist/);
  assert.match(dockerfile, /apps\/channel-gateway\/dist/);
  assert.match(ignore, /^deploy\/hub\/hub\.env$/m);
  assert.match(ignore, /^deploy\/gateway\/gateway\.env$/m);
  assert.match(compose, /FRIDAY_GATEWAY_STATE_DIR: \/state/);
  assert.match(installer, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:4310/);
  assert.doesNotMatch(installer, /^\s*tailscale funnel\b/im);
  assert.doesNotMatch(telegram, /--bot-token|--owner-id/);
});

test("Runner service is outbound-only, restartable, and does not persist bootstrap tokens", async () => {
  const [unit, environment, guide] = await Promise.all([
    read("deploy/runner/friday-runner@.service"),
    read("deploy/runner/runner.env.example"),
    read("deploy/README.md"),
  ]);

  assert.match(unit, /^User=%i$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/friday-runner \/srv\/friday-workspaces$/m);
  assert.match(unit, /^PrivateDevices=yes$/m);
  assert.match(unit, /^UMask=0077$/m);
  // V8 requires JIT memory; do not add MemoryDenyWriteExecute here.
  assert.doesNotMatch(unit, /^MemoryDenyWriteExecute=yes$/m);
  assert.doesNotMatch(environment, /ENROLLMENT_TOKEN|RUNNER_TOKEN/);
  assert.match(guide, /Token 不接受命令行参数，不进入 SSH 命令、systemd 环境或节点长期文件/);
  assert.match(guide, /不开放 Friday 管理端口/);
  assert.match(guide, /PasswordAuthentication=no/);
});

test("fridayctl refuses SSH password and keyboard-interactive authentication", async () => {
  const source = await read("apps/fridayctl/src/bootstrap.ts");
  assert.match(source, /"PasswordAuthentication=no"/);
  assert.match(source, /"KbdInteractiveAuthentication=no"/);
  assert.match(source, /"StrictHostKeyChecking=yes"/);
  assert.match(source, /"BatchMode=yes"/);
});

test("managed Runner installer restores the active release when service activation fails", async () => {
  const [installer, upgrade] = await Promise.all([
    read("deploy/runner/install-managed-runner.sh"),
    read("deploy/runner/upgrade-managed-runner.sh"),
  ]);
  assert.match(installer, /rollback_activation/);
  assert.match(installer, /Runner activation failed; restoring the previous release/);
  assert.match(installer, /previous_current=\$\(readlink/);
  assert.match(installer, /mutation_started=1/);
  assert.match(upgrade, /rollback_activation/);
  assert.match(upgrade, /Runner upgrade failed; restoring the previous release/);
  assert.match(upgrade, /runner-device\.json/);
  assert.match(upgrade, /hub-identity\.json/);
  assert.doesNotMatch(upgrade, /FRIDAY_ENROLLMENT_TOKEN|FRIDAY_OWNER_TOKEN/);
});

test("Agent image executes exact CLI HTTP contract fixtures during its build", async () => {
  const [dockerfile, fixture] = await Promise.all([
    read("deploy/sandboxd/agent/Dockerfile"),
    read("deploy/sandboxd/agent/verify-agent-contracts.mjs"),
  ]);
  assert.match(dockerfile, /RUN node \/usr\/local\/lib\/friday-agent\/verify-agent-contracts\.mjs/);
  assert.match(fixture, /codex: "\/openai\/v1\/responses"/);
  assert.match(fixture, /pi: "\/openai\/v1\/chat\/completions"/);
  assert.match(fixture, /claude: "\/anthropic\/v1\/messages\?beta=true"/);
  assert.match(fixture, /friday-job-relay-only/);
});

test("root sandbox supervisor is constrained to its relay runtime and required capabilities", async () => {
  const [unit, installer, source] = await Promise.all([
    read("deploy/sandboxd/friday-sandboxd.service"),
    read("deploy/sandboxd/install-managed-sandboxd.sh"),
    read("apps/sandboxd/src/index.ts"),
  ]);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=\/run\/friday-sandboxd$/m);
  assert.match(unit, /^ProtectProc=invisible$/m);
  assert.match(unit, /^RestrictNamespaces=yes$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assert.match(unit, /^CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE$/m);
  assert.match(installer, /rollback_activation/);
  assert.match(installer, /restoring the previous release and service files/);
  assert.match(installer, /previous_current=\$\(readlink/);
  assert.match(installer, /systemctl restart friday-sandboxd\.service/);
  assert.doesNotMatch(installer, /systemctl enable --now friday-sandboxd\.service/);
  assert.ok(source.indexOf("chmodSync(socketPath, 0o600)") < source.indexOf("chownSync(socketPath, config.runnerUid, config.runnerGid)"), "mode must be set before ownership is handed to the container UID without CAP_FOWNER");
  assert.match(installer, /FRIDAY_SANDBOX_RUNNER_UID/);
});
