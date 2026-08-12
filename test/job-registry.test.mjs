import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJsonV2, jobManifestProjectionV2 } from "../packages/protocol/dist/index.js";
import { loadOrCreateHubIdentity } from "../apps/fridayd/dist/hub-identity.js";
import { SqliteJobRegistry } from "../apps/fridayd/dist/job-registry.js";
import { pinHubIdentity, verifyHubAssignment } from "../apps/runner/dist/job-client.js";

test("M1 Job registry requires approval, signs a lease, and rejects sequence gaps", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-jobs-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const identity = await loadOrCreateHubIdentity(stateDir);
  const registry = new SqliteJobRegistry(join(stateDir, "friday.sqlite"), identity);
  registry.open();
  t.after(() => registry.close());

  const input = {
    idempotencyKey: randomUUID(),
    runnerId: randomUUID(),
    workspaceId: "workspace",
    tool: "codex",
    operation: "develop",
    prompt: "Change only the requested test fixture",
  };
  const created = registry.create(input);
  assert.equal(created.duplicate, false);
  assert.equal(created.job.status, "WAIT_APPROVAL");
  assert.equal(registry.create(input).duplicate, true);
  assert.deepEqual(registry.resolveIdempotency(input, input.runnerId).outcome, "duplicate");
  assert.equal(registry.resolveIdempotency({ ...input, prompt: "changed" }, input.runnerId).outcome, "conflict");
  assert.throws(() => registry.create({ ...input, prompt: "changed" }), /idempotencyKey/);
  assert.equal(registry.pull(input.runnerId), undefined);

  const approved = registry.approve(created.job.jobId, "owner");
  assert.equal(approved.status, "DISPATCHED");
  const spec = registry.pull(input.runnerId);
  assert.ok(spec);
  assert.equal(spec.network.mode, "none");
  assert.equal(spec.network.allowedHosts.length, 0);
  assert.equal(
    verify(null, Buffer.from(canonicalJsonV2(jobManifestProjectionV2(spec)), "utf8"), identity.publicKeyPem, Buffer.from(spec.hubSignature, "base64url")),
    true,
  );
  const runnerState = join(stateDir, "runner");
  await mkdir(runnerState, { mode: 0o700 });
  const pin = pinHubIdentity(runnerState, identity.publicKeyPem);
  verifyHubAssignment(spec, pin.publicKeyPem);
  assert.throws(() => verifyHubAssignment({ ...spec, prompt: "tampered" }, pin.publicKeyPem), /digest/);

  const running = {
    protocolVersion: "2",
    eventId: randomUUID(),
    jobId: spec.jobId,
    runnerId: spec.runnerId,
    leaseId: spec.leaseId,
    sequence: 0,
    sentAt: new Date().toISOString(),
    type: "state",
    state: "RUNNING",
  };
  assert.equal(registry.acceptEvent(running).job.status, "RUNNING");
  assert.equal(registry.acceptEvent(running).duplicate, true);
  assert.throws(() => registry.acceptEvent({ ...running, eventId: randomUUID(), sequence: 2 }), /gap/);
  assert.equal(registry.reconcile(spec.jobId, spec.runnerId, spec.leaseId).status, "RECONCILING");
});

test("legacy diagnostic Jobs remain readable but are never dispatched", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-legacy-diagnostic-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const databasePath = join(stateDir, "friday.sqlite");
  const identity = generateKeyPairSync("ed25519");
  const hubIdentity = { publicKeyPem: identity.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: identity.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const registry = new SqliteJobRegistry(databasePath, hubIdentity);
  registry.open();
  const runnerId = randomUUID();
  const jobId = randomUUID();
  const database = new DatabaseSync(databasePath);
  database.prepare("INSERT INTO jobs_v2 VALUES (?, ?, ?, ?, 'diagnostic', 'diagnose', ?, 'R0', ?, 'SUCCEEDED', NULL, -1, ?, ?)")
    .run(jobId, randomUUID(), runnerId, "infra", "historic fixture", JSON.stringify({ timeoutSeconds: 900, maxOutputBytes: 1048576, cpuMillis: 1000, memoryMiB: 1024 }), new Date().toISOString(), new Date().toISOString());
  database.close();
  assert.equal(registry.get(jobId).tool, "diagnostic");
  assert.equal(registry.list().some((job) => job.jobId === jobId), true);
  assert.equal(registry.pull(runnerId), undefined);
  registry.close();
});

test("a running Remote Agent can be redispatched from a durable checkpoint", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-agent-recovery-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const registry = new SqliteJobRegistry(join(stateDir, "friday.sqlite"), await loadOrCreateHubIdentity(stateDir));
  registry.open(); t.after(() => registry.close());
  const runnerId = randomUUID();
  const job = registry.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "node", tool: "agent", operation: "diagnose", prompt: "inspect" }).job;
  const spec = registry.pull(runnerId);
  registry.acceptEvent({ protocolVersion: "2", eventId: randomUUID(), jobId: job.jobId, runnerId, leaseId: spec.leaseId, sequence: 0, sentAt: new Date().toISOString(), type: "state", state: "RUNNING" });
  const recovered = registry.recoverAgent(job.jobId, runnerId, spec.leaseId);
  assert.equal(recovered.disposition, "READY");
  assert.equal(recovered.job.status, "DISPATCHED");
  assert.equal(recovered.job.lastSequence, 0);
  assert.equal(registry.pull(runnerId).leaseId, spec.leaseId);
});
