#!/usr/bin/env node

import { realpathSync } from "node:fs";
import {
  FridayRunner,
  loadRunnerCapabilities,
  loadRunnerConfig,
  resolveStateDirectory,
} from "./runner.js";
import { pathToFileURL } from "node:url";
import { RunnerWorkspaceRegistry } from "./workspace-registry.js";

export {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HUB_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STATE_DIRECTORY,
  describeRunnerCapabilities,
  createTestEvidence,
  FridayRunner,
  loadRunnerCapabilities,
  loadRunnerConfig,
  resolveStateDirectory,
  MAX_REGISTERED_WORKSPACES,
  RUNNER_VERSION,
  RUNNER_DEVICE_STATE_FILE,
  type RunnerCapabilities,
  type RunnerConfig,
} from "./runner.js";
export {
  MAX_REGISTERED_WORKSPACES as MAX_LOCAL_WORKSPACES,
  RunnerWorkspaceRegistry,
  WORKSPACE_REGISTRY_FILE,
  type RegisteredWorkspace,
} from "./workspace-registry.js";
export { GitWorktreeManager, type PreparedWorktree } from "./worktree-manager.js";
export { HUB_IDENTITY_STATE_FILE, pinHubIdentity, verifyHubAssignment } from "./job-client.js";
export { requestSandboxExecution, type SandboxExecutionResult } from "./sandbox-client.js";
export {
  CODEX_ADAPTER_VERSION,
  CODEX_EXECUTION_DISABLED,
  CodexAppServerAdapter,
  type CodexLaunchPlan,
  type CodexSandboxBackend,
} from "./codex-adapter.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "workspace") {
    await workspaceCommand(args.slice(1));
    return;
  }
  const allowed = new Set(["--help", "-h", "--once", "--print-capabilities"]);
  const unknown = args.find((argument) => !allowed.has(argument));
  if (unknown !== undefined) {
    throw new Error(`Unknown argument: ${unknown}`);
  }

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      [
        "Usage: friday-runner [--once | --print-capabilities | workspace <command>]",
        "",
        "  --once                register with the Hub and exit (supports a one-time 0600 token file)",
        "  --print-capabilities  print the non-executing capability manifest and exit",
        "  workspace register <id> <path>  add a canonical local workspace allow-list entry",
        "  workspace list                  list local workspace allow-list entries",
        "  workspace remove <id>           remove a local workspace allow-list entry",
        "  --help, -h            show this help",
        "",
      ].join("\n"),
    );
    return;
  }

  if (args.includes("--once") && args.includes("--print-capabilities")) {
    throw new Error("--once and --print-capabilities cannot be combined");
  }

  if (args.includes("--print-capabilities")) {
    process.stdout.write(`${JSON.stringify(loadRunnerCapabilities(), null, 2)}\n`);
    return;
  }

  const runner = new FridayRunner(loadRunnerConfig());

  if (args.includes("--once")) {
    const response = await runner.register();
    process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
    return;
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await runner.run(controller.signal);
}

async function workspaceCommand(args: readonly string[]): Promise<void> {
  const [command, ...parameters] = args;
  const registry = new RunnerWorkspaceRegistry(resolveStateDirectory());
  switch (command) {
    case "register": {
      const [workspaceId, root] = parameters;
      if (workspaceId === undefined || root === undefined || parameters.length !== 2) {
        throw new Error("Usage: friday-runner workspace register <id> <path>");
      }
      process.stdout.write(`${JSON.stringify({ workspace: registry.register(workspaceId, root) })}\n`);
      return;
    }
    case "list":
      if (parameters.length !== 0) throw new Error("Usage: friday-runner workspace list");
      process.stdout.write(`${JSON.stringify({ workspaces: registry.list() })}\n`);
      return;
    case "remove": {
      const [workspaceId] = parameters;
      if (workspaceId === undefined || parameters.length !== 1) {
        throw new Error("Usage: friday-runner workspace remove <id>");
      }
      process.stdout.write(`${JSON.stringify({ removed: registry.unregister(workspaceId), workspaceId })}\n`);
      return;
    }
    default:
      throw new Error("Usage: friday-runner workspace <register|list|remove>");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[runner] ${message}\n`);
    process.exitCode = 1;
  });
}
