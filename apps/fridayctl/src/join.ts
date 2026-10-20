import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRunnerRelease, parseBootstrapArguments, readEnrollmentFile, type BootstrapOptions } from "./bootstrap.js";

const execFile = promisify(execFileCallback);
export type JoinOptions = Pick<BootstrapOptions, "hubUrl" | "runnerName" | "serviceUser" | "repoRoot" | "workspaces" | "dryRun"> & { readonly enrollmentFile: string };

export function parseJoinArguments(args: readonly string[]): JoinOptions {
  if (args[0] !== "runner" || args[1] !== "join") throw new Error("Usage: fridayctl runner join --hub-url URL --runner-name NAME --service-user USER --enrollment-file FILE");
  const allowed = new Set(["--hub-url", "--runner-name", "--service-user", "--repo-root", "--workspace", "--enrollment-file"]);
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === "--dry-run") continue;
    if (!allowed.has(args[index] as string)) throw new Error(`Unsupported join option: ${args[index]}`);
    index += 1;
    if (args[index] === undefined || args[index]?.startsWith("--")) throw new Error("Join option requires a value");
  }
  const parsed = parseBootstrapArguments(["runner", "bootstrap", "localhost", ...args.slice(2), "--dry-run"], {});
  if (parsed.enrollmentFile === undefined) throw new Error("runner join requires --enrollment-file; no Owner token is needed on a child node");
  return { hubUrl: parsed.hubUrl, runnerName: parsed.runnerName, serviceUser: parsed.serviceUser, repoRoot: parsed.repoRoot, workspaces: parsed.workspaces, enrollmentFile: parsed.enrollmentFile, dryRun: args.includes("--dry-run") };
}

export function joinPlan(options: JoinOptions): readonly string[] {
  return [
    "Run on the child node (Linux, Node >=22.19.0, systemd, existing service user, root or passwordless sudo)",
    `Read the current user's private 0600 enrollment file: ${options.enrollmentFile}`,
    "Build a Runner-only release from this compiled repository",
    `Enroll outbound to ${options.hubUrl.origin}; no SSH connection and no Owner token on this node`,
    `Install and start friday-runner@${options.serviceUser}.service; remove consumed enrollment file after successful installation`,
  ];
}

export async function joinRunner(options: JoinOptions): Promise<{ runnerId: string; releaseId: string; installed: true }> {
  if (options.dryRun) throw new Error("joinRunner cannot mutate a dry-run plan");
  if (process.platform !== "linux") throw new Error("runner join requires Linux and systemd");
  const enrollment = await readEnrollmentFile(options.enrollmentFile);
  const privileged = process.getuid?.() === 0;
  if (!privileged) await execFile("sudo", ["-n", "true"], { timeout: 10_000 });
  try {
    await execFile(privileged ? "test" : "sudo", privileged ? ["!", "-e", "/var/lib/friday-runner/runner-device.json"] : ["-n", "test", "!", "-e", "/var/lib/friday-runner/runner-device.json"], { timeout: 10_000 });
  } catch {
    throw new Error("A Runner identity already exists at /var/lib/friday-runner/runner-device.json, or its state could not be checked; refusing to overwrite an existing enrollment.");
  }
  const directory = await mkdtemp("/tmp/friday-bootstrap-");
  const shellEnv = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'\n`).join("");
  try {
    const release = await createRunnerRelease(options.repoRoot, directory);
    const bootstrap = join(directory, "bootstrap.env"), service = join(directory, "runner.service.env"), workspaces = join(directory, "runner.workspaces"), installer = join(directory, "installer.sh");
    await writeFile(bootstrap, shellEnv({ FRIDAY_HUB_URL: options.hubUrl.origin, FRIDAY_RUNNER_ID: enrollment.runnerId, FRIDAY_ENROLLMENT_TOKEN: enrollment.enrollmentToken, FRIDAY_RUNNER_NAME: options.runnerName, FRIDAY_SERVICE_USER: options.serviceUser, FRIDAY_RELEASE_ID: release.releaseId, FRIDAY_RELEASE_SHA256: release.sha256 }), { mode: 0o600 });
    await writeFile(service, shellEnv({ FRIDAY_HUB_URL: options.hubUrl.origin, FRIDAY_RUNNER_NAME: options.runnerName, FRIDAY_RUNNER_STATE_DIR: "/var/lib/friday-runner", FRIDAY_HEARTBEAT_INTERVAL_MS: "15000", FRIDAY_REQUEST_TIMEOUT_MS: "10000" }), { mode: 0o600 });
    await writeFile(workspaces, options.workspaces.map((workspace) => `${workspace.workspaceId}\t${workspace.path}\n`).join(""), { mode: 0o600 });
    await cp(join(options.repoRoot, "deploy/runner/install-managed-runner.sh"), installer);
    const argumentsList = [installer, release.archive, bootstrap, service, workspaces];
    try { await execFile(privileged ? "sh" : "sudo", privileged ? argumentsList : ["-n", "sh", ...argumentsList], { timeout: 120_000, maxBuffer: 1024 * 1024 }); }
    catch { throw new Error("Local Runner installation failed; check the node prerequisites and friday-runner service journal. The enrollment handoff was retained."); }
    await unlink(options.enrollmentFile);
    return { runnerId: enrollment.runnerId, releaseId: release.releaseId, installed: true };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
