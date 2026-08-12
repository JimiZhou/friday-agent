import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteJobRegistry } from "../apps/fridayd/dist/job-registry.js";
import { NodeToolPolicy, nodeToolRisk } from "../apps/fridayd/dist/node-tool-policy.js";
import { invokeAuthorizedNodeTool, invokeNodeTool, verifyNodeToolAuthorization } from "../apps/runner/dist/node-tool-client.js";
import { parseRemoteAgentOutput } from "../apps/runner/dist/remote-agent-output.js";
import { JOB_PROTOCOL_VERSION } from "../packages/protocol/dist/index.js";

test("Remote Agent output proposes only structured actions without risk or approval fields", () => {
  const callId = randomUUID();
  const action = parseRemoteAgentOutput(JSON.stringify({ type: "tool_call", callId, name: "system.snapshot", arguments: {}, reason: "Inspect current capacity" }));
  assert.equal(action.name, "system.snapshot");
  for (const forbidden of ["risk", "approval", "runnerId", "command"]) {
    assert.throws(() => parseRemoteAgentOutput(JSON.stringify({ type: "tool_call", callId: randomUUID(), name: "system.snapshot", arguments: {}, reason: "inspect", [forbidden]: "R0" })), /invalid/);
  }
  assert.deepEqual(parseRemoteAgentOutput(JSON.stringify({ type: "finish", summary: "Observed evidence supports the result." })), { type: "finish", summary: "Observed evidence supports the result." });
});

test("system snapshot follows the standard os-release symlink without widening file access", async () => {
  if (process.platform !== "linux") return;
  const result = await invokeNodeTool({ name: "system.snapshot", arguments: {} });
  assert.equal(typeof result.observedAt, "string");
  assert.equal(result.osRelease.exitCode ?? 0, 0);
});

test("Hub derives per-call risk, signs exact R0 authority, and pauses higher-risk calls", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "friday-node-tool-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "friday.sqlite");
  const key = generateKeyPairSync("ed25519");
  const identity = { publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const jobs = new SqliteJobRegistry(database, identity); jobs.open(); t.after(() => jobs.close());
  const policy = new NodeToolPolicy(database, identity, jobs); policy.open(); t.after(() => policy.close());
  const runnerId = randomUUID();
  const job = jobs.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "infra", tool: "agent", operation: "diagnose", prompt: "Inspect node" }).job;
  const spec = jobs.pull(runnerId); assert.ok(spec);
  jobs.acceptEvent({ protocolVersion: JOB_PROTOCOL_VERSION, eventId: randomUUID(), jobId: job.jobId, runnerId, leaseId: spec.leaseId, sequence: 0, sentAt: new Date().toISOString(), type: "state", state: "RUNNING" });
  const snapshot = { protocolVersion: JOB_PROTOCOL_VERSION, callId: randomUUID(), jobId: job.jobId, runnerId, leaseId: spec.leaseId, name: "system.snapshot", arguments: {}, reason: "Read host capacity", requestedAt: new Date().toISOString() };
  const r0 = policy.evaluate(snapshot);
  assert.equal(r0.risk, "R0"); assert.equal(r0.status, "APPROVED"); assert.equal(r0.authorization.approvedBy, "policy");
  verifyNodeToolAuthorization(snapshot, r0.authorization, identity.publicKeyPem);
  assert.throws(() => verifyNodeToolAuthorization({ ...snapshot, arguments: { altered: true } }, r0.authorization, identity.publicKeyPem), /exact live call/);
  if (process.platform === "linux") {
    const result = await invokeAuthorizedNodeTool(snapshot, r0.authorization, identity.publicKeyPem);
    assert.equal(typeof result.observedAt, "string");
  }

  const restart = { ...snapshot, callId: randomUUID(), name: "service.restart", arguments: { unit: "friday-runner" }, reason: "Restart failed service", requestedAt: new Date().toISOString() };
  const pending = policy.evaluate(restart);
  assert.equal(pending.risk, "R2"); assert.equal(pending.status, "WAIT_APPROVAL"); assert.equal(jobs.get(job.jobId).status, "WAIT_APPROVAL");
  assert.equal(nodeToolRisk("file.delete"), "R3");
  const approved = policy.approve(restart.callId, "owner");
  assert.equal(approved.authorization.approvedBy, "owner"); assert.equal(jobs.get(job.jobId).status, "DISPATCHED");
  await assert.rejects(() => invokeAuthorizedNodeTool(restart, approved.authorization, identity.publicKeyPem), /not enabled/);
});

