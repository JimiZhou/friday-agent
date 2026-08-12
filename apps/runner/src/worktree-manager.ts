import { execFile as execFileCallback } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { join, relative, resolve } from "node:path";

import { canonicalDirectory, requireWorkspaceId, RunnerWorkspaceRegistry, type RegisteredWorkspace } from "./workspace-registry.js";

const execFile = promisify(execFileCallback);
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PreparedWorktree {
  readonly jobId: string;
  readonly workspace: RegisteredWorkspace;
  readonly runnerStateDir: string;
  readonly path: string;
  readonly commit: string;
}

/**
 * Creates a detached Git worktree below the Runner's private state directory.
 * This is an isolation preparation step, not a sandbox: callers must still
 * provide an OS/container sandbox before running a coding tool in the path.
 */
export class GitWorktreeManager {
  readonly #stateDir: string;
  readonly #registry: RunnerWorkspaceRegistry;

  constructor(stateDir: string, registry = new RunnerWorkspaceRegistry(stateDir)) {
    this.#stateDir = canonicalDirectory(stateDir, "FRIDAY_RUNNER_STATE_DIR");
    this.#registry = registry;
  }

  async prepare(workspaceId: string, jobId: string, resume = false): Promise<PreparedWorktree> {
    requireWorkspaceId(workspaceId);
    const normalizedJobId = requireJobId(jobId);
    const workspace = this.#registry.get(workspaceId);
    if (workspace === undefined) throw new Error(`Workspace ${workspaceId} is not registered on this Runner`);
    await assertGitTopLevel(workspace.root);

    const jobDirectory = safeJobDirectory(this.#stateDir, normalizedJobId);
    const worktreePath = join(jobDirectory, "worktree");
    mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(jobDirectory, "Job worktree directory");
    try {
      lstatSync(worktreePath);
      if (!resume) throw new Error(`Worktree already exists for job ${normalizedJobId}; reconcile instead of replacing it`);
      const canonicalWorktree = canonicalDirectory(worktreePath, "Prepared worktree");
      if (canonicalWorktree !== worktreePath || !isDescendant(jobDirectory, canonicalWorktree)) throw new Error("Existing worktree escaped the Runner job directory");
      await assertGitTopLevel(canonicalWorktree);
      const commit = await gitOutput(canonicalWorktree, ["rev-parse", "HEAD"]);
      return { jobId: normalizedJobId, workspace, runnerStateDir: this.#stateDir, path: canonicalWorktree, commit };
    } catch (error) {
      if (!isFileMissing(error)) throw error;
    }

    await runGit(workspace.root, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
    const canonicalWorktree = canonicalDirectory(worktreePath, "Prepared worktree");
    if (canonicalWorktree !== worktreePath || !isDescendant(jobDirectory, canonicalWorktree)) {
      throw new Error("Git created a worktree outside the Runner job directory");
    }
    const commit = await gitOutput(canonicalWorktree, ["rev-parse", "HEAD"]);
    return { jobId: normalizedJobId, workspace, runnerStateDir: this.#stateDir, path: canonicalWorktree, commit };
  }

  /**
   * A node Agent uses structured host tools and has no source checkout. Keep
   * its sandbox cwd isolated per Job without requiring the registered node
   * capability to point at a Git repository.
   */
  prepareAgentRuntime(workspaceId: string, jobId: string, resume = false): PreparedWorktree {
    requireWorkspaceId(workspaceId);
    const normalizedJobId = requireJobId(jobId);
    const workspace = this.#registry.get(workspaceId);
    if (workspace === undefined) throw new Error(`Workspace ${workspaceId} is not registered on this Runner`);
    const jobDirectory = safeJobDirectory(this.#stateDir, normalizedJobId);
    const runtimePath = join(jobDirectory, "worktree");
    mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(jobDirectory, "Job runtime directory");
    try {
      lstatSync(runtimePath);
      if (!resume) throw new Error(`Runtime already exists for job ${normalizedJobId}; reconcile instead of replacing it`);
      const canonicalRuntime = canonicalDirectory(runtimePath, "Prepared Agent runtime");
      if (canonicalRuntime !== runtimePath || !isDescendant(jobDirectory, canonicalRuntime)) throw new Error("Existing Agent runtime escaped the Runner job directory");
      assertPrivateDirectory(canonicalRuntime, "Prepared Agent runtime");
      return { jobId: normalizedJobId, workspace, runnerStateDir: this.#stateDir, path: canonicalRuntime, commit: "node-agent-runtime-v1" };
    } catch (error) {
      if (!isFileMissing(error)) throw error;
    }
    mkdirSync(runtimePath, { mode: 0o700 });
    const canonicalRuntime = canonicalDirectory(runtimePath, "Prepared Agent runtime");
    if (canonicalRuntime !== runtimePath || !isDescendant(jobDirectory, canonicalRuntime)) throw new Error("Agent runtime escaped the Runner job directory");
    return { jobId: normalizedJobId, workspace, runnerStateDir: this.#stateDir, path: canonicalRuntime, commit: "node-agent-runtime-v1" };
  }
}

function requireJobId(value: string): string {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value)) {
    throw new Error("Job id must be a UUID");
  }
  return value.toLowerCase();
}

function safeJobDirectory(stateDir: string, jobId: string): string {
  const jobsDirectory = join(stateDir, "jobs");
  mkdirSync(jobsDirectory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(jobsDirectory, "Runner jobs directory");
  const jobDirectory = resolve(jobsDirectory, jobId);
  if (!isDescendant(jobsDirectory, jobDirectory)) {
    throw new Error("Job directory escaped FRIDAY_RUNNER_STATE_DIR");
  }
  return jobDirectory;
}

async function assertGitTopLevel(workspaceRoot: string): Promise<void> {
  const reportedTopLevel = await gitOutput(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  const canonicalTopLevel = realpathSync.native(reportedTopLevel);
  if (canonicalTopLevel !== workspaceRoot) {
    throw new Error("Registered workspace root must be the Git repository top level");
  }
}

async function runGit(cwd: string, arguments_: readonly string[]): Promise<void> {
  try {
    await execFile("git", ["-C", cwd, ...arguments_], {
      cwd,
      env: { PATH: process.env.PATH ?? "" },
      maxBuffer: 1_048_576,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`Git ${arguments_.join(" ")} failed for registered workspace`, { cause: error });
  }
}

async function gitOutput(cwd: string, arguments_: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["-C", cwd, ...arguments_], {
      cwd,
      env: { PATH: process.env.PATH ?? "" },
      maxBuffer: 1_048_576,
      windowsHide: true,
    });
    const output = stdout.trim();
    if (output === "") throw new Error("Git returned an empty result");
    return output;
  } catch (error) {
    throw new Error(`Git ${arguments_.join(" ")} failed for registered workspace`, { cause: error });
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a non-symlink directory with mode 0700`);
  }
}

function isDescendant(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !path.includes("../") && !path.startsWith("/");
}

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
