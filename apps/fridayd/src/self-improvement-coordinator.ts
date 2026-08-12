import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";

import {
  SELF_IMPROVEMENT_TEST_EVIDENCE_VERSION,
  type RunnerArtifactV1,
  type SelfImprovementTestEvidenceV1,
} from "@friday/protocol";
import { JobArtifactStore } from "./job-artifact-store.js";
import { SqliteJobRegistry, type JobViewV2 } from "./job-registry.js";
import {
  SelfPatchRegistry,
  validateSelfImprovementContext,
  type SelfImprovementContext,
  type SelfImprovementView,
} from "./m3-registry.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

export type SelfImprovementJobState = "PENDING" | "PROMOTED" | "REJECTED";

export interface SelfImprovementJobView {
  readonly jobId: string;
  readonly improvementId: string;
  readonly branch: string;
  readonly context: SelfImprovementContext;
  readonly state: SelfImprovementJobState;
  readonly patchArtifactId?: string;
  readonly evidenceArtifactId?: string;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Durable intent binding. Merely naming an artifact "changes.diff" never
 * makes it a Friday self-improvement; the Owner-created Hub binding must
 * predate execution and point at the exact R1 Job.
 */
export class SelfImprovementJobRegistry {
  #db: DatabaseSync | undefined;
  constructor(readonly path: string) {}

  open(): void {
    this.#db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS self_improvement_jobs_v1 (
        job_id TEXT PRIMARY KEY REFERENCES jobs_v2(job_id),
        improvement_id TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL UNIQUE,
        context_json TEXT NOT NULL,
        state TEXT NOT NULL,
        patch_artifact_id TEXT,
        evidence_artifact_id TEXT,
        failure_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;`);
  }

  close(): void { this.#db?.close(); this.#db = undefined; }

  register(job: JobViewV2, improvementId: string, context: SelfImprovementContext): { readonly binding: SelfImprovementJobView; readonly duplicate: boolean } {
    requireImprovementId(improvementId);
    validateSelfImprovementContext(context);
    const branch = `friday/self/${improvementId}`;
    const contextJson = JSON.stringify(context);
    const existing = this.get(job.jobId);
    if (existing !== undefined) {
      if (existing.improvementId !== improvementId || existing.branch !== branch || JSON.stringify(existing.context) !== contextJson) {
        throw new Error("Self improvement Job is already bound to different metadata");
      }
      return { binding: existing, duplicate: true };
    }
    if (job.risk !== "R1" || job.operation !== "develop" || job.tool === "agent" || job.status !== "WAIT_APPROVAL") {
      throw new Error("Self improvement must be bound to a new R1 develop Job before execution");
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO self_improvement_jobs_v1
      (job_id,improvement_id,branch,context_json,state,patch_artifact_id,evidence_artifact_id,failure_code,created_at,updated_at)
      VALUES (?,?,?,?, 'PENDING',NULL,NULL,NULL,?,?)`)
      .run(job.jobId, improvementId, branch, contextJson, now, now);
    return { binding: this.#require(job.jobId), duplicate: false };
  }

