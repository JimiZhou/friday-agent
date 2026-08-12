import { sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  JOB_PROTOCOL_VERSION,
  canonicalJsonV2,
  nodeToolAuthorizationProjectionV1,
  nodeToolCallSha256V1,
  type JobRiskLevelV2,
  type NodeToolAuthorizationV1,
  type NodeToolCallV1,
  type NodeToolDecisionV1,
  type NodeToolNameV1,
} from "@friday/protocol";
import type { HubIdentity } from "./hub-identity.js";
import type { SqliteJobRegistry } from "./job-registry.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TOOL_AUTHORITY_MS = 5 * 60_000;

export interface NodeToolApprovalView {
  readonly call: NodeToolCallV1;
  readonly callSha256: string;
  readonly risk: JobRiskLevelV2;
  readonly background: string;
  readonly status: "WAIT_APPROVAL" | "APPROVED" | "DENIED";
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The model can propose a named tool and JSON arguments. This class is the
 * control root: it validates the shape, derives risk by capability, persists
 * pending clearance, and signs only an exact call digest.
 */
export class NodeToolPolicy {
  #database: DatabaseSync | undefined;

  constructor(
    readonly databasePath: string,
    readonly identity: HubIdentity,
    readonly jobs: SqliteJobRegistry,
  ) {}

