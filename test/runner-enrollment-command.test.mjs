import assert from "node:assert/strict";
import { execFile as callbackExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createFridayServer } from "../apps/fridayd/dist/server.js";
import { createRunnerRelease } from "../apps/fridayctl/dist/bootstrap.js";
import { runnerSshInstallCommand, validateRunnerInstallInput, validateRunnerSshTarget } from "../apps/fridayd/dist/runner-distribution.js";

const execFile = promisify(callbackExecFile);
const ownerToken = "runner-command-owner-token-long-enough";

test("one-copy enrollment commands pin a public Runner-only bundle and require Owner authority", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "friday-install-command-"));
  const release = await createRunnerRelease(process.cwd(), directory);
  const friday = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir: join(directory, "state"), ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576 }, { runnerDistributionDirectory: directory });
  t.after(async () => { await friday.stop(); await rm(directory, { recursive: true, force: true }); });
  const address = await friday.start();
  const base = `http://${address.host}:${address.port}`;
  const input = { hubUrl: base, runnerName: "private 'node' $(touch /tmp/friday-must-not-run)", serviceUser: userInfo().username };
  const request = (body, authorized = true) => fetch(base + "/v1/runners/enrollment-command", { method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${ownerToken}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await request(input, false)).status, 401);
  assert.equal((await request({ ...input, hubUrl: "http://untrusted.example" })).status, 400);
  assert.equal((await request({ ...input, serviceUser: "root;bad" })).status, 400);
  const issued = await request(input);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const enrollment = await issued.json();
  assert.equal(enrollment.bundleSha256, release.sha256);
  assert.ok(Date.parse(enrollment.expiresAt) > Date.now());
  assert.ok(Date.parse(enrollment.expiresAt) <= Date.now() + 10 * 60_000);
  assert.match(enrollment.command, /sha256sum -c -/);
  assert.match(enrollment.command, /install-standalone\.mjs/);
  assert.match(enrollment.command, /enrollment\.json/);
  assert.doesNotMatch(enrollment.command, /FRIDAY_OWNER_TOKEN|npm run|git clone|ssh /);
  assert.equal(enrollment.command.includes(ownerToken), false);
  const commandFile = join(directory, "command.sh");
  await writeFile(commandFile, enrollment.command, { mode: 0o600 });
  await execFile("sh", ["-n", commandFile]);
  const bundle = await fetch(base + "/v1/runner-install/friday-runner.tgz");
  assert.equal(bundle.status, 200);
  const bytes = Buffer.from(await bundle.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), enrollment.bundleSha256);
  const { stdout } = await execFile("tar", ["-tzf", release.archive]);
  assert.match(stdout, /release\/install-standalone\.mjs/);
  assert.doesNotMatch(stdout, /hub\.env|\.ssh|apps\/(fridayd|pi-worker|channel-gateway)|node_modules\/[^@\n]/);
  const audit = friday.store.list().find((event) => event.type === "runner.install-command.issued");
  assert.equal(audit.payload.runnerId, enrollment.runnerId);
  assert.equal(JSON.stringify(audit).includes(enrollment.enrollmentToken), false);
  await friday.stop();
  const restarted = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir: join(directory, "state"), ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576 }, { runnerDistributionDirectory: directory });
  t.after(() => restarted.stop());
  await restarted.start();
  assert.ok(restarted.store.list().some((event) => event.type === "runner.install-command.issued"));
});

test("installation URL validation refuses credentials, subpaths and unsupported transports", () => {
  for (const hubUrl of ["https://user:pass@example.test", "https://example.test/path", "https://example.test/?token=secret", "file:///tmp/a", "http://192.168.1.2:4310"]) {
    assert.throws(() => validateRunnerInstallInput({ hubUrl, runnerName: "node", serviceUser: "ubuntu" }));
  }
});

