#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { bootstrapPlan, bootstrapRunner, installSandboxd, parseBootstrapArguments, parseRunnerUpgradeArguments, parseSandboxInstallArguments, runnerUpgradePlan, sandboxInstallPlan, upgradeRunner } from "./bootstrap.js";

export { bootstrapPlan, bootstrapRunner, createRunnerRelease, createSandboxdRelease, installSandboxd, parseBootstrapArguments, parseRunnerUpgradeArguments, parseSandboxInstallArguments, runnerUpgradePlan, sandboxInstallPlan, upgradeRunner } from "./bootstrap.js";
export type { BootstrapOptions, BootstrapResult, RunnerRelease, RunnerUpgradeOptions, RunnerUpgradeResult, SandboxInstallOptions, SandboxInstallResult, WorkspaceBootstrap } from "./bootstrap.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) throw new Error("Usage: fridayctl runner bootstrap ... | fridayctl runner upgrade ... | fridayctl runner sandbox install ...");
  if (args[0] === "runner" && args[1] === "sandbox" && args[2] === "install") {
    const options = parseSandboxInstallArguments(args);
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify({ dryRun: true, target: options.target, plan: sandboxInstallPlan(options) }, null, 2)}\n`);
      return;
    }
    const result = await installSandboxd(options);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return;
  }
  if (args[0] === "runner" && args[1] === "upgrade") {
    const options = parseRunnerUpgradeArguments(args);
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify({ dryRun: true, target: options.target, plan: runnerUpgradePlan(options) }, null, 2)}\n`);
      return;
    }
    const result = await upgradeRunner(options);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return;
  }
  const options = parseBootstrapArguments(args);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, target: options.target, plan: bootstrapPlan(options) }, null, 2)}\n`);
    return;
  }
  const result = await bootstrapRunner(options);
  process.stdout.write(`${JSON.stringify({ ok: result.online, ...result }, null, 2)}\n`);
  if (!result.online) process.exitCode = 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`[fridayctl] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
