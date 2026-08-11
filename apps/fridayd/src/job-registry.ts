import { createHash, randomUUID, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  JOB_PROTOCOL_VERSION,
  canonicalJsonV2,
  jobManifestProjectionV2,
  type JobExecutionStateV2,
  type JobLimitsV2,
  type JobRiskLevelV2,
  type JobSpecV2,
  type JobToolV2,
  type RunnerJobEventV2,
} from "@friday/protocol";
import type { HubIdentity } from "./hub-identity.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LEASE_MS = 5 * 60_000;

export interface JobCreateInput {
  readonly idempotencyKey: string;
  readonly runnerId: string;
  readonly workspaceId: string;
  readonly tool: JobToolV2;
  readonly operation: "develop" | "diagnose" | "review" | "test";
  readonly prompt: string;
  readonly limits?: Partial<JobLimitsV2>;
}

export interface JobViewV2 {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly runnerId: string;
  readonly workspaceId: string;
  readonly tool: JobToolV2;
  readonly operation: "develop" | "diagnose" | "review" | "test";
  readonly risk: JobRiskLevelV2;
  readonly status: JobExecutionStateV2;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
  readonly spec?: JobSpecV2;
}

export interface JobEventView {
  readonly eventId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly event: RunnerJobEventV2;
}

export type JobIdempotencyResult =
  | { readonly outcome: "new" }
  | { readonly outcome: "duplicate"; readonly job: JobViewV2 }
  | { readonly outcome: "conflict" };

interface StoredJob extends JobViewV2 {
  readonly prompt: string;
  readonly limits: JobLimitsV2;
}

export class SqliteJobRegistry {
  readonly #databasePath: string;
  readonly #identity: HubIdentity;
  #database: DatabaseSync | undefined;

  constructor(databasePath: string, identity: HubIdentity) {
    this.#databasePath = databasePath;
    this.#identity = identity;
  }

