import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFridayServer } from "../apps/fridayd/dist/server.js";

const ownerToken = "fleet-server-owner-token";

async function request(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${ownerToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("Hub auto target resolves to an online enrolled sandbox Runner and remains explicit in JobSpec", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-fleet-server-"));
  const friday = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576 });
  t.after(async () => { await friday.stop(); await rm(stateDir, { recursive: true, force: true }); });
  const runnerId = randomUUID();
  const enrollment = friday.runnerRegistry.issueEnrollment(Date.now(), runnerId);
  const keys = generateKeyPairSync("ed25519");
  assert.deepEqual(friday.runnerRegistry.consumeEnrollment(
    runnerId,
    enrollment.enrollmentToken,
    keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  ), { outcome: "enrolled", duplicate: false });
  const receivedAt = new Date().toISOString();
  const event = await friday.store.append("runner.registered", {
    receivedAt,
    envelope: {
      protocolVersion: "1",
      envelopeId: randomUUID(),
      kind: "register",
      runnerId,
      sentAt: receivedAt,
      payload: {
        displayName: "fleet-node",
        version: "0.2.1",
        capabilities: ["orchestration", "sandbox"],
        workspaces: ["infra", "friday-agent"],
        shellExecution: false,
      },
    },
  });
  friday.state.apply(event, { live: true });
  const heartbeat = await friday.store.append("runner.heartbeat", {
    receivedAt,
    envelope: {
      protocolVersion: "1",
      envelopeId: randomUUID(),
      kind: "heartbeat",
      runnerId,
      sentAt: receivedAt,
      payload: { status: "online", activeJobs: 0 },
    },
  });
  friday.state.apply(heartbeat, { live: true });
  friday.adapterRegistry.register({
    runnerId,
    adapter: "remote-agent",
    image: "friday-codex:0.145.0",
    imageId: `sha256:${"c".repeat(64)}`,
  });
  friday.adapterRegistry.enable(runnerId, "remote-agent");
  friday.adapterRegistry.register({ runnerId, adapter: "codex-app-server", image: "friday-codex:0.145.0", imageId: `sha256:${"c".repeat(64)}` });
  friday.adapterRegistry.enable(runnerId, "codex-app-server");
  const address = await friday.start();
  const base = `http://${address.host}:${address.port}`;

  const fleet = await request(base, "/v2/fleet?workspaceId=infra&tool=agent");
  assert.equal(fleet.response.status, 200);
  assert.deepEqual(fleet.body.runners, [{ runnerId, displayName: "fleet-node", eligible: true, load: 0, rejections: [] }]);

  const autoRequest = {
    idempotencyKey: randomUUID(),
    runnerSelector: "auto",
    workspaceId: "infra",
    tool: "agent",
    operation: "diagnose",
    prompt: "Inspect the registered host",
  };
  const created = await request(base, "/v2/jobs", autoRequest);
  assert.equal(created.response.status, 202);
  assert.equal(created.body.scheduling.mode, "auto");
  assert.equal(created.body.scheduling.runnerId, runnerId);
  assert.equal(created.body.job.runnerId, runnerId);
  assert.equal(created.body.job.spec.runnerId, runnerId);
  const replay = await request(base, "/v2/jobs", autoRequest);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.scheduling.runnerId, runnerId);
  const conflict = await request(base, "/v2/jobs", { ...autoRequest, prompt: "Different work" });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "JOB_IDEMPOTENCY_CONFLICT");

  const improvementRequest = {
    idempotencyKey: randomUUID(), runnerSelector: "auto", improvementId: "upgrade-recovery-path", workspaceId: "friday-agent", tool: "codex",
    prompt: "Improve the restart recovery path and run the relevant tests.", category: "architecture", title: "Improve restart recovery",
    background: "Interrupted work needs a smaller and auditable recovery path.", expectedBenefit: "Fewer ambiguous jobs after a restart.",
    riskSummary: "The change could affect Hub recovery.", rollbackPlan: "Discard next and retain the current immutable release.",
    requestedActions: ["test", "service_restart", "canary_deploy", "rollback"],
  };
  const improvementJob = await request(base, "/v4/self-improvement-jobs", improvementRequest);
  assert.equal(improvementJob.response.status, 202);
  assert.equal(improvementJob.body.job.status, "DISPATCHED");
  assert.equal(improvementJob.body.job.risk, "R1");
  assert.equal(improvementJob.body.improvementJob.state, "PENDING");
  assert.equal(improvementJob.body.improvementJob.branch, "friday/self/upgrade-recovery-path");
  const improvementReplay = await request(base, "/v4/self-improvement-jobs", improvementRequest);
  assert.equal(improvementReplay.response.status, 200);
  assert.equal(improvementReplay.body.duplicate, true);
  assert.equal(improvementReplay.body.job.jobId, improvementJob.body.job.jobId);
  const forbiddenTarget = await request(base, "/v4/self-improvement-jobs", { ...improvementRequest, idempotencyKey: randomUUID(), runnerSelector: undefined, runnerId });
  assert.equal(forbiddenTarget.response.status, 400);
  const wrongWorkspace = await request(base, "/v4/self-improvement-jobs", { ...improvementRequest, idempotencyKey: randomUUID(), improvementId: "wrong-private-workspace", workspaceId: "infra" });
  assert.equal(wrongWorkspace.response.status, 409);
  assert.equal(wrongWorkspace.body.error.code, "SELF_IMPROVEMENT_WORKSPACE_REJECTED");
  assert.match(friday.jobRegistry.get(improvementJob.body.job.jobId).spec.prompt, /FRIDAY_SELF_IMPROVEMENT_JOB_V1/);

  const unavailable = await request(base, "/v2/jobs", {
    idempotencyKey: randomUUID(),
    runnerSelector: "auto",
    workspaceId: "infra",
    tool: "pi",
    operation: "diagnose",
    prompt: "Use Pi",
  });
  assert.equal(unavailable.response.status, 409);
  assert.equal(unavailable.body.error.code, "NO_COMPATIBLE_RUNNER");
});
