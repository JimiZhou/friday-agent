import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_PATTERN = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WorkspaceBootstrap {
  readonly workspaceId: string;
  readonly path: string;
}

export interface BootstrapOptions {
  readonly target: string;
  readonly hubUrl: URL;
  /**
   * Owner-only enrollment/control endpoint. This may be an SSH-forwarded
   * loopback URL while the Runner keeps the stable Hub URL above.
   */
  readonly controlUrl: URL;
  readonly runnerName: string;
  readonly serviceUser: string;
  readonly repoRoot: string;
  readonly ownerTokenEnvironment: string;
  readonly identityFile?: string;
  readonly port?: number;
  readonly workspaces: readonly WorkspaceBootstrap[];
  readonly dryRun: boolean;
}

export interface RunnerRelease {
  readonly archive: string;
  readonly releaseId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface BootstrapResult {
  readonly runnerId: string;
  readonly releaseId: string;
  readonly target: string;
  readonly online: boolean;
}

interface SshConnectionOptions {
  readonly target: string;
  readonly identityFile?: string;
  readonly port?: number;
}

export interface SandboxInstallOptions extends SshConnectionOptions {
  readonly hubUrl: URL;
  readonly serviceUser: string;
  readonly repoRoot: string;
  readonly dryRun: boolean;
}

export interface SandboxInstallResult {
  readonly target: string;
  readonly releaseId: string;
  readonly agentImageId: string;
}

export interface RunnerUpgradeOptions extends SshConnectionOptions {
  readonly serviceUser: string;
  readonly repoRoot: string;
  readonly dryRun: boolean;
}

export interface RunnerUpgradeResult {
  readonly target: string;
  readonly releaseId: string;
  readonly previousRelease: string;
}

export function parseBootstrapArguments(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): BootstrapOptions {
  if (args[0] !== "runner" || args[1] !== "bootstrap" || args[2] === undefined) throw usage();
  const target = requireTarget(args[2]);
  let hubUrl: URL | undefined;
  let controlUrl: URL | undefined;
  let runnerName: string | undefined;
  let serviceUser: string | undefined;
  let repoRoot = process.cwd();
  let ownerTokenEnvironment = "FRIDAY_OWNER_TOKEN";
  let identityFile: string | undefined;
  let port: number | undefined;
  let dryRun = false;
  const workspaces: WorkspaceBootstrap[] = [];

  for (let index = 3; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") { dryRun = true; continue; }
    const value = args[index + 1];
    if (value === undefined) throw usage(`Missing value for ${argument}`);
    switch (argument) {
      case "--hub-url": hubUrl = requireHubUrl(value); break;
      case "--control-url": controlUrl = requireHubUrl(value); break;
      case "--runner-name": runnerName = requireText(value, "runner name", 128); break;
      case "--service-user": serviceUser = requireUser(value); break;
      case "--repo-root": repoRoot = resolve(value); break;
      case "--owner-token-env": ownerTokenEnvironment = requireEnvironmentName(value); break;
      case "--identity-file": identityFile = resolve(value); break;
      case "--port": port = requirePort(value); break;
      case "--workspace": workspaces.push(requireWorkspace(value)); break;
      default: throw usage(`Unknown option: ${argument}`);
    }
    index += 1;
  }
  if (hubUrl === undefined || runnerName === undefined || serviceUser === undefined) throw usage("--hub-url, --runner-name, and --service-user are required");
  if (!dryRun && (environment[ownerTokenEnvironment]?.trim() ?? "") === "") {
    throw new Error(`${ownerTokenEnvironment} must contain the Owner token; tokens are never accepted as command-line arguments`);
  }
  return { target, hubUrl, controlUrl: controlUrl ?? hubUrl, runnerName, serviceUser, repoRoot, ownerTokenEnvironment, ...(identityFile === undefined ? {} : { identityFile }), ...(port === undefined ? {} : { port }), workspaces, dryRun };
}

export function bootstrapPlan(options: BootstrapOptions): readonly string[] {
  return [
    `preflight ${options.target} (Linux, Node >=22.19.0, systemd, runuser, root or passwordless sudo)`,
    "build a Runner-only release archive from compiled dist files",
    `issue a ten-minute enrollment for ${options.runnerName}`,
    "copy release and one-time 0600 enrollment handoff over SSH",
    `install and start outbound friday-runner@${options.serviceUser}.service`,
    "verify the enrolled Runner is online at the Hub",
  ];
}

export function parseSandboxInstallArguments(args: readonly string[]): SandboxInstallOptions {
  if (args[0] !== "runner" || args[1] !== "sandbox" || args[2] !== "install" || args[3] === undefined) throw sandboxUsage();
  const target = requireTarget(args[3]);
  let hubUrl: URL | undefined;
  let serviceUser: string | undefined;
  let repoRoot = process.cwd();
  let identityFile: string | undefined;
  let port: number | undefined;
  let dryRun = false;
  for (let index = 4; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") { dryRun = true; continue; }
    const value = args[index + 1];
    if (value === undefined) throw sandboxUsage(`Missing value for ${argument}`);
    switch (argument) {
      case "--hub-url": hubUrl = requireHubOrigin(value); break;
      case "--service-user": serviceUser = requireUser(value); break;
      case "--repo-root": repoRoot = resolve(value); break;
      case "--identity-file": identityFile = resolve(value); break;
      case "--port": port = requirePort(value); break;
      default: throw sandboxUsage(`Unknown option: ${argument}`);
    }
    index += 1;
  }
  if (hubUrl === undefined || serviceUser === undefined) throw sandboxUsage("--hub-url and --service-user are required");
  return { target, hubUrl, serviceUser, repoRoot, ...(identityFile === undefined ? {} : { identityFile }), ...(port === undefined ? {} : { port }), dryRun };
}

export function sandboxInstallPlan(options: SandboxInstallOptions): readonly string[] {
  return [
    `preflight ${options.target} (Linux, Node >=22.19.0, Docker, systemd, and passwordless root)`,
    "build and digest a Sandbox Supervisor release from compiled dist files",
    "upload the release over the already trusted SSH host-key path",
    "perform one networked Docker build of exact Codex, Pi, and Claude packages",
    "run the three real CLI HTTP contract fixtures inside the Agent image build",
    `atomically activate friday-sandboxd and restart friday-runner@${options.serviceUser}.service with automatic rollback`,
  ];
}

export function parseRunnerUpgradeArguments(args: readonly string[]): RunnerUpgradeOptions {
  if (args[0] !== "runner" || args[1] !== "upgrade" || args[2] === undefined) throw runnerUpgradeUsage();
  const target = requireTarget(args[2]);
  let serviceUser: string | undefined;
  let repoRoot = process.cwd();
  let identityFile: string | undefined;
  let port: number | undefined;
  let dryRun = false;
  for (let index = 3; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") { dryRun = true; continue; }
    const value = args[index + 1];
    if (value === undefined) throw runnerUpgradeUsage(`Missing value for ${argument}`);
    switch (argument) {
      case "--service-user": serviceUser = requireUser(value); break;
      case "--repo-root": repoRoot = resolve(value); break;
      case "--identity-file": identityFile = resolve(value); break;
      case "--port": port = requirePort(value); break;
      default: throw runnerUpgradeUsage(`Unknown option: ${argument}`);
    }
    index += 1;
  }
  if (serviceUser === undefined) throw runnerUpgradeUsage("--service-user is required");
  return { target, serviceUser, repoRoot, ...(identityFile === undefined ? {} : { identityFile }), ...(port === undefined ? {} : { port }), dryRun };
}

export function runnerUpgradePlan(options: RunnerUpgradeOptions): readonly string[] {
  return [
    `preflight existing friday-runner@${options.serviceUser}.service on ${options.target}`,
    "build and digest a Runner-only release from compiled dist files",
    "preserve the enrolled device identity, Hub pin, Workspace registry, and private service environment",
    "atomically switch the Runner release and managed systemd unit",
    "restart the existing outbound Runner and automatically restore the prior release on failure",
  ];
}

export async function createRunnerRelease(repoRoot: string, outputDirectory: string): Promise<RunnerRelease> {
  const root = resolve(repoRoot);
  const releaseRoot = join(outputDirectory, "release");
  // The archive is installed root-owned but executed by an unprivileged
  // service user, so every release directory must remain traversable.
  await mkdir(join(releaseRoot, "apps", "runner"), { recursive: true, mode: 0o755 });
  await mkdir(join(releaseRoot, "packages", "protocol"), { recursive: true, mode: 0o755 });
  await mkdir(join(releaseRoot, "node_modules", "@friday"), { recursive: true, mode: 0o755 });
  for (const required of [
    join(root, "apps", "runner", "dist", "index.js"),
    join(root, "packages", "protocol", "dist", "index.js"),
    join(root, "deploy", "runner", "friday-runner-managed@.service"),
  ]) await access(required);
  await cp(join(root, "apps", "runner", "dist"), join(releaseRoot, "apps", "runner", "dist"), { recursive: true });
  await cp(join(root, "packages", "protocol", "dist"), join(releaseRoot, "packages", "protocol", "dist"), { recursive: true });
  await cp(join(root, "packages", "protocol", "schemas"), join(releaseRoot, "packages", "protocol", "schemas"), { recursive: true });
  await cp(join(root, "apps", "runner", "package.json"), join(releaseRoot, "apps", "runner", "package.json"));
  await cp(join(root, "packages", "protocol", "package.json"), join(releaseRoot, "packages", "protocol", "package.json"));
  await cp(join(root, "deploy", "runner", "friday-runner-managed@.service"), join(releaseRoot, "friday-runner-managed@.service"));
  await symlink("../../packages/protocol", join(releaseRoot, "node_modules", "@friday", "protocol"));
  await writeFile(join(releaseRoot, "RELEASE.json"), `${JSON.stringify({ product: "friday-runner", version: "0.2.1", node: ">=22.19.0" }, null, 2)}\n`, { mode: 0o644 });
  const archive = join(outputDirectory, "friday-runner.tgz");
  await execFile("tar", ["--no-xattrs", "-czf", archive, "-C", outputDirectory, basename(releaseRoot)], { timeout: 30_000, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { archive, releaseId: sha256.slice(0, 16), sha256, sizeBytes: bytes.byteLength };
}

export async function createSandboxdRelease(repoRoot: string, outputDirectory: string): Promise<RunnerRelease> {
  const root = resolve(repoRoot);
  const releaseRoot = join(outputDirectory, "release");
  await mkdir(join(releaseRoot, "apps", "sandboxd"), { recursive: true, mode: 0o755 });
  await mkdir(join(releaseRoot, "packages", "protocol"), { recursive: true, mode: 0o755 });
  await mkdir(join(releaseRoot, "node_modules", "@friday"), { recursive: true, mode: 0o755 });
  for (const required of [
    join(root, "apps", "sandboxd", "dist", "index.js"),
    join(root, "apps", "sandboxd", "dist", "agent-wrapper.js"),
    join(root, "packages", "protocol", "dist", "index.js"),
    join(root, "deploy", "sandboxd", "friday-sandboxd.service"),
    join(root, "deploy", "sandboxd", "agent", "Dockerfile"),
    join(root, "deploy", "sandboxd", "agent", "package-lock.json"),
    join(root, "deploy", "sandboxd", "agent", "verify-agent-contracts.mjs"),
  ]) await access(required);
  await cp(join(root, "apps", "sandboxd", "dist"), join(releaseRoot, "apps", "sandboxd", "dist"), { recursive: true });
  await cp(join(root, "apps", "sandboxd", "package.json"), join(releaseRoot, "apps", "sandboxd", "package.json"));
  await cp(join(root, "packages", "protocol", "dist"), join(releaseRoot, "packages", "protocol", "dist"), { recursive: true });
  await cp(join(root, "packages", "protocol", "package.json"), join(releaseRoot, "packages", "protocol", "package.json"));
  await cp(join(root, "deploy", "sandboxd", "agent"), join(releaseRoot, "agent"), { recursive: true });
  await cp(join(root, "deploy", "sandboxd", "friday-sandboxd.service"), join(releaseRoot, "friday-sandboxd.service"));
  await symlink("../../packages/protocol", join(releaseRoot, "node_modules", "@friday", "protocol"));
  await writeFile(join(releaseRoot, "RELEASE.json"), `${JSON.stringify({ product: "friday-sandboxd", version: "0.2.1", node: ">=22.19.0" }, null, 2)}\n`, { mode: 0o644 });
  const archive = join(outputDirectory, "friday-sandboxd.tgz");
  await execFile("tar", ["--no-xattrs", "-czf", archive, "-C", outputDirectory, basename(releaseRoot)], { timeout: 30_000, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { archive, releaseId: sha256.slice(0, 16), sha256, sizeBytes: bytes.byteLength };
}

export async function installSandboxd(options: SandboxInstallOptions): Promise<SandboxInstallResult> {
  if (options.dryRun) throw new Error("installSandboxd cannot mutate a dry-run plan");
  await verifyIdentityFile(options.identityFile);
  await sandboxPreflight(options);
  const temporary = await mkdtemp(join(tmpdir(), "fridayctl-sandbox-"));
  const remoteNonce = randomUUID().replaceAll("-", "");
  const remoteBase = `/tmp/friday-sandboxd-${remoteNonce}`;
  const remoteArchive = `${remoteBase}.tgz`;
  const remoteInstaller = `${remoteBase}.sh`;
  let uploaded = false;
  try {
    const release = await createSandboxdRelease(options.repoRoot, temporary);
    await scp(options, [
      [release.archive, remoteArchive],
      [join(options.repoRoot, "deploy", "sandboxd", "install-managed-sandboxd.sh"), remoteInstaller],
    ]);
    uploaded = true;
    const privilege = await remotePrivilege(options);
    const output = await ssh(options, `${privilege} sh ${remoteInstaller} ${remoteArchive} ${release.sha256} ${options.serviceUser} ${options.hubUrl.origin}`, 30 * 60_000);
    const releaseId = output.match(/^release_id=([a-f0-9]{16})$/m)?.[1];
    const agentImageId = output.match(/^agent_image_id=(sha256:[a-f0-9]{64})$/m)?.[1];
    if (releaseId !== release.releaseId || agentImageId === undefined) {
      throw new Error("Remote Sandbox installer returned invalid release evidence");
    }
    return { target: options.target, releaseId, agentImageId };
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (uploaded) await ssh(options, `rm -f ${remoteArchive} ${remoteInstaller}`, 10_000).catch(() => undefined);
  }
}

export async function upgradeRunner(options: RunnerUpgradeOptions): Promise<RunnerUpgradeResult> {
  if (options.dryRun) throw new Error("upgradeRunner cannot mutate a dry-run plan");
  await verifyIdentityFile(options.identityFile);
  await runnerUpgradePreflight(options);
  const temporary = await mkdtemp(join(tmpdir(), "fridayctl-runner-upgrade-"));
  const remoteNonce = randomUUID().replaceAll("-", "");
  const remoteBase = `/tmp/friday-runner-upgrade-${remoteNonce}`;
  const remoteArchive = `${remoteBase}.tgz`;
  const remoteInstaller = `${remoteBase}.sh`;
  let uploaded = false;
  try {
    const release = await createRunnerRelease(options.repoRoot, temporary);
    await scp(options, [
      [release.archive, remoteArchive],
      [join(options.repoRoot, "deploy", "runner", "upgrade-managed-runner.sh"), remoteInstaller],
    ]);
    uploaded = true;
    const privilege = await remotePrivilege(options);
    const output = await ssh(options, `${privilege} sh ${remoteInstaller} ${remoteArchive} ${release.sha256} ${options.serviceUser}`, 120_000);
    const releaseId = output.match(/^release_id=([a-f0-9]{16})$/m)?.[1];
    const previousRelease = output.match(/^previous_release=(releases\/[a-f0-9]{16})$/m)?.[1];
    if (releaseId !== release.releaseId || previousRelease === undefined) throw new Error("Remote Runner upgrade returned invalid release evidence");
    return { target: options.target, releaseId, previousRelease };
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (uploaded) await ssh(options, `rm -f ${remoteArchive} ${remoteInstaller}`, 10_000).catch(() => undefined);
  }
}

export async function bootstrapRunner(options: BootstrapOptions, environment: NodeJS.ProcessEnv = process.env): Promise<BootstrapResult> {
  if (options.dryRun) throw new Error("bootstrapRunner cannot mutate a dry-run plan");
  await verifyIdentityFile(options.identityFile);
  await sshPreflight(options);
  const temporary = await mkdtemp(join(tmpdir(), "fridayctl-bootstrap-"));
  const remoteNonce = randomUUID().replaceAll("-", "");
  const remoteBase = `/tmp/friday-bootstrap-${remoteNonce}`;
  const remoteFiles = {
    archive: `${remoteBase}.tgz`,
    bootstrap: `${remoteBase}.env`,
    service: `${remoteBase}.service.env`,
    workspaces: `${remoteBase}.workspaces`,
    installer: `${remoteBase}.sh`,
  };
  let uploaded = false;
  try {
    const release = await createRunnerRelease(options.repoRoot, temporary);
    const ownerToken = environment[options.ownerTokenEnvironment] as string;
    const enrollment = await issueEnrollment(options.controlUrl, ownerToken);
    const bootstrapFile = join(temporary, "bootstrap.env");
    const serviceFile = join(temporary, "runner.env");
    const workspacesFile = join(temporary, "workspaces.tsv");
    const installerFile = join(options.repoRoot, "deploy", "runner", "install-managed-runner.sh");
    await writeFile(bootstrapFile, shellEnvironment({
      FRIDAY_HUB_URL: options.hubUrl.href.replace(/\/$/, ""),
      FRIDAY_RUNNER_ID: enrollment.runnerId,
      FRIDAY_ENROLLMENT_TOKEN: enrollment.enrollmentToken,
      FRIDAY_RUNNER_NAME: options.runnerName,
      FRIDAY_SERVICE_USER: options.serviceUser,
      FRIDAY_RELEASE_ID: release.releaseId,
      FRIDAY_RELEASE_SHA256: release.sha256,
    }), { mode: 0o600 });
    await writeFile(serviceFile, shellEnvironment({
      FRIDAY_HUB_URL: options.hubUrl.href.replace(/\/$/, ""),
      FRIDAY_RUNNER_NAME: options.runnerName,
      FRIDAY_RUNNER_STATE_DIR: "/var/lib/friday-runner",
      FRIDAY_HEARTBEAT_INTERVAL_MS: "15000",
      FRIDAY_REQUEST_TIMEOUT_MS: "10000",
    }), { mode: 0o600 });
    await writeFile(workspacesFile, options.workspaces.map((workspace) => `${workspace.workspaceId}\t${workspace.path}\n`).join(""), { mode: 0o600 });
    await scp(options, [
      [release.archive, remoteFiles.archive],
      [bootstrapFile, remoteFiles.bootstrap],
      [serviceFile, remoteFiles.service],
      [workspacesFile, remoteFiles.workspaces],
      [installerFile, remoteFiles.installer],
    ]);
    uploaded = true;
    const privilege = await remotePrivilege(options);
    await ssh(options, `${privilege} sh ${remoteFiles.installer} ${remoteFiles.archive} ${remoteFiles.bootstrap} ${remoteFiles.service} ${remoteFiles.workspaces}`, 120_000);
    const online = await waitRunnerOnline(options.controlUrl, ownerToken, enrollment.runnerId);
    return { runnerId: enrollment.runnerId, releaseId: release.releaseId, target: options.target, online };
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (uploaded) {
      await ssh(options, `rm -f ${Object.values(remoteFiles).join(" ")}`, 10_000).catch(() => undefined);
    }
  }
}

async function sshPreflight(options: BootstrapOptions): Promise<void> {
  const output = await ssh(options, "set -eu; test \"$(uname -s)\" = Linux; node_bin=$(command -v node); test -x \"$node_bin\"; command -v systemctl >/dev/null; command -v runuser >/dev/null; command -v sha256sum >/dev/null; command -v tar >/dev/null; printf 'node=%s\\n' \"$($node_bin --version)\"; printf 'uid=%s\\n' \"$(id -u)\"; if test \"$(id -u)\" -ne 0; then sudo -n true; fi", 20_000);
  const version = output.match(/^node=v(\d+)\.(\d+)\.(\d+)$/m);
  if (version === null || Number(version[1]) < 22 || (Number(version[1]) === 22 && Number(version[2]) < 19)) {
    throw new Error("Remote Node.js must be 22.19.0 or newer");
  }
}

async function sandboxPreflight(options: SandboxInstallOptions): Promise<void> {
  const privilege = await remotePrivilege(options);
  const output = await ssh(options, `set -eu; test "$(uname -s)" = Linux; node_bin=$(command -v node); test -x "$node_bin"; command -v docker >/dev/null; command -v systemctl >/dev/null; command -v runuser >/dev/null; command -v sha256sum >/dev/null; command -v tar >/dev/null; id ${options.serviceUser} >/dev/null; ${privilege} docker info >/dev/null; ${privilege} test -f /var/lib/friday-runner/hub-identity.json; printf 'node=%s\\n' "$($node_bin --version)"`, 30_000);
  const version = output.match(/^node=v(\d+)\.(\d+)\.(\d+)$/m);
  if (version === null || Number(version[1]) < 22 || (Number(version[1]) === 22 && Number(version[2]) < 19)) {
    throw new Error("Remote Node.js must be 22.19.0 or newer");
  }
}

async function runnerUpgradePreflight(options: RunnerUpgradeOptions): Promise<void> {
  const privilege = await remotePrivilege(options);
  const output = await ssh(options, `set -eu; test "$(uname -s)" = Linux; node_bin=$(command -v node); test -x "$node_bin"; command -v systemctl >/dev/null; command -v runuser >/dev/null; command -v sha256sum >/dev/null; command -v tar >/dev/null; id ${options.serviceUser} >/dev/null; ${privilege} test -L /opt/friday-agent/current; ${privilege} test -f /etc/friday-runner/${options.serviceUser}.env; ${privilege} test -f /var/lib/friday-runner/runner-device.json; ${privilege} test -f /var/lib/friday-runner/hub-identity.json; ${privilege} systemctl is-active --quiet friday-runner@${options.serviceUser}.service; printf 'node=%s\n' "$($node_bin --version)"`, 30_000);
  const version = output.match(/^node=v(\d+)\.(\d+)\.(\d+)$/m);
  if (version === null || Number(version[1]) < 22 || (Number(version[1]) === 22 && Number(version[2]) < 19)) {
    throw new Error("Remote Node.js must be 22.19.0 or newer");
  }
}

async function remotePrivilege(options: SshConnectionOptions): Promise<"" | "sudo -n"> {
  const output = await ssh(options, "id -u", 10_000);
  return output.trim() === "0" ? "" : "sudo -n";
}

async function issueEnrollment(hubUrl: URL, ownerToken: string): Promise<{ readonly runnerId: string; readonly enrollmentToken: string }> {
  const response = await fetch(new URL("/v1/runners/enrollment-tokens", hubUrl), {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof body.runnerId !== "string" || !UUID_PATTERN.test(body.runnerId) || typeof body.enrollmentToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.enrollmentToken)) {
    throw new Error(`Hub enrollment request failed with ${response.status}`);
  }
  return { runnerId: body.runnerId.toLowerCase(), enrollmentToken: body.enrollmentToken };
}

async function waitRunnerOnline(hubUrl: URL, ownerToken: string, runnerId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await fetch(new URL("/v1/runners", hubUrl), { redirect: "error", headers: { authorization: `Bearer ${ownerToken}` }, signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const body = await response.json() as { runners?: readonly { nodeId?: unknown; online?: unknown }[] };
      if (body.runners?.some((runner) => runner.nodeId === runnerId && runner.online === true) === true) return true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  return false;
}

async function scp(options: SshConnectionOptions, files: readonly (readonly [string, string])[]): Promise<void> {
  for (const [local, remote] of files) {
    await execFile("scp", [...scpArguments(options), local, `${options.target}:${remote}`], { timeout: 60_000, maxBuffer: 4 * 1_048_576 });
  }
}

async function ssh(options: SshConnectionOptions, command: string, timeout: number): Promise<string> {
  const result = await execFile("ssh", [...sshArguments(options), options.target, command], { timeout, maxBuffer: 4 * 1_048_576 });
  return result.stdout;
}

function sshArguments(options: SshConnectionOptions): string[] {
  return ["-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", ...(options.identityFile === undefined ? [] : ["-i", options.identityFile]), ...(options.port === undefined ? [] : ["-p", String(options.port)])];
}

function scpArguments(options: SshConnectionOptions): string[] {
  return ["-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", ...(options.identityFile === undefined ? [] : ["-i", options.identityFile]), ...(options.port === undefined ? [] : ["-P", String(options.port)])];
}

function shellEnvironment(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values).map(([key, value]) => `${key}=${shellQuote(value)}`).join("\n")}\n`;
}

function shellQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) throw new Error("Bootstrap values must be single-line text");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function verifyIdentityFile(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) throw new Error("SSH identity file must be a non-symlink private file");
}

function requireTarget(value: string): string {
  if (value.startsWith("-") || value.length > 255 || !TARGET_PATTERN.test(value)) throw new Error("SSH target must be a host or user@host without shell syntax");
  return value;
}

function requireHubUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("--hub-url must be an absolute URL"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("--hub-url must be HTTPS or explicit loopback HTTP without credentials, query, or fragment");
  return url;
}

function requireHubOrigin(value: string): URL {
  const url = requireHubUrl(value);
  if (url.pathname !== "/") throw new Error("--hub-url must be an HTTPS origin without a path");
  return url;
}

function requireUser(value: string): string { if (!USER_PATTERN.test(value)) throw new Error("--service-user is invalid"); return value; }
function requireText(value: string, name: string, max: number): string { const text = value.trim(); if (text.length === 0 || text.length > max || /[\r\n\0]/.test(text)) throw new Error(`${name} is invalid`); return text; }
function requireEnvironmentName(value: string): string { if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) throw new Error("--owner-token-env is invalid"); return value; }
function requirePort(value: string): number { if (!/^\d+$/.test(value)) throw new Error("--port is invalid"); const port = Number(value); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port is invalid"); return port; }
function requireWorkspace(value: string): WorkspaceBootstrap { const separator = value.indexOf("="); const workspaceId = value.slice(0, separator); const path = value.slice(separator + 1); if (separator < 1 || !WORKSPACE_PATTERN.test(workspaceId) || !path.startsWith("/srv/friday-workspaces/") || /[\t\r\n\0]/.test(path)) throw new Error("--workspace must be id=/srv/friday-workspaces/<git-root>"); return { workspaceId, path }; }
function usage(detail?: string): Error { return new Error(`${detail === undefined ? "" : `${detail}\n`}Usage: fridayctl runner bootstrap <user@host> --hub-url <https-url> [--control-url <https-or-loopback-url>] --runner-name <name> --service-user <user> [--identity-file <path>] [--port <port>] [--workspace <id=/srv/friday-workspaces/repo>] [--dry-run]`); }
function sandboxUsage(detail?: string): Error { return new Error(`${detail === undefined ? "" : `${detail}\n`}Usage: fridayctl runner sandbox install <user@host> --hub-url <https-origin> --service-user <user> [--identity-file <path>] [--port <port>] [--dry-run]`); }
function runnerUpgradeUsage(detail?: string): Error { return new Error(`${detail === undefined ? "" : `${detail}\n`}Usage: fridayctl runner upgrade <user@host> --service-user <user> [--identity-file <path>] [--port <port>] [--dry-run]`); }
