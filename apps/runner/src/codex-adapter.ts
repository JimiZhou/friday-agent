import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { PreparedWorktree } from "./worktree-manager.js";

export const CODEX_ADAPTER_VERSION = "0.1.0";
export const CODEX_EXECUTION_DISABLED = "CODEX_EXECUTION_DISABLED";

export interface CodexLaunchPlan {
  readonly adapter: "codex-app-server";
  readonly adapterVersion: typeof CODEX_ADAPTER_VERSION;
  readonly executable: "codex";
  readonly arguments: readonly ["app-server"];
  readonly cwd: string;
  readonly prompt: string;
  readonly network: "none";
  readonly inheritEnvironment: false;
  readonly mounts: readonly [{ readonly source: string; readonly target: "/workspace"; readonly readOnly: false }];
  readonly prohibitedHostPaths: readonly ["home", "docker-socket", "ssh-agent", "other-workspaces"];
}

export interface CodexSandboxBackend {
  readonly kind: "container" | "microvm";
  start(plan: CodexLaunchPlan): Promise<unknown>;
}

/**
 * The adapter constructs an immutable, least-privilege launch plan. Friday
 * ships no implementation of CodexSandboxBackend yet, so this class cannot
 * accidentally run Codex on the Runner host.
 */
export class CodexAppServerAdapter {
  plan(worktree: PreparedWorktree, prompt: string): CodexLaunchPlan {
    const cwd = verifyPreparedWorktree(worktree);
    if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > 32_768) {
      throw new Error("Codex prompt must contain between 1 and 32768 characters");
    }
    return Object.freeze({
      adapter: "codex-app-server",
      adapterVersion: CODEX_ADAPTER_VERSION,
      executable: "codex",
      arguments: Object.freeze(["app-server"] as const),
      cwd,
      prompt,
      network: "none",
      inheritEnvironment: false,
      mounts: Object.freeze([
        Object.freeze({ source: cwd, target: "/workspace" as const, readOnly: false as const }),
      ] as const),
      prohibitedHostPaths: Object.freeze(["home", "docker-socket", "ssh-agent", "other-workspaces"] as const),
    });
  }

  async start(plan: CodexLaunchPlan, backend: CodexSandboxBackend | undefined): Promise<unknown> {
    validateLaunchPlan(plan);
    if (backend === undefined) {
      throw new Error(
        `${CODEX_EXECUTION_DISABLED}: a verified container or microVM sandbox backend is required before Codex can start`,
      );
    }
    if (
      (backend.kind !== "container" && backend.kind !== "microvm") ||
      typeof backend.start !== "function"
    ) {
      throw new Error(`${CODEX_EXECUTION_DISABLED}: unsupported sandbox backend`);
    }
    return backend.start(plan);
  }
}

function verifyPreparedWorktree(worktree: PreparedWorktree): string {
  if (
    typeof worktree !== "object" ||
    worktree === null ||
    typeof worktree.path !== "string" ||
    typeof worktree.runnerStateDir !== "string" ||
    typeof worktree.jobId !== "string"
  ) {
    throw new Error("Codex requires a prepared isolated worktree");
  }
  const canonical = realpathSync.native(worktree.path);
  const stateDir = realpathSync.native(worktree.runnerStateDir);
  const expected = join(stateDir, "jobs", worktree.jobId, "worktree");
  const relativePath = relative(stateDir, canonical);
  if (
    canonical !== worktree.path ||
    !isAbsolute(canonical) ||
    canonical !== expected ||
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Codex worktree path must be canonical and absolute");
  }
  return canonical;
}

function validateLaunchPlan(plan: CodexLaunchPlan): void {
  if (
    plan.adapter !== "codex-app-server" ||
    plan.adapterVersion !== CODEX_ADAPTER_VERSION ||
    plan.executable !== "codex" ||
    plan.arguments.length !== 1 ||
    plan.arguments[0] !== "app-server" ||
    plan.network !== "none" ||
    plan.inheritEnvironment !== false ||
    plan.mounts.length !== 1 ||
    plan.mounts[0]?.source !== plan.cwd ||
    plan.mounts[0]?.target !== "/workspace" ||
    plan.mounts[0]?.readOnly !== false
  ) {
    throw new Error("Codex launch plan violates the fixed sandbox policy");
  }
}
