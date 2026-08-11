import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { bootstrapPlan, createRunnerRelease, createSandboxdRelease, parseBootstrapArguments, parseRunnerUpgradeArguments, parseSandboxInstallArguments, runnerUpgradePlan, sandboxInstallPlan } from "../apps/fridayctl/dist/index.js";

const execFile = promisify(execFileCallback);
const repository = new URL("../", import.meta.url).pathname;

test("fridayctl accepts only SSH-safe, token-free bootstrap arguments", () => {
  const options = parseBootstrapArguments([
    "runner", "bootstrap", "ubuntu@node.example",
    "--hub-url", "https://hub.example",
    "--control-url", "http://127.0.0.1:54310",
    "--runner-name", "workstation",
    "--service-user", "ubuntu",
    "--workspace", "infra=/srv/friday-workspaces/infra",
    "--dry-run",
  ], {});
  assert.equal(options.dryRun, true);
  assert.equal(options.hubUrl.href, "https://hub.example/");
  assert.equal(options.controlUrl.href, "http://127.0.0.1:54310/");
  assert.deepEqual(options.workspaces, [{ workspaceId: "infra", path: "/srv/friday-workspaces/infra" }]);
  assert.equal(bootstrapPlan(options).length, 6);

  assert.throws(() => parseBootstrapArguments([
    "runner", "bootstrap", "-oProxyCommand=bad",
    "--hub-url", "https://hub.example",
    "--runner-name", "bad",
    "--service-user", "ubuntu",
    "--dry-run",
  ], {}), /SSH target/);
  assert.throws(() => parseBootstrapArguments([
    "runner", "bootstrap", "node",
    "--hub-url", "http://hub.example",
    "--runner-name", "bad",
    "--service-user", "ubuntu",
    "--dry-run",
  ], {}), /HTTPS/);
  assert.throws(() => parseBootstrapArguments([
    "runner", "bootstrap", "node",
    "--hub-url", "https://hub.example",
    "--control-url", "http://control.example",
    "--runner-name", "bad",
    "--service-user", "ubuntu",
    "--dry-run",
  ], {}), /HTTPS/);
  assert.throws(() => parseBootstrapArguments([
    "runner", "bootstrap", "node",
    "--hub-url", "https://hub.example",
    "--runner-name", "bad",
    "--service-user", "ubuntu",
  ], {}), /FRIDAY_OWNER_TOKEN/);
  assert.throws(() => parseBootstrapArguments([
    "runner", "bootstrap", "node",
    "--hub-url", "https://hub.example",
    "--runner-name", "bad",
    "--service-user", "ubuntu",
    "--owner-token", "must-not-be-an-argument",
  ], { FRIDAY_OWNER_TOKEN: "owner-token" }), /Unknown option/);
});

test("fridayctl makes the networked Agent image build explicit before Sandbox installation", () => {
  const options = parseSandboxInstallArguments([
    "runner", "sandbox", "install", "node-user@managed-node.example",
    "--hub-url", "https://friday-hub.example.ts.net",
    "--service-user", "ubuntu",
    "--dry-run",
  ]);
  assert.equal(options.target, "node-user@managed-node.example");
  assert.equal(options.hubUrl.origin, "https://friday-hub.example.ts.net");
  assert.equal(sandboxInstallPlan(options).length, 6);
  assert.match(sandboxInstallPlan(options).join("\n"), /networked Docker build/);
  assert.match(sandboxInstallPlan(options).join("\n"), /automatic rollback/);
  assert.throws(() => parseSandboxInstallArguments([
    "runner", "sandbox", "install", "node.example",
    "--hub-url", "https://hub.example/path",
    "--service-user", "ubuntu",
    "--dry-run",
  ]), /without a path/);
});