  open(): void {
    if (this.#database !== undefined) throw new Error("Node tool policy is already open");
    const database = new DatabaseSync(this.databasePath);
    this.#database = database;
    try {
      database.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS node_tool_calls_v1 (
          call_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES jobs_v2(job_id),
          runner_id TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          call_json TEXT NOT NULL,
          call_sha256 TEXT NOT NULL,
          risk TEXT NOT NULL,
          background TEXT NOT NULL,
          status TEXT NOT NULL,
          authorization_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS node_tool_calls_by_job_v1
          ON node_tool_calls_v1(job_id, created_at, call_id);
      `);
      this.#reconcileInterruptedApprovals(new Date());
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void { this.#database?.close(); this.#database = undefined; }

  evaluate(call: NodeToolCallV1, now = new Date()): NodeToolDecisionV1 {
    // A durable checkpoint may legitimately replay an already-persisted exact
    // call after the five-minute proposal window. Shape and live lease still
    // apply; freshness is required only for a previously unseen call id.
    validateNodeToolCall(call, now, false);
    this.jobs.assertActiveLease(call.jobId, call.runnerId, call.leaseId, now);
    const job = this.jobs.get(call.jobId);
    if (job === undefined || job.tool !== "agent" || job.spec?.leaseId !== call.leaseId) throw new Error("Node tool call is not bound to a remote Agent Job");
    const risk = nodeToolRisk(call.name);
    const callSha256 = nodeToolCallSha256V1(call);
    const background = approvalBackground(call, risk);
    const database = this.#requireDatabase();
    const existing = database.prepare("SELECT * FROM node_tool_calls_v1 WHERE call_id = ?").get(call.callId) as unknown;
    if (isRecord(existing)) {
      if (existing.call_sha256 !== callSha256) throw new Error("Node tool call id is already bound to different content");
      const decision = decisionFromRow(existing, now);
      if (decision.status === "WAIT_APPROVAL") this.jobs.waitForToolApproval(call.jobId, call.runnerId, call.leaseId, now);
      return decision;
    }
    validateNodeToolCall(call, now);
    const timestamp = now.toISOString();
    if (risk === "R0") {
      const authorization = this.#authorize(call, callSha256, risk, "policy", job.spec.leaseExpiresAt, now);
      database.prepare("INSERT INTO node_tool_calls_v1 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?)")
        .run(call.callId, call.jobId, call.runnerId, call.leaseId, JSON.stringify(call), callSha256, risk, background, JSON.stringify(authorization), timestamp, timestamp);
      return { status: "APPROVED", risk, background, authorization };
    }
    database.prepare("INSERT INTO node_tool_calls_v1 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WAIT_APPROVAL', NULL, ?, ?)")
      .run(call.callId, call.jobId, call.runnerId, call.leaseId, JSON.stringify(call), callSha256, risk, background, timestamp, timestamp);
    this.jobs.waitForToolApproval(call.jobId, call.runnerId, call.leaseId, now);
    return { status: "WAIT_APPROVAL", risk, background };
  }

  approve(callId: string, ownerId: string, now = new Date()): NodeToolDecisionV1 {
    requireUuid(callId, "callId");
    if (ownerId.trim() === "") throw new Error("ownerId must not be empty");
    const database = this.#requireDatabase();
    const row = database.prepare("SELECT * FROM node_tool_calls_v1 WHERE call_id = ?").get(callId.toLowerCase()) as unknown;
    if (!isRecord(row) || row.status !== "WAIT_APPROVAL" || typeof row.call_json !== "string" || typeof row.call_sha256 !== "string" || !SHA256_PATTERN.test(row.call_sha256) || !isRisk(row.risk)) throw new Error("Node tool call is not awaiting clearance");
    const call = JSON.parse(row.call_json) as NodeToolCallV1;
    validateNodeToolCall(call, now, false);
    const job = this.jobs.get(call.jobId);
    if (job?.spec?.leaseId !== call.leaseId || job.status !== "WAIT_APPROVAL" || job.tool !== "agent") throw new Error("Job is not bound to this pending node tool lease");
    if (Date.parse(job.spec.leaseExpiresAt) <= now.getTime()) {
      const background = `${String(row.background)} The Job lease expired before clearance; this exact call was not executed and the Agent will re-plan under a new lease.`;
      database.prepare("UPDATE node_tool_calls_v1 SET status='DENIED', authorization_json=NULL, background=?, updated_at=? WHERE call_id=? AND status='WAIT_APPROVAL'")
        .run(background, now.toISOString(), callId.toLowerCase());
      this.jobs.redispatchAfterDeniedToolCall(call.jobId, call.runnerId, call.leaseId, now);
      return { status: "DENIED", risk: row.risk, background };
    }
    this.jobs.assertBoundLease(call.jobId, call.runnerId, call.leaseId, now);
    const authorization = this.#authorize(call, row.call_sha256, row.risk, ownerId, job.spec.leaseExpiresAt, now);
    database.prepare("UPDATE node_tool_calls_v1 SET status='APPROVED', authorization_json=?, updated_at=? WHERE call_id=? AND status='WAIT_APPROVAL'")
      .run(JSON.stringify(authorization), now.toISOString(), callId.toLowerCase());
    this.jobs.dispatchAfterToolApproval(call.jobId, call.runnerId, call.leaseId, now);
    return { status: "APPROVED", risk: row.risk, background: String(row.background), authorization };
  }

  get(callId: string): NodeToolApprovalView | undefined {
    requireUuid(callId, "callId");
    const row = this.#requireDatabase().prepare("SELECT * FROM node_tool_calls_v1 WHERE call_id = ?").get(callId.toLowerCase()) as unknown;
    return isRecord(row) ? approvalFromRow(row) : undefined;
  }

  decision(callId: string, now = new Date()): NodeToolDecisionV1 | undefined {
    requireUuid(callId, "callId");
    const row = this.#requireDatabase().prepare("SELECT * FROM node_tool_calls_v1 WHERE call_id = ?").get(callId.toLowerCase()) as unknown;
    return isRecord(row) ? decisionFromRow(row, now) : undefined;
  }

  listPending(): readonly NodeToolApprovalView[] {
    return (this.#requireDatabase().prepare("SELECT * FROM node_tool_calls_v1 WHERE status='WAIT_APPROVAL' ORDER BY created_at").all() as unknown[]).map((row) => {
      if (!isRecord(row)) throw new Error("Stored node tool call is invalid");
      return approvalFromRow(row);
    });
  }

  #authorize(call: NodeToolCallV1, callSha256: string, risk: JobRiskLevelV2, approvedBy: string, leaseExpiresAt: string, now: Date): NodeToolAuthorizationV1 {
    const authorityExpiresAt = Math.min(now.getTime() + TOOL_AUTHORITY_MS, Date.parse(leaseExpiresAt));
    if (!Number.isFinite(authorityExpiresAt) || authorityExpiresAt <= now.getTime()) throw new Error("Job tool authorization lease expired");
    const unsigned: NodeToolAuthorizationV1 = {
      protocolVersion: JOB_PROTOCOL_VERSION,
      callId: call.callId,
      jobId: call.jobId,
      runnerId: call.runnerId,
      leaseId: call.leaseId,
      callSha256,
      risk,
      approvedBy,
      approvedAt: now.toISOString(),
      expiresAt: new Date(authorityExpiresAt).toISOString(),
      hubSignature: "",
    };
    const hubSignature = sign(null, Buffer.from(canonicalJsonV2(nodeToolAuthorizationProjectionV1(unsigned)), "utf8"), this.identity.privateKeyPem).toString("base64url");
    return Object.freeze({ ...unsigned, hubSignature });
  }

  #reconcileInterruptedApprovals(now: Date): void {
    const database = this.#requireDatabase();
    const rows = database.prepare("SELECT * FROM node_tool_calls_v1 ORDER BY updated_at, call_id").all() as unknown[];
    for (const raw of rows) {
      if (!isRecord(raw) || typeof raw.call_json !== "string" || !isRisk(raw.risk) || typeof raw.background !== "string" || (raw.status !== "WAIT_APPROVAL" && raw.status !== "APPROVED" && raw.status !== "DENIED")) throw new Error("Stored node tool reconciliation row is invalid");
      const call = JSON.parse(raw.call_json) as NodeToolCallV1;
      const job = this.jobs.get(call.jobId);
      const samePendingJob = job?.tool === "agent" && job.spec?.leaseId === call.leaseId && job.status === "WAIT_APPROVAL";
      if (raw.status === "WAIT_APPROVAL") {
        if (job?.tool === "agent" && job.spec?.leaseId === call.leaseId && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status) && Date.parse(job.spec.leaseExpiresAt) > now.getTime()) {
          this.jobs.waitForToolApproval(call.jobId, call.runnerId, call.leaseId, now);
          continue;
        }
        const background = `${raw.background} The pending call is no longer bound to an executable Job lease and was not executed.`;
        database.prepare("UPDATE node_tool_calls_v1 SET status='DENIED', authorization_json=NULL, background=?, updated_at=? WHERE call_id=?")
          .run(background, now.toISOString(), call.callId);
        if (samePendingJob) this.jobs.redispatchAfterDeniedToolCall(call.jobId, call.runnerId, call.leaseId, now);
        continue;
      }
      if (!samePendingJob) continue;
      if (raw.status === "APPROVED" && decisionFromRow(raw, now).status === "APPROVED") {
        this.jobs.dispatchAfterToolApproval(call.jobId, call.runnerId, call.leaseId, now);
        continue;
      }
      const background = `${raw.background} The stored authorization is no longer executable; the Agent will re-plan without executing this call.`;
      database.prepare("UPDATE node_tool_calls_v1 SET status='DENIED', authorization_json=NULL, background=?, updated_at=? WHERE call_id=?")
        .run(background, now.toISOString(), call.callId);
      this.jobs.redispatchAfterDeniedToolCall(call.jobId, call.runnerId, call.leaseId, now);
    }
  }

  #requireDatabase(): DatabaseSync {
    if (this.#database === undefined) throw new Error("Node tool policy is not open");
    return this.#database;
  }
}

export function nodeToolRisk(name: NodeToolNameV1): JobRiskLevelV2 {
  if (["system.snapshot", "process.list", "service.status", "journal.read", "network.sockets", "file.read", "file.search"].includes(name)) return "R0";
  if (name === "file.write") return "R1";
  if (name === "service.restart" || name === "process.signal" || name === "command.exec") return "R2";
  if (name === "file.delete") return "R3";
  throw new Error("Node tool is unsupported");
}

function validateNodeToolCall(call: NodeToolCallV1, now: Date, requireFresh = true): void {
  if (!isRecord(call) || Object.keys(call).sort().join(",") !== "arguments,callId,jobId,leaseId,name,protocolVersion,reason,requestedAt,runnerId" || call.protocolVersion !== JOB_PROTOCOL_VERSION) throw new Error("Node tool call is invalid");
  requireUuid(call.callId, "callId"); requireUuid(call.jobId, "jobId"); requireUuid(call.runnerId, "runnerId"); requireUuid(call.leaseId, "leaseId");
  nodeToolRisk(call.name);
  if (!isRecord(call.arguments) || Buffer.byteLength(JSON.stringify(call.arguments), "utf8") > 4 * 1024) throw new Error("Node tool arguments are invalid");
  if (typeof call.reason !== "string" || call.reason.trim() === "" || Buffer.byteLength(call.reason, "utf8") > 2_048 || call.reason.includes("\0")) throw new Error("Node tool reason is invalid");
  const requestedAt = Date.parse(call.requestedAt);
  if (!Number.isFinite(requestedAt) || (requireFresh && Math.abs(requestedAt - now.getTime()) > 5 * 60_000)) throw new Error("Node tool call timestamp is invalid");
}

function approvalBackground(call: NodeToolCallV1, risk: JobRiskLevelV2): string {
  return `${call.reason.trim()} Requested capability ${call.name} is classified ${risk} by Hub policy.`;
}

function decisionFromRow(row: Record<string, unknown>, now: Date): NodeToolDecisionV1 {
  if (!isRisk(row.risk) || typeof row.background !== "string" || (row.status !== "APPROVED" && row.status !== "WAIT_APPROVAL" && row.status !== "DENIED")) throw new Error("Stored node tool decision is invalid");
  if (row.status !== "APPROVED") return { status: row.status, risk: row.risk, background: row.background };
  if (typeof row.authorization_json !== "string") throw new Error("Stored node tool authorization is invalid");
  const authorization = JSON.parse(row.authorization_json) as NodeToolAuthorizationV1;
  if (Date.parse(authorization.expiresAt) <= now.getTime()) return { status: "DENIED", risk: row.risk, background: "The exact tool authorization expired and must be proposed again." };
  return { status: "APPROVED", risk: row.risk, background: row.background, authorization };
}

function approvalFromRow(row: Record<string, unknown>): NodeToolApprovalView {
  if (typeof row.call_json !== "string" || typeof row.call_sha256 !== "string" || !SHA256_PATTERN.test(row.call_sha256) || !isRisk(row.risk) || typeof row.background !== "string" || (row.status !== "WAIT_APPROVAL" && row.status !== "APPROVED" && row.status !== "DENIED") || typeof row.created_at !== "string" || typeof row.updated_at !== "string") throw new Error("Stored node tool approval is invalid");
  return { call: JSON.parse(row.call_json) as NodeToolCallV1, callSha256: row.call_sha256, risk: row.risk, background: row.background, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

function requireUuid(value: string, name: string): void { if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`); }
function isRisk(value: unknown): value is JobRiskLevelV2 { return value === "R0" || value === "R1" || value === "R2" || value === "R3"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