  get(jobId: string): SelfImprovementJobView | undefined {
    requireUuid(jobId, "Job id");
    const row = this.db.prepare(`SELECT job_id AS jobId, improvement_id AS improvementId, branch, context_json AS contextJson,
      state, patch_artifact_id AS patchArtifactId, evidence_artifact_id AS evidenceArtifactId,
      failure_code AS failureCode, created_at AS createdAt, updated_at AS updatedAt
      FROM self_improvement_jobs_v1 WHERE job_id=?`).get(jobId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : bindingFromRow(row);
  }

  list(): readonly SelfImprovementJobView[] {
    return (this.db.prepare("SELECT job_id AS jobId FROM self_improvement_jobs_v1 ORDER BY created_at DESC LIMIT 200").all() as { jobId: string }[])
      .map((row) => this.#require(row.jobId));
  }

  pending(): readonly SelfImprovementJobView[] {
    return (this.db.prepare("SELECT job_id AS jobId FROM self_improvement_jobs_v1 WHERE state='PENDING' ORDER BY created_at").all() as { jobId: string }[])
      .map((row) => this.#require(row.jobId));
  }

  markPromoted(jobId: string, patchArtifactId: string, evidenceArtifactId: string): SelfImprovementJobView {
    requireUuid(jobId, "Job id"); requireUuid(patchArtifactId, "Patch artifact id"); requireUuid(evidenceArtifactId, "Evidence artifact id");
    const current = this.#require(jobId);
    if (current.state === "PROMOTED") {
      if (current.patchArtifactId !== patchArtifactId || current.evidenceArtifactId !== evidenceArtifactId) throw new Error("Promotion artifacts conflict with the durable binding");
      return current;
    }
    if (current.state !== "PENDING") throw new Error("Self improvement Job is not promotable");
    this.db.prepare("UPDATE self_improvement_jobs_v1 SET state='PROMOTED',patch_artifact_id=?,evidence_artifact_id=?,failure_code=NULL,updated_at=? WHERE job_id=? AND state='PENDING'")
      .run(patchArtifactId, evidenceArtifactId, new Date().toISOString(), jobId);
    return this.#require(jobId);
  }

  reject(jobId: string, failureCode: string): SelfImprovementJobView {
    requireUuid(jobId, "Job id");
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(failureCode)) throw new Error("Promotion failure code is invalid");
    const current = this.#require(jobId);
    if (current.state !== "PENDING") return current;
    this.db.prepare("UPDATE self_improvement_jobs_v1 SET state='REJECTED',failure_code=?,updated_at=? WHERE job_id=? AND state='PENDING'")
      .run(failureCode, new Date().toISOString(), jobId);
    return this.#require(jobId);
  }

  #require(jobId: string): SelfImprovementJobView {
    const value = this.get(jobId);
    if (value === undefined) throw new Error("Self improvement Job is not registered");
    return value;
  }

  get db(): DatabaseSync {
    if (this.#db === undefined) throw new Error("Self improvement Job registry is not open");
    return this.#db;
  }
}

export interface SelfImprovementPromotionResult {
  readonly binding: SelfImprovementJobView;
  readonly improvement?: SelfImprovementView;
}

export class SelfImprovementCoordinator {
  constructor(
    readonly bindings: SelfImprovementJobRegistry,
    readonly jobs: SqliteJobRegistry,
    readonly artifacts: JobArtifactStore,
    readonly improvements: SelfPatchRegistry,
    readonly onDiagnostic: (message: string) => void = () => {},
  ) {}

  async observe(jobId: string): Promise<SelfImprovementPromotionResult | undefined> {
    const binding = this.bindings.get(jobId);
    if (binding === undefined || binding.state !== "PENDING") {
      if (binding === undefined) return undefined;
      const improvement = this.improvements.getImprovement(binding.improvementId);
      return { binding, ...(improvement === undefined ? {} : { improvement }) };
    }
    const job = this.jobs.get(jobId);
    if (job === undefined) return { binding: this.bindings.reject(jobId, "SOURCE_JOB_NOT_FOUND") };
    if (job.status === "FAILED" || job.status === "CANCELLED") return { binding: this.bindings.reject(jobId, "SOURCE_JOB_NOT_SUCCESSFUL") };
    if (job.status !== "SUCCEEDED") return { binding };
    try {
      return await this.#promote(binding, job);
    } catch (error) {
      if (!(error instanceof PromotionValidationError)) throw error;
      this.onDiagnostic(`self improvement Job ${jobId} was not promoted: ${error.code}`);
      return { binding: this.bindings.reject(jobId, error.code) };
    }
  }

  async reconcile(): Promise<void> {
    for (const binding of this.bindings.pending()) {
      try { await this.observe(binding.jobId); } catch (error) {
        this.onDiagnostic(`self improvement Job ${binding.jobId} reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async #promote(binding: SelfImprovementJobView, job: JobViewV2): Promise<SelfImprovementPromotionResult> {
    if (job.risk !== "R1" || job.operation !== "develop" || job.tool === "agent" || job.spec === undefined) throw new PromotionValidationError("SOURCE_JOB_INVALID");
    const events = this.jobs.listEvents(job.jobId);
    const patchArtifacts = artifactEvents(events, "changes.diff", "text/x-diff");
    const evidenceArtifacts = artifactEvents(events, "test-evidence.json", "application/json");
    if (patchArtifacts.length !== 1 || evidenceArtifacts.length !== 1) throw new PromotionValidationError("ARTIFACT_SET_INVALID");
    const patchArtifact = patchArtifacts[0] as RunnerArtifactV1;
    const evidenceArtifact = evidenceArtifacts[0] as RunnerArtifactV1;
    const patchBytes = await this.artifacts.read(job.jobId, patchArtifact.artifactId);
    const evidenceBytes = await this.artifacts.read(job.jobId, evidenceArtifact.artifactId);
    if (patchBytes === undefined || evidenceBytes === undefined) throw new PromotionValidationError("ARTIFACT_BYTES_MISSING");
    verifyStoredBytes(patchArtifact, patchBytes);
    verifyStoredBytes(evidenceArtifact, evidenceBytes);
    let patch: string;
    try { patch = new TextDecoder("utf-8", { fatal: true }).decode(patchBytes); } catch { throw new PromotionValidationError("PATCH_INVALID"); }
    if (!patch.startsWith("diff --git ")) throw new PromotionValidationError("PATCH_INVALID");
    const evidence = parseEvidence(evidenceBytes);
    const stdout = events.filter((entry) => entry.event.type === "output" && entry.event.stream === "stdout").map((entry) => entry.event.chunk ?? "").join("");
    const stderr = events.filter((entry) => entry.event.type === "output" && entry.event.stream === "stderr").map((entry) => entry.event.chunk ?? "").join("");
    if (
      evidence.jobId !== job.jobId ||
      evidence.runnerId !== job.runnerId ||
      evidence.jobManifestSha256 !== job.spec.manifestSha256 ||
      evidence.operation !== job.operation ||
      evidence.patchSha256 !== patchArtifact.sha256 ||
      evidence.stdoutSha256 !== sha256(stdout) ||
      evidence.stderrSha256 !== sha256(stderr) ||
      Date.parse(evidence.completedAt) < Date.parse(job.createdAt)
    ) throw new PromotionValidationError("EVIDENCE_MISMATCH");

    let improvement: SelfImprovementView;
    try {
      improvement = this.improvements.createImprovementFromJob(binding.improvementId, binding.branch, patch, binding.context, job.jobId);
      if (improvement.state === "DRAFT") {
        this.improvements.markTested(binding.improvementId, evidenceArtifact.sha256);
        improvement = this.improvements.getImprovement(binding.improvementId) as SelfImprovementView;
      }
      if (improvement.state === "TESTED") improvement = this.improvements.requestClearance(binding.improvementId);
      if (improvement.state !== "WAIT_APPROVAL" && improvement.state !== "CLEARED" && improvement.state !== "CANARY" && improvement.state !== "DEPLOYED" && improvement.state !== "ROLLED_BACK") {
        throw new PromotionValidationError("IMPROVEMENT_STATE_INVALID");
      }
    } catch (error) {
      if (error instanceof PromotionValidationError) throw error;
      throw new PromotionValidationError("IMPROVEMENT_CONFLICT");
    }
    return { binding: this.bindings.markPromoted(job.jobId, patchArtifact.artifactId, evidenceArtifact.artifactId), improvement };
  }
}

export function selfImprovementJobPrompt(improvementId: string, context: SelfImprovementContext, task: string): string {
  requireImprovementId(improvementId);
  validateSelfImprovementContext(context);
  if (typeof task !== "string" || task.trim() === "" || Buffer.byteLength(task, "utf8") > 16_384) throw new Error("Self improvement task is invalid");
  return [
    "FRIDAY_SELF_IMPROVEMENT_JOB_V1",
    "Work only in the assigned isolated worktree. Implement the bounded candidate and run relevant tests.",
    "Do not deploy, push, access credentials, change live services, or claim clearance. Leave the tested changes as a Git diff for Hub review.",
    `Hub improvement id: ${improvementId}`,
    `Owner-visible context: ${JSON.stringify(context)}`,
    `Task: ${task}`,
  ].join("\n");
}

class PromotionValidationError extends Error {
  constructor(readonly code: string) { super(code); }
}

function artifactEvents(events: ReturnType<SqliteJobRegistry["listEvents"]>, name: string, mediaType: string): RunnerArtifactV1[] {
  return events.flatMap((entry) => entry.event.type === "artifact" && entry.event.artifact?.name === name && entry.event.artifact.mediaType === mediaType ? [entry.event.artifact] : []);
}

function verifyStoredBytes(artifact: RunnerArtifactV1, bytes: Buffer): void {
  if (artifact.sizeBytes !== bytes.byteLength || artifact.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new PromotionValidationError("ARTIFACT_DIGEST_MISMATCH");
}

function parseEvidence(bytes: Buffer): SelfImprovementTestEvidenceV1 {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { throw new PromotionValidationError("EVIDENCE_INVALID"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PromotionValidationError("EVIDENCE_INVALID");
  const record = value as Record<string, unknown>;
  const expected = ["completedAt", "executorImageId", "exitCode", "jobId", "jobManifestSha256", "operation", "patchSha256", "protocolVersion", "runnerId", "stderrSha256", "stdoutSha256"];
  if (
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expected) ||
    record.protocolVersion !== SELF_IMPROVEMENT_TEST_EVIDENCE_VERSION ||
    typeof record.jobId !== "string" || !UUID.test(record.jobId) ||
    typeof record.runnerId !== "string" || !UUID.test(record.runnerId) ||
    typeof record.jobManifestSha256 !== "string" || !SHA256.test(record.jobManifestSha256) ||
    typeof record.executorImageId !== "string" || !IMAGE_ID.test(record.executorImageId) ||
    (record.operation !== "develop" && record.operation !== "test") ||
    record.exitCode !== 0 ||
    typeof record.stdoutSha256 !== "string" || !SHA256.test(record.stdoutSha256) ||
    typeof record.stderrSha256 !== "string" || !SHA256.test(record.stderrSha256) ||
    typeof record.patchSha256 !== "string" || !SHA256.test(record.patchSha256) ||
    typeof record.completedAt !== "string" || Number.isNaN(Date.parse(record.completedAt))
  ) throw new PromotionValidationError("EVIDENCE_INVALID");
  return record as unknown as SelfImprovementTestEvidenceV1;
}

function bindingFromRow(row: Record<string, unknown>): SelfImprovementJobView {
  let context: unknown;
  try { context = JSON.parse(row.contextJson as string) as unknown; } catch { throw new Error("Stored self improvement Job context is invalid"); }
  validateSelfImprovementContext(context as SelfImprovementContext);
  if (
    typeof row.jobId !== "string" || !UUID.test(row.jobId) ||
    typeof row.improvementId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(row.improvementId) ||
    row.branch !== `friday/self/${row.improvementId}` ||
    (row.state !== "PENDING" && row.state !== "PROMOTED" && row.state !== "REJECTED") ||
    typeof row.createdAt !== "string" || Number.isNaN(Date.parse(row.createdAt)) ||
    typeof row.updatedAt !== "string" || Number.isNaN(Date.parse(row.updatedAt))
  ) throw new Error("Stored self improvement Job binding is invalid");
  return {
    jobId: row.jobId,
    improvementId: row.improvementId,
    branch: row.branch as string,
    context: context as SelfImprovementContext,
    state: row.state,
    ...(typeof row.patchArtifactId === "string" ? { patchArtifactId: row.patchArtifactId } : {}),
    ...(typeof row.evidenceArtifactId === "string" ? { evidenceArtifactId: row.evidenceArtifactId } : {}),
    ...(typeof row.failureCode === "string" ? { failureCode: row.failureCode } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireImprovementId(value: string): void { if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error("Invalid self improvement id"); }
function requireUuid(value: string, label: string): void { if (!UUID.test(value)) throw new Error(`${label} is invalid`); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