test("fridayctl upgrades an enrolled Runner without accepting identity or enrollment arguments", () => {
  const options = parseRunnerUpgradeArguments([
    "runner", "upgrade", "root@managed-node.example",
    "--service-user", "friday",
    "--dry-run",
  ]);
  assert.equal(options.target, "root@managed-node.example");
  assert.equal(options.serviceUser, "friday");
  assert.equal(options.dryRun, true);
  assert.match(runnerUpgradePlan(options).join("\n"), /preserve the enrolled device identity/);
  assert.match(runnerUpgradePlan(options).join("\n"), /automatically restore the prior release/);
  assert.throws(() => parseRunnerUpgradeArguments([
    "runner", "upgrade", "root@managed-node.example",
    "--service-user", "friday",
    "--enrollment-token", "forbidden",
  ]), /Unknown option/);
});

test("fridayctl release contains a runnable compiled Runner and no TypeScript source", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fridayctl-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await createRunnerRelease(repository, directory);
  assert.match(release.releaseId, /^[a-f0-9]{16}$/);
  assert.match(release.sha256, /^[a-f0-9]{64}$/);
  assert.ok(release.sizeBytes > 0);
  const listing = (await execFile("tar", ["-tzf", release.archive])).stdout;
  assert.match(listing, /release\/apps\/runner\/dist\/index\.js/);
  assert.match(listing, /release\/packages\/protocol\/dist\/index\.js/);
  assert.doesNotMatch(listing, /\/src\//);
  assert.doesNotMatch(listing, /\/\._/);

  const extracted = join(directory, "extracted");
  const state = join(directory, "state");
  await mkdir(extracted, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await execFile("tar", ["-xzf", release.archive, "-C", extracted]);
  assert.equal((await lstat(join(extracted, "release", "node_modules", "@friday", "protocol"))).isSymbolicLink(), true);
  assert.equal((await lstat(join(extracted, "release", "apps"))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(extracted, "release", "apps", "runner", "dist"))).mode & 0o777, 0o755);
  const result = await execFile(process.execPath, [join(extracted, "release", "apps", "runner", "dist", "index.js"), "--print-capabilities"], {
    env: { ...process.env, FRIDAY_RUNNER_STATE_DIR: state },
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    protocolVersion: "1",
    runnerVersion: "0.1.0",
    capabilities: ["orchestration"],
    workspaces: [],
    shellExecution: false,
  });
  const installer = await readFile(join(repository, "deploy", "runner", "install-managed-runner.sh"), "utf8");
  assert.match(installer, /FRIDAY_RUNNER_ENROLLMENT_FILE/);
  const upgradeInstaller = await readFile(join(repository, "deploy", "runner", "upgrade-managed-runner.sh"), "utf8");
  assert.match(upgradeInstaller, /Runner upgrade failed; restoring the previous release/);
  assert.doesNotMatch(upgradeInstaller, /ENROLLMENT|OWNER_TOKEN/);
  assert.doesNotMatch(await readFile(join(repository, "deploy", "runner", "friday-runner-managed@.service"), "utf8"), /ENROLLMENT|OWNER_TOKEN/);
});

test("fridayctl builds a digestable Sandbox release with a pinned fixture base", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fridayctl-sandbox-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await createSandboxdRelease(repository, directory);
  const listing = (await execFile("tar", ["-tzf", release.archive])).stdout;
  assert.match(listing, /release\/apps\/sandboxd\/dist\/index\.js/);
  assert.match(listing, /release\/apps\/sandboxd\/dist\/agent-wrapper\.js/);
  assert.match(listing, /release\/fixture\/Dockerfile/);
  assert.match(listing, /release\/agent\/Dockerfile/);
  assert.match(listing, /release\/agent\/package-lock\.json/);
  assert.match(listing, /release\/agent\/verify-agent-contracts\.mjs/);
  assert.match(listing, /release\/friday-sandboxd\.service/);
  assert.doesNotMatch(listing, /\/\._/);
  assert.match(await readFile(join(repository, "deploy", "sandboxd", "fixture", "Dockerfile"), "utf8"), /^FROM node:22\.23\.1-bookworm-slim@sha256:[a-f0-9]{64}$/m);
});
