import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JOB_PROTOCOL_VERSION, runnerRequestSignaturePayloadV2 } from "../packages/protocol/dist/index.js";
import { JobArtifactStore } from "../apps/fridayd/dist/job-artifact-store.js";
import { SqliteJobRegistry } from "../apps/fridayd/dist/job-registry.js";
import { SelfPatchRegistry } from "../apps/fridayd/dist/m3-registry.js";
import { SelfImprovementCoordinator, SelfImprovementJobRegistry } from "../apps/fridayd/dist/self-improvement-coordinator.js";
import { loadOrCreateHubIdentity } from "../apps/fridayd/dist/hub-identity.js";
import { createTestEvidence } from "../apps/runner/dist/index.js";
import { createFridayServer } from "../apps/fridayd/dist/server.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const context = {
  category: "architecture",
  title: "Reduce recovery ambiguity",
  background: "A successful Friday code Job needs a durable and reviewable promotion path.",
  expectedBenefit: "Owner can inspect one evidence-bound candidate before any deployment.",
  riskSummary: "A bad candidate could break Hub startup if it were deployed.",
  rollbackPlan: "Keep current immutable image and discard the next candidate on failed Canary.",
  requestedActions: ["test", "dependency_install", "service_restart", "canary_deploy", "rollback"],
};

async function fixture(t, improvementId = "job-derived-change") {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-self-improvement-job-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const databasePath = join(stateDir, "friday.sqlite");
  const identity = await loadOrCreateHubIdentity(stateDir);
  const jobs = new SqliteJobRegistry(databasePath, identity);
  const improvements = new SelfPatchRegistry(databasePath);
  const bindings = new SelfImprovementJobRegistry(databasePath);
  jobs.open(); improvements.open(); bindings.open();
  t.after(() => { bindings.close(); improvements.close(); jobs.close(); });
  const artifacts = new JobArtifactStore(stateDir);
  const created = jobs.create({ idempotencyKey: randomUUID(), runnerId: randomUUID(), workspaceId: "friday-agent", tool: "codex", operation: "develop", prompt: "bounded self improvement" });
  bindings.register(created.job, improvementId, context);
  const approved = jobs.approve(created.job.jobId, "owner");
  const spec = jobs.pull(approved.runnerId);
  assert.ok(spec);
  return { stateDir, jobs, improvements, bindings, artifacts, spec, coordinator: new SelfImprovementCoordinator(bindings, jobs, artifacts, improvements) };
}

async function lowRiskFixture(t, improvementId = "brief-only-change") {
  const value = await fixture(t, improvementId);
  value.bindings.db.prepare("UPDATE self_improvement_jobs_v1 SET context_json=? WHERE job_id=?").run(JSON.stringify({
    category: "capability",
    title: "Clarify a conversation hint",
    background: "The first-use prompt is easy to miss.",
    expectedBenefit: "Owners reach the first useful conversation faster.",
    riskSummary: "The wording may still be unclear.",
    rollbackPlan: "Restore the prior wording in the next release candidate.",
    requestedActions: ["test", "rollback"],
  }), value.spec.jobId);
  return value;
}

function event(spec, sequence, partial) {
  return { protocolVersion: JOB_PROTOCOL_VERSION, eventId: randomUUID(), jobId: spec.jobId, runnerId: spec.runnerId, leaseId: spec.leaseId, sequence, sentAt: new Date().toISOString(), ...partial };
}

async function saveArtifact(artifacts, spec, name, mediaType, bytes) {
  const artifactId = randomUUID();
  return artifacts.save({ artifactId, jobId: spec.jobId, name, mediaType, sha256: sha256(bytes), sizeBytes: bytes.byteLength }, bytes);
}

