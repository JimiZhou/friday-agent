#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { applyPreparedSelfPatch, prepareSelfPatchWorktree, runSelfPatchTests } from "./self-patch-worktree.js";

async function main(args: readonly string[]): Promise<void> {
  const [command, repository, stateDirectory, id, branch, patchFile] = args;
  if ((command !== "prepare" && command !== "apply-test") || repository === undefined || stateDirectory === undefined || id === undefined || branch === undefined || patchFile === undefined || args.length !== 6) {
    throw new Error("Usage: friday-self-patch <prepare|apply-test> <repository-root> <state-directory> <id> <friday/self/branch> <patch-file>");
  }
  const prepared = await prepareSelfPatchWorktree({ repository, stateDirectory, id, branch, patch: await readFile(patchFile, "utf8") });
  if (command === "apply-test") {
    await applyPreparedSelfPatch(prepared);
    const evidence = await runSelfPatchTests(prepared.worktree);
    process.stdout.write(`${JSON.stringify({ prepared, evidence })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ prepared })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`[friday-self-patch] ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
