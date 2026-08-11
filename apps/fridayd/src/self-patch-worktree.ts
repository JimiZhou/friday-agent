import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface SelfPatchWorktreeRequest {
  readonly repository: string;
  readonly stateDirectory: string;
  readonly id: string;
  readonly branch: string;
  readonly patch: string;
}

export interface PreparedSelfPatch {
  readonly worktree: string;
  readonly patchPath: string;
  readonly patchSha256: string;
}

/**
 * This is intentionally an operator-side primitive, never a Hub route. It
 * creates an isolated Friday-owned Git branch/worktree and validates the supplied patch;
 * it never checks out, resets, commits, pushes, or alters the live main tree.
 */
export async function prepareSelfPatchWorktree(request: SelfPatchWorktreeRequest): Promise<PreparedSelfPatch> {
  validate(request);
  const repository = await canonicalGitRoot(request.repository);
  const stateDirectory = resolve(request.stateDirectory);
  if (!isAbsolute(stateDirectory) || isSafeDescendant(stateDirectory, repository)) {
    throw new Error("Self patch state directory must be an absolute path outside the repository");
  }
  const worktree = join(stateDirectory, "self-patches", request.id, "worktree");
  const patchPath = join(stateDirectory, "self-patches", request.id, "patch.diff");
  await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
  try { await lstat(worktree); throw new Error("Self patch worktree already exists; reconcile or remove it explicitly"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await execGit(repository, ["worktree", "add", "-b", request.branch, worktree, "HEAD"]);
  try {
    await writeFile(patchPath, request.patch, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await execGit(worktree, ["apply", "--check", patchPath]);
  } catch (error) {
    // Leave the isolated worktree intact for forensic review. It is never
    // automatically removed or reused under a different patch.
    throw error;
  }
  return { worktree, patchPath, patchSha256: digest(request.patch) };
}

/** Applies a patch only inside the worktree returned by prepareSelfPatchWorktree. */
export async function applyPreparedSelfPatch(prepared: PreparedSelfPatch): Promise<void> {
  const worktree = await realpath(prepared.worktree);
  const patchPath = await realpath(prepared.patchPath);
  if (!isSafeDescendant(dirname(dirname(worktree)), worktree) || !isSafeDescendant(dirname(dirname(patchPath)), patchPath)) throw new Error("Self patch paths are invalid");
  const patch = await import("node:fs/promises").then(({ readFile }) => readFile(patchPath, "utf8"));
  if (digest(patch) !== prepared.patchSha256) throw new Error("Self patch evidence does not match the prepared patch");
  await execGit(worktree, ["apply", "--index", patchPath]);
}

/** Fixed verification command; callers cannot inject arbitrary shell text. */
export async function runSelfPatchTests(worktree: string, timeoutMs = 15 * 60_000): Promise<{ readonly stdout: string; readonly stderr: string; readonly evidenceSha256: string }> {
  const canonical = await realpath(worktree);
  const { stdout, stderr } = await execFile("npm", ["test"], { cwd: canonical, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { PATH: process.env.PATH ?? "", npm_config_ignore_scripts: "true" } });
  return { stdout, stderr, evidenceSha256: digest(`${stdout}\n${stderr}`) };
}

async function canonicalGitRoot(value: string): Promise<string> {
  const root = await realpath(value);
  const { stdout } = await execGit(root, ["rev-parse", "--show-toplevel"]);
  const top = await realpath(stdout.trim());
  if (top !== root) throw new Error("Self patch repository must be its Git top-level directory");
  return root;
}

async function execGit(cwd: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return execFile("git", [...args], { cwd, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" } });
}

function validate(request: SelfPatchWorktreeRequest): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(request.id) || !/^friday\/self\/[a-z0-9][a-z0-9-]{0,79}$/.test(request.branch) || request.branch === "main" || !request.patch.startsWith("diff --git ") || request.patch.length > 2 * 1024 * 1024) throw new Error("Self patch request is invalid");
}
function isSafeDescendant(parent: string, child: string): boolean { const value = relative(parent, child); return value !== "" && !value.startsWith("..") && !isAbsolute(value); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
