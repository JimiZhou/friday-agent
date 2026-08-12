import type { JobToolV2 } from "@friday/protocol";

import type { SandboxAdapter } from "./m3-registry.js";
import type { RunnerView } from "./state.js";

export type FleetRunnerRejection =
  | "not-enrolled"
  | "incompatible-version"
  | "offline"
  | "degraded"
  | "missing-orchestration-capability"
  | "sandbox-unavailable"
  | "workspace-unavailable"
  | "adapter-disabled";

export interface FleetSelectionRequest {
  readonly workspaceId: string;
  readonly tool: JobToolV2;
}

export interface FleetRunnerEvaluation {
  readonly runnerId: string;
  readonly displayName: string;
  readonly eligible: boolean;
  readonly load: number;
  readonly rejections: readonly FleetRunnerRejection[];
}

export interface FleetSelection {
  readonly runnerId: string;
  readonly displayName: string;
  readonly load: number;
  readonly reason: "least-loaded-compatible-runner";
}

export interface FleetSchedulingContext {
  readonly runners: readonly RunnerView[];
  readonly assignedJobs: ReadonlyMap<string, number>;
  isEnrolled(runnerId: string): boolean;
  adapterEnabled(runnerId: string, adapter: SandboxAdapter): boolean;
}

/**
 * Scheduling is deliberately deterministic and capability-based. The model
 * never supplies a hostname or SSH command: it asks for a workspace/tool and
 * the Hub resolves that request to an already enrolled outbound Runner.
 */
export function evaluateFleetRunners(
  request: FleetSelectionRequest,
  context: FleetSchedulingContext,
): readonly FleetRunnerEvaluation[] {
  const adapter = requiredAdapter(request.tool);
  return context.runners
    .map((runner) => {
      const rejections: FleetRunnerRejection[] = [];
      if (!context.isEnrolled(runner.nodeId)) rejections.push("not-enrolled");
      if (runner.version !== "0.2.1") rejections.push("incompatible-version");
      if (!runner.online) rejections.push("offline");
      else if (runner.status !== "online") rejections.push("degraded");
      if (!runner.capabilities.includes("orchestration")) rejections.push("missing-orchestration-capability");
      if (!runner.capabilities.includes("sandbox")) rejections.push("sandbox-unavailable");
      if (!runner.workspaces.includes(request.workspaceId)) rejections.push("workspace-unavailable");
      if (adapter !== undefined && !context.adapterEnabled(runner.nodeId, adapter)) rejections.push("adapter-disabled");
      return {
        runnerId: runner.nodeId,
        displayName: runner.displayName,
        eligible: rejections.length === 0,
        // Runner heartbeat and durable assignment counts overlap for running
        // jobs. max() avoids double-counting while still reserving queued jobs.
        load: Math.max(runner.activeJobs, context.assignedJobs.get(runner.nodeId) ?? 0),
        rejections,
      };
    })
    .sort((left, right) => left.runnerId.localeCompare(right.runnerId));
}

export function selectFleetRunner(
  request: FleetSelectionRequest,
  context: FleetSchedulingContext,
): FleetSelection | undefined {
  const selected = evaluateFleetRunners(request, context)
    .filter((runner) => runner.eligible)
    .sort((left, right) => left.load - right.load || left.runnerId.localeCompare(right.runnerId))[0];
  return selected === undefined
    ? undefined
    : {
        runnerId: selected.runnerId,
        displayName: selected.displayName,
        load: selected.load,
        reason: "least-loaded-compatible-runner",
      };
}

export function requiredAdapter(tool: JobToolV2): SandboxAdapter | undefined {
  if (tool === "agent") return "remote-agent";
  if (tool === "codex") return "codex-app-server";
  if (tool === "pi") return "pi-rpc";
  if (tool === "claude") return "claude-code";
  return undefined;
}
