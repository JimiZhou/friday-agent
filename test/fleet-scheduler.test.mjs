import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFleetRunners, selectFleetRunner } from "../apps/fridayd/dist/fleet-scheduler.js";

const now = new Date().toISOString();

function runner(runnerId, overrides = {}) {
  return {
    nodeId: runnerId,
    displayName: `runner-${runnerId.slice(-1)}`,
    version: "0.2.0",
    capabilities: ["orchestration", "sandbox"],
    workspaces: ["infra"],
    shellExecution: false,
    lastReceivedAt: now,
    lastSeenAt: now,
    lastSentAt: now,
    status: "online",
    activeJobs: 0,
    online: true,
    ...overrides,
  };
}

test("fleet scheduler chooses the least-loaded compatible Runner deterministically", () => {
  const runnerA = "018f6f57-51d4-7b48-a3a3-c5e8b194aaf1";
  const runnerB = "018f6f57-51d4-7b48-a3a3-c5e8b194aaf2";
  const context = {
    // Reversed input proves that tie-breaking does not depend on event order.
    runners: [runner(runnerB), runner(runnerA)],
    assignedJobs: new Map([[runnerA, 2], [runnerB, 1]]),
    isEnrolled: () => true,
    adapterEnabled: () => true,
  };
  assert.deepEqual(selectFleetRunner({ workspaceId: "infra", tool: "agent" }, context), {
    runnerId: runnerB,
    displayName: "runner-2",
    load: 1,
    reason: "least-loaded-compatible-runner",
  });

  const tied = { ...context, assignedJobs: new Map() };
  assert.equal(selectFleetRunner({ workspaceId: "infra", tool: "codex" }, tied)?.runnerId, runnerA);
});

test("fleet scheduler rejects offline, degraded, unpaired workspace, and disabled adapters", () => {
  const ids = [1, 2, 3, 4].map((suffix) => `018f6f57-51d4-7b48-a3a3-c5e8b194aaf${suffix}`);
  const context = {
    runners: [
      runner(ids[0], { online: false, status: "unknown" }),
      runner(ids[1], { status: "degraded" }),
      runner(ids[2], { workspaces: ["other"] }),
      runner(ids[3]),
    ],
    assignedJobs: new Map(),
    isEnrolled: () => true,
    adapterEnabled: () => false,
  };
  const evaluated = evaluateFleetRunners({ workspaceId: "infra", tool: "codex" }, context);
  assert.deepEqual(evaluated.map((entry) => entry.rejections), [
    ["offline", "adapter-disabled"],
    ["degraded", "adapter-disabled"],
    ["workspace-unavailable", "adapter-disabled"],
    ["adapter-disabled"],
  ]);
  assert.equal(selectFleetRunner({ workspaceId: "infra", tool: "codex" }, context), undefined);
});