  open(): void {
    if (this.#database !== undefined) throw new Error("Job registry is already open");
    const database = new DatabaseSync(this.#databasePath);
    this.#database = database;
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS jobs_v2 (
          job_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          runner_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          tool TEXT NOT NULL,
          operation TEXT NOT NULL,
          prompt TEXT NOT NULL,
          risk TEXT NOT NULL,
          limits_json TEXT NOT NULL,
          status TEXT NOT NULL,
          spec_json TEXT,
          last_sequence INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS job_events_v2 (
          job_id TEXT NOT NULL REFERENCES jobs_v2(job_id),
          sequence INTEGER NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          recorded_at TEXT NOT NULL,
          event_json TEXT NOT NULL,
          PRIMARY KEY (job_id, sequence)
        ) STRICT;
      `);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    const database = this.#database;
    this.#database = undefined;
    database?.close();
  }

  create(input: JobCreateInput, now = new Date()): { readonly job: JobViewV2; readonly duplicate: boolean } {
    validateCreateInput(input);
    const database = this.#requireDatabase();
    return this.#transaction(database, () => {
      const existing = database.prepare("SELECT * FROM jobs_v2 WHERE idempotency_key = ?").get(input.idempotencyKey) as unknown;
      if (isRecord(existing)) {
        const stored = this.#toStored(existing);
        if (!sameJobRequest(stored, input, input.runnerId)) throw new Error("idempotencyKey is already bound to a different Job request");
        return { job: this.#toView(stored), duplicate: true };
      }
      const risk: JobRiskLevelV2 = input.tool === "diagnostic" ? "R0" : "R1";
      const status: JobExecutionStateV2 = risk === "R0" ? "DISPATCHED" : "WAIT_APPROVAL";
      const createdAt = now.toISOString();
      const jobId = randomUUID();
      const limits = normalizeLimits(input.limits);
      const spec = status === "DISPATCHED" ? this.#signSpec({ ...input, jobId, risk, limits, createdAt }) : undefined;
      database.prepare(`INSERT INTO jobs_v2 (job_id, idempotency_key, runner_id, workspace_id, tool, operation, prompt, risk, limits_json, status, spec_json, last_sequence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, -1, ?, ?)`)
        .run(jobId, input.idempotencyKey, input.runnerId, input.workspaceId, input.tool, input.operation, input.prompt, risk, JSON.stringify(limits), status, spec === undefined ? null : JSON.stringify(spec), createdAt, createdAt);
      return { job: this.#readJob(jobId), duplicate: false };
    });
  }

  approve(jobId: string, ownerId: string, now = new Date()): JobViewV2 {
    requireUuid(jobId, "jobId");
    if (ownerId.trim() === "") throw new Error("ownerId must not be empty");
    const database = this.#requireDatabase();
    return this.#transaction(database, () => {
      const job = this.#readStored(jobId);
      if (job.status !== "WAIT_APPROVAL" || job.risk !== "R1") throw new Error("Job is not awaiting R1 approval");
      const spec = this.#signSpec({ ...job, createdAt: job.createdAt });
      const updatedAt = now.toISOString();
      database.prepare("UPDATE jobs_v2 SET status = 'DISPATCHED', spec_json = ?, updated_at = ? WHERE job_id = ? AND status = 'WAIT_APPROVAL'")
        .run(JSON.stringify(spec), updatedAt, jobId);
      return this.#readJob(jobId);
    });
  }

  pull(runnerId: string, now = new Date()): JobSpecV2 | undefined {
    requireUuid(runnerId, "runnerId");
    const database = this.#requireDatabase();
    return this.#transaction(database, () => {
      const row = database.prepare("SELECT * FROM jobs_v2 WHERE runner_id = ? AND status = 'DISPATCHED' ORDER BY created_at LIMIT 1").get(runnerId) as unknown;
      if (!isRecord(row)) return undefined;
      const job = this.#toStored(row);
      const spec = job.spec;
      if (spec === undefined) throw new Error("Dispatched job has no signed spec");
      if (Date.parse(spec.leaseExpiresAt) <= now.getTime()) {
        const renewed = this.#signSpec({ ...job, createdAt: job.createdAt });
        database.prepare("UPDATE jobs_v2 SET spec_json = ?, updated_at = ? WHERE job_id = ?").run(JSON.stringify(renewed), now.toISOString(), job.jobId);
        return renewed;
      }
      return spec;
    });
  }

  acceptEvent(event: RunnerJobEventV2, now = new Date()): { readonly duplicate: boolean; readonly job: JobViewV2 } {
    validateRunnerEvent(event);
    const database = this.#requireDatabase();
    return this.#transaction(database, () => {
      const job = this.#readStored(event.jobId);
      if (job.runnerId !== event.runnerId) throw new Error("Runner is not assigned to this job");
      if (job.spec?.leaseId !== event.leaseId || Date.parse(job.spec.leaseExpiresAt) < now.getTime()) {
        throw new Error("Job lease is invalid or expired");
      }
      if (event.sequence <= job.lastSequence) {
        const seen = database.prepare("SELECT event_json AS eventJson FROM job_events_v2 WHERE job_id = ? AND sequence = ?").get(event.jobId, event.sequence) as unknown;
        if (isRecord(seen) && seen.eventJson === JSON.stringify(event)) return { duplicate: true, job: this.#readJob(event.jobId) };
        throw new Error("Runner event sequence conflicts with an existing event");
      }
      if (event.sequence !== job.lastSequence + 1) throw new Error("Runner event sequence has a gap; reconcile is required");
      const nextStatus = event.type === "state" ? transition(job.status, event.state as JobExecutionStateV2) : job.status;
      const recordedAt = now.toISOString();
      database.prepare("INSERT INTO job_events_v2 (job_id, sequence, event_id, recorded_at, event_json) VALUES (?, ?, ?, ?, ?)")
        .run(event.jobId, event.sequence, event.eventId, recordedAt, JSON.stringify(event));
      database.prepare("UPDATE jobs_v2 SET status = ?, last_sequence = ?, updated_at = ? WHERE job_id = ?")
        .run(nextStatus, event.sequence, recordedAt, event.jobId);
      return { duplicate: false, job: this.#readJob(event.jobId) };
    });
  }

  reconcile(jobId: string, runnerId: string, leaseId: string, now = new Date()): JobViewV2 {
    requireUuid(jobId, "jobId");
    requireUuid(runnerId, "runnerId");
    requireUuid(leaseId, "leaseId");
    const database = this.#requireDatabase();
    return this.#transaction(database, () => {
      const job = this.#readStored(jobId);
      if (job.runnerId !== runnerId) throw new Error("Runner is not assigned to this job");
      if (job.spec?.leaseId !== leaseId || Date.parse(job.spec.leaseExpiresAt) < now.getTime()) throw new Error("Job lease is invalid or expired");
      if (job.status === "RUNNING" || job.status === "DISPATCHED") {
        database.prepare("UPDATE jobs_v2 SET status = 'RECONCILING', updated_at = ? WHERE job_id = ?").run(now.toISOString(), jobId);
      }
      return this.#readJob(jobId);
    });
  }

  /** Artifact bytes are accepted only during a live signed lease; the event is still the audit record. */
  assertActiveLease(jobId: string, runnerId: string, leaseId: string, now = new Date()): void {
    requireUuid(jobId, "jobId"); requireUuid(runnerId, "runnerId"); requireUuid(leaseId, "leaseId");
    const job = this.#readStored(jobId);
    if (job.runnerId !== runnerId || job.spec?.leaseId !== leaseId || Date.parse(job.spec.leaseExpiresAt) < now.getTime()) throw new Error("Job lease is invalid or expired");
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) throw new Error("Terminal jobs cannot upload artifacts");
  }

  cancel(jobId: string, now = new Date()): JobViewV2 {
    requireUuid(jobId, "jobId");
    const database = this.#requireDatabase();
    return this.#transaction(database, () => {
      const job = this.#readStored(jobId);
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) throw new Error("Terminal job cannot be stopped");
      database.prepare("UPDATE jobs_v2 SET status = 'CANCELLED', updated_at = ? WHERE job_id = ?").run(now.toISOString(), jobId);
      return this.#readJob(jobId);
    });
  }

  get(jobId: string): JobViewV2 | undefined {
    requireUuid(jobId, "jobId");
    const row = this.#requireDatabase().prepare("SELECT * FROM jobs_v2 WHERE job_id = ?").get(jobId) as unknown;
    return isRecord(row) ? this.#toView(row) : undefined;
  }

  resolveIdempotency(input: Omit<JobCreateInput, "runnerId">, runnerId?: string): JobIdempotencyResult {
    requireUuid(input.idempotencyKey, "idempotencyKey");
    const row = this.#requireDatabase().prepare("SELECT * FROM jobs_v2 WHERE idempotency_key = ?").get(input.idempotencyKey) as unknown;
    if (!isRecord(row)) return { outcome: "new" };
    const stored = this.#toStored(row);
    return sameJobRequest(stored, input, runnerId)
      ? { outcome: "duplicate", job: this.#toView(stored) }
      : { outcome: "conflict" };
  }

  list(): readonly JobViewV2[] {
    return (this.#requireDatabase().prepare("SELECT * FROM jobs_v2 ORDER BY created_at DESC LIMIT 200").all() as unknown[]).map((row) => {
      if (!isRecord(row)) throw new Error("Stored job is invalid");
      return this.#toView(row);
    });
  }

  nonTerminalCountByRunner(): ReadonlyMap<string, number> {
    const rows = this.#requireDatabase().prepare(`
      SELECT runner_id AS runnerId, COUNT(*) AS assignedJobs
      FROM jobs_v2
      WHERE status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
      GROUP BY runner_id
    `).all() as unknown[];
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!isRecord(row) || typeof row.runnerId !== "string" || !Number.isSafeInteger(row.assignedJobs)) {
        throw new Error("Stored fleet assignment count is invalid");
      }
      counts.set(row.runnerId, row.assignedJobs as number);
    }
    return counts;
  }

  listEvents(jobId: string): readonly JobEventView[] {
    requireUuid(jobId, "jobId");
    return (this.#requireDatabase().prepare("SELECT event_id AS eventId, sequence, recorded_at AS recordedAt, event_json AS eventJson FROM job_events_v2 WHERE job_id = ? ORDER BY sequence").all(jobId) as unknown[])
      .map((row) => {
        if (!isRecord(row) || typeof row.eventId !== "string" || typeof row.sequence !== "number" || typeof row.recordedAt !== "string" || typeof row.eventJson !== "string") throw new Error("Stored job event is invalid");
        return { eventId: row.eventId, sequence: row.sequence, recordedAt: row.recordedAt, event: JSON.parse(row.eventJson) as RunnerJobEventV2 };
      });
  }

  #signSpec(input: Omit<StoredJob, "status" | "updatedAt" | "lastSequence" | "spec"> | (JobCreateInput & { jobId: string; risk: JobRiskLevelV2; limits: JobLimitsV2; createdAt: string })): JobSpecV2 {
    const leaseId = randomUUID();
    const now = new Date();
    const draft = {
      protocolVersion: JOB_PROTOCOL_VERSION,
      jobId: input.jobId,
      idempotencyKey: input.idempotencyKey,
      runnerId: input.runnerId,
      workspaceId: input.workspaceId,
      tool: input.tool,
      operation: input.operation,
      prompt: input.prompt,
      risk: input.risk,
      limits: input.limits,
      network: { mode: "none" as const, allowedHosts: [] as const },
      createdAt: input.createdAt,
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      leaseId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
    };
    const manifestSha256 = sha256(canonicalJsonV2(draft));
    const signed = { ...draft, manifestSha256, hubSignature: "" } as JobSpecV2;
    const signature = sign(null, Buffer.from(canonicalJsonV2(jobManifestProjectionV2(signed)), "utf8"), this.#identity.privateKeyPem).toString("base64url");
    return { ...signed, hubSignature: signature };
  }

  #readStored(jobId: string): StoredJob {
    const row = this.#requireDatabase().prepare("SELECT * FROM jobs_v2 WHERE job_id = ?").get(jobId) as unknown;
    if (!isRecord(row)) throw new Error("Job was not found");
    return this.#toStored(row);
  }

  #readJob(jobId: string): JobViewV2 {
    return this.#toView(this.#readStored(jobId));
  }

  #toView(row: Record<string, unknown> | StoredJob): JobViewV2 {
    const job = "prompt" in row && "limits" in row ? row as StoredJob : this.#toStored(row as Record<string, unknown>);
    const { prompt: _prompt, limits: _limits, ...view } = job;
    return view;
  }

  #toStored(row: Record<string, unknown>): StoredJob {
    const string = (name: string): string => { const value = row[name]; if (typeof value !== "string") throw new Error(`Stored job ${name} is invalid`); return value; };
    const number = (name: string): number => { const value = row[name]; if (!Number.isSafeInteger(value)) throw new Error(`Stored job ${name} is invalid`); return value as number; };
    const risk = string("risk") as JobRiskLevelV2;
    const status = string("status") as JobExecutionStateV2;
    if (!isRisk(risk) || !isState(status)) throw new Error("Stored job state is invalid");
    const tool = string("tool"); const operation = string("operation");
    if (!isTool(tool) || !["develop", "diagnose", "review", "test"].includes(operation)) throw new Error("Stored job action is invalid");
    const limits = JSON.parse(string("limits_json")) as JobLimitsV2;
    validateLimits(limits);
    const specRaw = row.spec_json;
    const spec = specRaw === null ? undefined : parseSpec(typeof specRaw === "string" ? specRaw : "");
    return { jobId: string("job_id"), idempotencyKey: string("idempotency_key"), runnerId: string("runner_id"), workspaceId: string("workspace_id"), tool, operation: operation as StoredJob["operation"], prompt: string("prompt"), risk, status, limits, createdAt: string("created_at"), updatedAt: string("updated_at"), lastSequence: number("last_sequence"), ...(spec === undefined ? {} : { spec }) };
  }

  #requireDatabase(): DatabaseSync { if (this.#database === undefined) throw new Error("Job registry is not open"); return this.#database; }
  #transaction<T>(database: DatabaseSync, operation: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = operation(); database.exec("COMMIT"); return result; } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; } }
}

function parseSpec(raw: string): JobSpecV2 { const value = JSON.parse(raw) as JobSpecV2; if (value.protocolVersion !== JOB_PROTOCOL_VERSION || !SHA256_PATTERN.test(value.manifestSha256) || typeof value.hubSignature !== "string") throw new Error("Stored job spec is invalid"); return value; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function requireUuid(value: string, name: string): void { if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`); }
function validateCreateInput(input: JobCreateInput): void { requireUuid(input.idempotencyKey, "idempotencyKey"); requireUuid(input.runnerId, "runnerId"); if (!WORKSPACE_PATTERN.test(input.workspaceId)) throw new Error("workspaceId is invalid"); if (!isTool(input.tool) || !["develop", "diagnose", "review", "test"].includes(input.operation)) throw new Error("Job action is invalid"); if (input.prompt.trim().length === 0 || input.prompt.length > 32_768) throw new Error("Job prompt is invalid"); if (input.limits !== undefined) validateLimits(normalizeLimits(input.limits)); }
function normalizeLimits(value: Partial<JobLimitsV2> | undefined): JobLimitsV2 { const limits = { timeoutSeconds: value?.timeoutSeconds ?? 900, maxOutputBytes: value?.maxOutputBytes ?? 1_048_576, cpuMillis: value?.cpuMillis ?? 1000, memoryMiB: value?.memoryMiB ?? 1024 }; validateLimits(limits); return limits; }
function validateLimits(value: JobLimitsV2): void { if (!Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 3600 || !Number.isSafeInteger(value.maxOutputBytes) || value.maxOutputBytes < 1024 || value.maxOutputBytes > 67_108_864 || !Number.isSafeInteger(value.cpuMillis) || value.cpuMillis < 100 || value.cpuMillis > 4000 || !Number.isSafeInteger(value.memoryMiB) || value.memoryMiB < 128 || value.memoryMiB > 8192) throw new Error("Job limits are invalid"); }
function isRisk(value: string): value is JobRiskLevelV2 { return value === "R0" || value === "R1" || value === "R2" || value === "R3"; }
function isTool(value: string): value is JobToolV2 { return value === "codex" || value === "pi" || value === "claude" || value === "diagnostic"; }
function isState(value: string): value is JobExecutionStateV2 { return ["NEW", "PLANNING", "WAIT_APPROVAL", "DISPATCHED", "RUNNING", "WAIT_USER", "UNKNOWN", "RECONCILING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(value); }
function transition(current: JobExecutionStateV2, next: JobExecutionStateV2): JobExecutionStateV2 { const allowed: Readonly<Record<JobExecutionStateV2, readonly JobExecutionStateV2[]>> = { NEW: ["PLANNING", "CANCELLED"], PLANNING: ["WAIT_APPROVAL", "DISPATCHED", "FAILED", "CANCELLED"], WAIT_APPROVAL: ["DISPATCHED", "CANCELLED"], DISPATCHED: ["RUNNING", "UNKNOWN", "CANCELLED"], RUNNING: ["WAIT_USER", "SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN", "RECONCILING"], WAIT_USER: ["RUNNING", "CANCELLED", "UNKNOWN"], UNKNOWN: ["RECONCILING", "CANCELLED"], RECONCILING: ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"], SUCCEEDED: [], FAILED: [], CANCELLED: [] }; if (current === next || !allowed[current].includes(next)) throw new Error(`Invalid job transition ${current} -> ${next}`); return next; }
function validateRunnerEvent(event: RunnerJobEventV2): void { if (event.protocolVersion !== JOB_PROTOCOL_VERSION) throw new Error("Unsupported job event protocol"); requireUuid(event.eventId, "eventId"); requireUuid(event.jobId, "jobId"); requireUuid(event.runnerId, "runnerId"); requireUuid(event.leaseId, "leaseId"); if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) throw new Error("Runner event sequence is invalid"); if (event.type === "state" && (event.state === undefined || !isState(event.state))) throw new Error("State event is invalid"); if (event.type === "output" && (event.stream === undefined || typeof event.chunk !== "string" || event.chunk.length > 1_048_576)) throw new Error("Output event is invalid"); if (event.type === "artifact" && event.artifact === undefined) throw new Error("Artifact event is invalid"); if (event.type === "error" && event.error === undefined) throw new Error("Error event is invalid"); }
function sameJobRequest(job: StoredJob, input: Omit<JobCreateInput, "runnerId">, runnerId?: string): boolean { const limits = normalizeLimits(input.limits); return (runnerId === undefined || job.runnerId === runnerId) && job.workspaceId === input.workspaceId && job.tool === input.tool && job.operation === input.operation && job.prompt === input.prompt && job.limits.timeoutSeconds === limits.timeoutSeconds && job.limits.maxOutputBytes === limits.maxOutputBytes && job.limits.cpuMillis === limits.cpuMillis && job.limits.memoryMiB === limits.memoryMiB; }