test("SSH enrollment emits one safe command that prepares a persistent outbound tunnel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "friday-ssh-install-command-"));
  const enrollment = { runnerId: "018f6f57-51d4-7b48-a3a3-c5e8b194aaf2", enrollmentToken: "T".repeat(43), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  const command = runnerSshInstallCommand({ sshTarget: "hub-ssh", tunnelPort: 14_310, hubPort: 4_310, runnerName: "build node", serviceUser: "ubuntu" }, enrollment, "a".repeat(64));
  assert.match(command, /^sh -c /);
  assert.equal(command.includes("\n"), false);
  assert.match(command, /BatchMode=yes/);
  assert.match(command, /PasswordAuthentication=no/);
  assert.match(command, /friday-runner-tunnel-\$friday_service_user\.service/);
  assert.match(command, /friday_tunnel_port=14310/);
  assert.match(command, /http:\/\/127\.0\.0\.1:\$friday_tunnel_port\/health/);
  assert.match(command, /install-standalone\.mjs/);
  assert.doesNotMatch(command, /fridayctl|npm run|git clone|FRIDAY_OWNER_TOKEN/);
  assert.equal(command.includes(enrollment.enrollmentToken), true);
  const file = join(directory, "install.sh");
  await writeFile(file, command + "\n", { mode: 0o600 });
  await execFile("sh", ["-n", file]);
  await rm(directory, { recursive: true, force: true });

  for (const target of ["hub-ssh", "ubuntu@hub.example", "ubuntu@100.64.0.1", "ubuntu@[fd7a::1]", "node_user@host-1.example"]) assert.equal(validateRunnerSshTarget(target), target);
  for (const target of ["", "hub ssh", "user@host;reboot", "user@@host", "-oProxyCommand=bad", "user@host/path"]) assert.throws(() => validateRunnerSshTarget(target));
  assert.throws(() => runnerSshInstallCommand({ sshTarget: "hub-ssh", tunnelPort: 80, hubPort: 4_310 }, enrollment, "a".repeat(64)), /tunnel port/);
  assert.throws(() => runnerSshInstallCommand({ sshTarget: "hub-ssh", tunnelPort: 14_310, hubPort: 4_310 }, enrollment, "not-a-digest"), /bundle digest/);
});

test("standalone user installation enrolls outbound and survives deletion of its download directory", { skip: process.getuid?.() === 0 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "friday-standalone-install-"));
  const distribution = join(directory, "distribution");
  const home = join(directory, "home");
  const mockBin = join(directory, "bin");
  await mkdir(distribution);
  await mkdir(home);
  await mkdir(mockBin);
  await writeFile(join(mockBin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(mockBin, "loginctl"), "#!/bin/sh\nprintf 'Linger=yes\\n'\n", { mode: 0o755 });
  const release = await createRunnerRelease(process.cwd(), distribution);
  await execFile("tar", ["-xzf", release.archive, "-C", distribution]);
  const friday = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir: join(directory, "hub-state"), ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576 });
  t.after(async () => { await friday.stop(); await rm(directory, { recursive: true, force: true }); });
  const address = await friday.start();
  const hub = `http://${address.host}:${address.port}`;
  const enrollment = friday.runnerRegistry.issueEnrollment();
  const credentialPath = join(directory, "enrollment.json");
  await writeFile(credentialPath, JSON.stringify(enrollment), { mode: 0o600 });
  const environment = { ...process.env, HOME: home, PATH: `${mockBin}:${process.env.PATH}` };
  delete environment.FRIDAY_OWNER_TOKEN;
  const result = await execFile(process.execPath, [join(distribution, "release/install-standalone.mjs"), credentialPath, hub, "private outbound node", userInfo().username, release.releaseId], { env: environment });
  assert.equal(JSON.parse(result.stdout).mode, "user");
  await assert.rejects(access(credentialPath));
  const state = join(home, ".local/share/friday-runner");
  assert.equal((await stat(join(state, "runner-device.json"))).mode & 0o777, 0o600);
  const installed = join(home, ".local/share/friday-agent/releases", release.releaseId);
  assert.equal(await readlink(join(installed, "node_modules/@friday/protocol")), "../../packages/protocol");
  await rm(distribution, { recursive: true });
  const registered = await execFile(process.execPath, [join(installed, "apps/runner/dist/index.js"), "--once"], { env: { ...environment, FRIDAY_HUB_URL: hub, FRIDAY_RUNNER_NAME: "private outbound node", FRIDAY_RUNNER_STATE_DIR: state } });
  assert.equal(JSON.parse(registered.stdout).ok, true);
  assert.equal(friday.runnerRegistry.isEnrolled(enrollment.runnerId), true);
  const unit = await readFile(join(home, ".config/systemd/user/friday-runner.service"), "utf8");
  assert.match(unit, /Restart=always/);
  assert.equal(unit.includes(enrollment.enrollmentToken), false);
  await assert.rejects(execFile(process.execPath, [join(installed, "install-standalone.mjs"), join(directory, "missing.json"), hub, "duplicate", userInfo().username, release.releaseId], { env: environment }));
});
