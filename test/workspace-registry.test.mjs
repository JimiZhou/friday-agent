import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { randomUUID } from "node:crypto";

import {
  CodexAppServerAdapter,
  CODEX_EXECUTION_DISABLED,
  GitWorktreeManager,
  MAX_LOCAL_WORKSPACES,
  RunnerWorkspaceRegistry,
  WORKSPACE_REGISTRY_FILE,
} from "../apps/runner/dist/index.js";

const execFile = promisify(execFileCallback);

async function git(cwd, arguments_) {
  await execFile("git", ["-C", cwd, ...arguments_], { env: { PATH: process.env.PATH ?? "" } });
}

test("Runner workspace registry persists canonical roots and rejects path confusion", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-workspace-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "friday-workspace-root-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "friday-workspace-root-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  });

  const registry = new RunnerWorkspaceRegistry(stateDir);
  const first = registry.register("primary", workspaceRoot, new Date("2026-07-30T00:00:00.000Z"));
  assert.equal(first.root, await realpath(workspaceRoot));
  assert.deepEqual(registry.get("primary"), first);
  assert.equal((await stat(join(stateDir, WORKSPACE_REGISTRY_FILE))).mode & 0o777, 0o600);
  assert.deepEqual(registry.register("primary", workspaceRoot), first);
  assert.throws(() => registry.register("duplicate-root", workspaceRoot), /already registered as primary/);
  assert.throws(() => registry.register("primary", secondRoot), /already registered to a different root/);
  assert.throws(
    () => new RunnerWorkspaceRegistry(join(workspaceRoot, ".friday", "runner")).register("bad", workspaceRoot),
    /must not contain one another/,
  );
  assert.equal(registry.unregister("primary"), true);
  assert.equal(registry.unregister("primary"), false);
});

test("Runner workspace registry has a bounded local allow-list", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-workspace-limit-state-"));
  const rootsParent = await mkdtemp(join(tmpdir(), "friday-workspace-limit-roots-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(rootsParent, { recursive: true, force: true });
  });
  const registry = new RunnerWorkspaceRegistry(stateDir);
  for (let index = 0; index < MAX_LOCAL_WORKSPACES; index += 1) {
    const root = join(rootsParent, `workspace-${index}`);
    await mkdir(root);
    registry.register(`workspace-${index}`, root);
  }
  const overflowRoot = join(rootsParent, "workspace-overflow");
  await mkdir(overflowRoot);
  assert.throws(
    () => registry.register("workspace-overflow", overflowRoot),
    new RegExp(`at most ${MAX_LOCAL_WORKSPACES} workspaces`),
  );
});

test("Git worktree preparation is limited to a registered repository and Runner job state", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-worktree-state-"));
  const repository = await mkdtemp(join(tmpdir(), "friday-worktree-repo-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
  });
  await git(repository, ["init"]);
  await writeFile(join(repository, "README.md"), "safe worktree fixture\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["-c", "user.name=Friday Test", "-c", "user.email=friday@example.invalid", "commit", "-m", "fixture"]);

  const registry = new RunnerWorkspaceRegistry(stateDir);
  registry.register("fixture", repository);
  const manager = new GitWorktreeManager(stateDir, registry);
  const jobId = "8d86b61d-b60f-412d-a434-4d34ee193b31";
  const worktree = await manager.prepare("fixture", jobId);
  assert.equal(worktree.jobId, jobId);
  assert.equal(worktree.workspace.workspaceId, "fixture");
  assert.equal(worktree.runnerStateDir, await realpath(stateDir));
  assert.equal(worktree.path, await realpath(join(stateDir, "jobs", jobId, "worktree")));
  assert.match(worktree.commit, /^[0-9a-f]{40}$/);
  assert.equal(await readFile(join(worktree.path, "README.md"), "utf8"), "safe worktree fixture\n");
  await assert.rejects(() => manager.prepare("fixture", jobId), /reconcile instead of replacing it/);
});

test("Remote Agent runtime is isolated per Job and does not require a Git workspace", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-agent-runtime-state-"));
  const nodeRoot = await mkdtemp(join(tmpdir(), "friday-agent-runtime-node-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(nodeRoot, { recursive: true, force: true });
  });
  const registry = new RunnerWorkspaceRegistry(stateDir);
  registry.register("node", nodeRoot);
  const manager = new GitWorktreeManager(stateDir, registry);
  const jobId = randomUUID();
  const runtime = manager.prepareAgentRuntime("node", jobId);
  assert.equal(runtime.path, await realpath(join(stateDir, "jobs", jobId, "worktree")));
  assert.equal(runtime.commit, "node-agent-runtime-v1");
  assert.equal((await stat(runtime.path)).mode & 0o777, 0o700);
  assert.throws(() => manager.prepareAgentRuntime("node", jobId), /reconcile/);
  assert.equal(manager.prepareAgentRuntime("node", jobId, true).path, runtime.path);
});

test("Codex adapter produces a fixed no-network sandbox plan and cannot start without a backend", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-codex-plan-state-"));
  const jobId = "8d86b61d-b60f-412d-a434-4d34ee193b31";
  const worktreePath = join(stateDir, "jobs", jobId, "worktree");
  await mkdir(worktreePath, { recursive: true, mode: 0o700 });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const canonicalStateDir = await realpath(stateDir);
  const canonicalWorktreePath = await realpath(worktreePath);
  const adapter = new CodexAppServerAdapter();
  const plan = adapter.plan(
    {
      jobId,
      workspace: { workspaceId: "fixture", root: canonicalStateDir, registeredAt: new Date().toISOString() },
      runnerStateDir: canonicalStateDir,
      path: canonicalWorktreePath,
      commit: "a".repeat(40),
    },
    "Inspect the worktree without network access.",
  );
  assert.deepEqual(plan.arguments, ["app-server"]);
  assert.equal(plan.network, "none");
  assert.equal(plan.inheritEnvironment, false);
  assert.deepEqual(plan.mounts, [{ source: canonicalWorktreePath, target: "/workspace", readOnly: false }]);
  await assert.rejects(() => adapter.start(plan, undefined), new RegExp(CODEX_EXECUTION_DISABLED));
  let observed;
  assert.deepEqual(
    await adapter.start(plan, {
      kind: "container",
      start: async (received) => {
        observed = received;
        return { accepted: true };
      },
    }),
    { accepted: true },
  );
  assert.equal(observed, plan);
  await assert.rejects(
    () => adapter.start({ ...plan, network: "tailscale" }, { kind: "container", start: async () => undefined }),
    /violates the fixed sandbox policy/,
  );
  await assert.rejects(
    () => adapter.start(plan, { kind: "host", start: async () => undefined }),
    /unsupported sandbox backend/,
  );
});