test("an exact pending tool call can resume after the proposal freshness window", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "friday-node-tool-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "friday.sqlite");
  const key = generateKeyPairSync("ed25519");
  const identity = { publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const jobs = new SqliteJobRegistry(database, identity); jobs.open(); t.after(() => jobs.close());
  const policy = new NodeToolPolicy(database, identity, jobs); policy.open(); t.after(() => policy.close());
  const runnerId = randomUUID();
  const startedAt = new Date("2026-08-12T00:00:00.000Z");
  const job = jobs.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "node", tool: "agent", operation: "diagnose", prompt: "inspect" }, startedAt).job;
  const spec = jobs.pull(runnerId, startedAt);
  jobs.acceptEvent({ protocolVersion: JOB_PROTOCOL_VERSION, eventId: randomUUID(), jobId: job.jobId, runnerId, leaseId: spec.leaseId, sequence: 0, sentAt: startedAt.toISOString(), type: "state", state: "RUNNING" }, startedAt);
  const call = { protocolVersion: JOB_PROTOCOL_VERSION, callId: randomUUID(), jobId: job.jobId, runnerId, leaseId: spec.leaseId, name: "service.restart", arguments: { unit: "demo.service" }, reason: "Restart only after explicit clearance", requestedAt: startedAt.toISOString() };
  const initial = policy.evaluate(call, startedAt);
  const resumed = policy.evaluate(call, new Date(startedAt.getTime() + 6 * 60_000));
  assert.equal(initial.status, "WAIT_APPROVAL");
  assert.equal(resumed.status, "WAIT_APPROVAL");
  assert.equal(jobs.get(job.jobId).status, "WAIT_APPROVAL");
});

test("expired clearance never executes an old call and redispatches the Agent to re-plan", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "friday-node-tool-expiry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "friday.sqlite");
  const key = generateKeyPairSync("ed25519");
  const identity = { publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const jobs = new SqliteJobRegistry(database, identity); jobs.open(); t.after(() => jobs.close());
  const policy = new NodeToolPolicy(database, identity, jobs); policy.open(); t.after(() => policy.close());
  const runnerId = randomUUID();
  const job = jobs.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "node", tool: "agent", operation: "diagnose", prompt: "Recover service" }).job;
  const spec = jobs.pull(runnerId);
  jobs.acceptEvent({ protocolVersion: JOB_PROTOCOL_VERSION, eventId: randomUUID(), jobId: job.jobId, runnerId, leaseId: spec.leaseId, sequence: 0, sentAt: new Date().toISOString(), type: "state", state: "RUNNING" });
  const call = { protocolVersion: JOB_PROTOCOL_VERSION, callId: randomUUID(), jobId: job.jobId, runnerId, leaseId: spec.leaseId, name: "service.restart", arguments: { unit: "demo.service" }, reason: "Restart only after clearance", requestedAt: new Date().toISOString() };
  assert.equal(policy.evaluate(call).status, "WAIT_APPROVAL");
  const afterLease = new Date(Date.parse(spec.leaseExpiresAt) + 1);
  const decision = policy.approve(call.callId, "owner", afterLease);
  assert.equal(decision.status, "DENIED");
  assert.match(decision.background, /not executed/);
  const redispatched = jobs.get(job.jobId);
  assert.equal(redispatched.status, "DISPATCHED");
  assert.notEqual(redispatched.spec.leaseId, spec.leaseId);
  assert.equal(policy.decision(call.callId, afterLease).status, "DENIED");
});

test("Hub restart repairs the pending-call crash window without dispatching the Job", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "friday-node-tool-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "friday.sqlite");
  const key = generateKeyPairSync("ed25519");
  const identity = { publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const jobs = new SqliteJobRegistry(databasePath, identity); jobs.open(); t.after(() => jobs.close());
  const runnerId = randomUUID();
  const job = jobs.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "node", tool: "agent", operation: "diagnose", prompt: "inspect" }).job;
  const spec = jobs.pull(runnerId);
  jobs.acceptEvent({ protocolVersion: JOB_PROTOCOL_VERSION, eventId: randomUUID(), jobId: job.jobId, runnerId, leaseId: spec.leaseId, sequence: 0, sentAt: new Date().toISOString(), type: "state", state: "RUNNING" });
  const policy = new NodeToolPolicy(databasePath, identity, jobs); policy.open();
  const call = { protocolVersion: JOB_PROTOCOL_VERSION, callId: randomUUID(), jobId: job.jobId, runnerId, leaseId: spec.leaseId, name: "service.restart", arguments: { unit: "demo.service" }, reason: "Restart after explicit clearance", requestedAt: new Date().toISOString() };
  assert.equal(policy.evaluate(call).status, "WAIT_APPROVAL");
  policy.close();

  // Simulate interruption after the pending row committed but before the Job
  // hold committed on the other SQLite connection.
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE jobs_v2 SET status='RUNNING' WHERE job_id=?").run(job.jobId);
  database.close();
  const reopened = new NodeToolPolicy(databasePath, identity, jobs); reopened.open(); t.after(() => reopened.close());
  assert.equal(jobs.get(job.jobId).status, "WAIT_APPROVAL");
  assert.equal(reopened.decision(call.callId).status, "WAIT_APPROVAL");
  assert.equal(jobs.pull(runnerId), undefined);
});

test("node file tools deny process environments and credential paths before reading", async () => {
  const base = { protocolVersion: JOB_PROTOCOL_VERSION, callId: randomUUID(), jobId: randomUUID(), runnerId: randomUUID(), leaseId: randomUUID(), arguments: { path: "/proc/self/environ", maxBytes: 4096 }, reason: "unsafe probe", requestedAt: new Date().toISOString() };
  await assert.rejects(() => invokeNodeTool({ ...base, name: "file.read" }), /denied/);
  if (process.platform === "linux") await assert.rejects(() => invokeNodeTool({ ...base, callId: randomUUID(), name: "file.read", arguments: { path: "/etc/shadow", maxBytes: 4096 } }), /denied/);
});