test("a pre-bound successful R1 Job becomes an evidence-bound clearance request", async (t) => {
  const value = await fixture(t);
  const stdout = "96 tests passed\n";
  const stderr = "";
  const patchBytes = Buffer.from("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
  const patchArtifact = await saveArtifact(value.artifacts, value.spec, "changes.diff", "text/x-diff", patchBytes);
  const evidence = createTestEvidence(value.spec, `sha256:${"a".repeat(64)}`, stdout, stderr, patchBytes);
  const evidenceBytes = Buffer.from(JSON.stringify(evidence), "utf8");
  const evidenceArtifact = await saveArtifact(value.artifacts, value.spec, "test-evidence.json", "application/json", evidenceBytes);
  for (const item of [
    event(value.spec, 0, { type: "state", state: "RUNNING" }),
    event(value.spec, 1, { type: "output", stream: "stdout", chunk: stdout }),
    event(value.spec, 2, { type: "artifact", artifact: patchArtifact }),
    event(value.spec, 3, { type: "artifact", artifact: evidenceArtifact }),
    event(value.spec, 4, { type: "state", state: "SUCCEEDED" }),
  ]) value.jobs.acceptEvent(item);

  const promoted = await value.coordinator.observe(value.spec.jobId);
  assert.equal(promoted.binding.state, "PROMOTED");
  assert.equal(promoted.binding.patchArtifactId, patchArtifact.artifactId);
  assert.equal(promoted.binding.evidenceArtifactId, evidenceArtifact.artifactId);
  assert.equal(promoted.improvement.state, "WAIT_APPROVAL");
  assert.equal(promoted.improvement.sourceJobId, value.spec.jobId);
  assert.equal(promoted.improvement.evidenceSha256, evidenceArtifact.sha256);
  assert.equal(promoted.improvement.clearance.risk, "R2");
  assert.match(promoted.improvement.clearance.clearanceId, /^[0-9a-f-]{36}$/);
  assert.equal((await value.coordinator.observe(value.spec.jobId)).binding.state, "PROMOTED", "replay must be idempotent");
});

test("a low-risk successful self improvement is adopted automatically without clearance", async (t) => {
  const value = await lowRiskFixture(t);
  const stdout = "copy test passed\n";
  const patchBytes = Buffer.from("diff --git a/docs/voice.md b/docs/voice.md\n--- a/docs/voice.md\n+++ b/docs/voice.md\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
  const patchArtifact = await saveArtifact(value.artifacts, value.spec, "changes.diff", "text/x-diff", patchBytes);
  const evidenceBytes = Buffer.from(JSON.stringify(createTestEvidence(value.spec, `sha256:${"d".repeat(64)}`, stdout, "", patchBytes)));
  const evidenceArtifact = await saveArtifact(value.artifacts, value.spec, "test-evidence.json", "application/json", evidenceBytes);
  for (const item of [
    event(value.spec, 0, { type: "state", state: "RUNNING" }),
    event(value.spec, 1, { type: "output", stream: "stdout", chunk: stdout }),
    event(value.spec, 2, { type: "artifact", artifact: patchArtifact }),
    event(value.spec, 3, { type: "artifact", artifact: evidenceArtifact }),
    event(value.spec, 4, { type: "state", state: "SUCCEEDED" }),
  ]) value.jobs.acceptEvent(item);

  const promoted = await value.coordinator.observe(value.spec.jobId);
  assert.equal(promoted.binding.state, "PROMOTED");
  assert.equal(promoted.improvement.state, "ADOPTED");
  assert.equal(promoted.improvement.clearanceRequired, false);
  assert.equal(promoted.improvement.clearance, undefined);
});

test("model text and a successful status cannot forge mismatched test evidence", async (t) => {
  const value = await fixture(t, "forged-evidence");
  const patchBytes = Buffer.from("diff --git a/README.md b/README.md\n", "utf8");
  const patchArtifact = await saveArtifact(value.artifacts, value.spec, "changes.diff", "text/x-diff", patchBytes);
  const evidence = createTestEvidence(value.spec, `sha256:${"b".repeat(64)}`, "claimed output", "", patchBytes);
  const evidenceArtifact = await saveArtifact(value.artifacts, value.spec, "test-evidence.json", "application/json", Buffer.from(JSON.stringify(evidence)));
  for (const item of [
    event(value.spec, 0, { type: "state", state: "RUNNING" }),
    event(value.spec, 1, { type: "output", stream: "stdout", chunk: "different recorded output" }),
    event(value.spec, 2, { type: "artifact", artifact: patchArtifact }),
    event(value.spec, 3, { type: "artifact", artifact: evidenceArtifact }),
    event(value.spec, 4, { type: "state", state: "SUCCEEDED" }),
  ]) value.jobs.acceptEvent(item);

  const rejected = await value.coordinator.observe(value.spec.jobId);
  assert.equal(rejected.binding.state, "REJECTED");
  assert.equal(rejected.binding.failureCode, "EVIDENCE_MISMATCH");
  assert.equal(value.improvements.getImprovement("forged-evidence"), undefined);
});

test("ordinary successful Jobs without a prior Hub intent binding are never promoted", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-unbound-job-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const databasePath = join(stateDir, "friday.sqlite");
  const identity = await loadOrCreateHubIdentity(stateDir);
  const jobs = new SqliteJobRegistry(databasePath, identity); const improvements = new SelfPatchRegistry(databasePath); const bindings = new SelfImprovementJobRegistry(databasePath);
  jobs.open(); improvements.open(); bindings.open(); t.after(() => { bindings.close(); improvements.close(); jobs.close(); });
  const job = jobs.create({ idempotencyKey: randomUUID(), runnerId: randomUUID(), workspaceId: "friday-agent", tool: "codex", operation: "develop", prompt: "ordinary task" }).job;
  assert.equal(await new SelfImprovementCoordinator(bindings, jobs, new JobArtifactStore(stateDir), improvements).observe(job.jobId), undefined);
  assert.deepEqual(improvements.listImprovements(), []);
});

test("signed Runner HTTP events trigger promotion without granting the resulting clearance", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-self-improvement-http-"));
  const ownerToken = "self-improvement-http-owner-token";
  const friday = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576 });
  t.after(async () => { await friday.stop(); await rm(stateDir, { recursive: true, force: true }); });
  const runnerId = randomUUID(); const keys = generateKeyPairSync("ed25519"); const enrollment = friday.runnerRegistry.issueEnrollment(Date.now(), runnerId);
  friday.runnerRegistry.consumeEnrollment(runnerId, enrollment.enrollmentToken, keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const job = friday.jobRegistry.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "friday-agent", tool: "codex", operation: "develop", prompt: "candidate" }).job;
  friday.selfImprovementJobRegistry.register(job, "http-promoted-change", context);
  friday.jobRegistry.approve(job.jobId, "owner"); const spec = friday.jobRegistry.get(job.jobId).spec; assert.ok(spec);
  const address = await friday.start(); const base = `http://${address.host}:${address.port}`;
  const signedPost = async (path, value, accepted = 202) => {
    const raw = JSON.stringify(value); const signature = sign(null, Buffer.from(runnerRequestSignaturePayloadV2("POST", path, raw)), keys.privateKey).toString("base64url");
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-friday-runner-signature": signature }, body: raw });
    assert.equal(response.status, accepted); return response.json();
  };
  const patchBytes = Buffer.from("diff --git a/README.md b/README.md\n", "utf8");
  const evidenceBytes = Buffer.from(JSON.stringify(createTestEvidence(spec, `sha256:${"c".repeat(64)}`, "tests ok", "", patchBytes)));
  const upload = async (name, mediaType, bytes) => {
    const artifactId = randomUUID(); const path = `/v2/runners/${runnerId}/jobs/${job.jobId}/artifacts/${artifactId}`;
    return (await signedPost(path, { protocolVersion: JOB_PROTOCOL_VERSION, runnerId, jobId: job.jobId, leaseId: spec.leaseId, artifactId, name, mediaType, sha256: sha256(bytes), sizeBytes: bytes.byteLength, contentBase64: bytes.toString("base64") }, 201)).artifact;
  };
  const patchArtifact = await upload("changes.diff", "text/x-diff", patchBytes);
  const evidenceArtifact = await upload("test-evidence.json", "application/json", evidenceBytes);
  const eventPath = `/v2/runners/${runnerId}/jobs/${job.jobId}/events`;
  const events = [
    event(spec, 0, { type: "state", state: "RUNNING" }),
    event(spec, 1, { type: "output", stream: "stdout", chunk: "tests ok" }),
    event(spec, 2, { type: "artifact", artifact: patchArtifact }),
    event(spec, 3, { type: "artifact", artifact: evidenceArtifact }),
    event(spec, 4, { type: "state", state: "SUCCEEDED" }),
  ];
  let terminal;
  for (const value of events) terminal = await signedPost(eventPath, value);
  assert.equal(terminal.selfImprovement.binding.state, "PROMOTED");
  assert.equal(terminal.selfImprovement.improvement.state, "WAIT_APPROVAL");
  assert.equal(terminal.selfImprovement.improvement.clearance.grantedAt, undefined);
  const listed = await fetch(`${base}/v4/self-improvements`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).improvements[0].sourceJobId, job.jobId);
});
