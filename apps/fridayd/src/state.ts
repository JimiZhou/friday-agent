import { createHash } from "node:crypto";

import type {
  JobStateV1,
  RunnerEnvelopeV1,
  RunnerHeartbeatEnvelopeV1,
  RunnerRegisterEnvelopeV1,
} from "@friday/protocol";

import type { EventRecord } from "./event-store.js";

/** Three missed 15-second heartbeats make a runner unavailable. */
export const RUNNER_ONLINE_TTL_MS = 45_000;

export type JobStatus = JobStateV1;

export interface JobView {
  jobId: string;
  sourceMessageId: string;
  status: JobStateV1;
  createdAt: string;
}

export type RunnerStatus = "online" | "degraded" | "unknown";

export interface RunnerRecord {
  nodeId: string;
  displayName: string;
  version: string;
  capabilities: readonly string[];
  workspaces: readonly string[];
  shellExecution: false;
  /** Authoritative Hub receipt time. This, never sentAt, drives liveness. */
  lastReceivedAt: string;
  /** Backward-compatible display alias for lastReceivedAt. */
  lastSeenAt: string;
  /** Runner-supplied time, retained only for monotonic replay checks. */
  lastSentAt: string;
  status: RunnerStatus;
  activeJobs: number;
}

export interface RunnerView extends RunnerRecord {
  online: boolean;
}

export interface RunnerEnvelopeIdentity {
  runnerId: string;
  kind: "register" | "heartbeat";
  digest: string;
}

interface ApplyOptions {
  /** True only for an event appended by this running Hub process. */
  live?: boolean;
}

const JOB_STATES = new Set<JobStateV1>([
  "NEW",
  "PLANNING",
  "WAIT_APPROVAL",
  "DISPATCHED",
  "RUNNING",
  "WAIT_USER",
  "UNKNOWN",
  "RECONCILING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

export class FridayState {
  readonly jobs = new Map<string, JobView>();
  readonly acceptedMessageDigests = new Map<string, string>();
  readonly runners = new Map<string, RunnerRecord>();
  readonly seenRunnerEnvelopeIds = new Set<string>();

  readonly #runnerEnvelopeIdentities = new Map<string, RunnerEnvelopeIdentity>();
  readonly #liveRunnerIds = new Set<string>();

  rehydrate(events: readonly EventRecord[]): void {
    this.jobs.clear();
    this.acceptedMessageDigests.clear();
    this.runners.clear();
    this.seenRunnerEnvelopeIds.clear();
    this.#runnerEnvelopeIdentities.clear();
    this.#liveRunnerIds.clear();

    for (const event of events) {
      this.apply(event);
    }
  }

  apply(event: EventRecord, options: ApplyOptions = {}): void {
    if (event.type === "message.accepted") {
      const { digest, job, messageId } = parseAcceptedMessage(event);
      if (this.acceptedMessageDigests.has(messageId)) {
        throw invalidEvent(event, `messageId ${messageId} was accepted more than once`);
      }
      this.jobs.set(job.jobId, job);
      this.acceptedMessageDigests.set(messageId, digest);
      return;
    }

    if (event.type === "runner.registered") {
      const { envelope, receivedAt } = parseRunnerRegistration(event);
      const digest = runnerEnvelopeDigest(envelope);
      if (this.#envelopeAlreadySeen(envelope.envelopeId, envelope.runnerId, envelope.kind, digest)) {
        return;
      }

      const current = this.runners.get(envelope.runnerId);
      const runner: RunnerRecord = {
        nodeId: envelope.runnerId,
        displayName: envelope.payload.displayName,
        version: envelope.payload.version,
        capabilities: [...envelope.payload.capabilities],
        workspaces: [...envelope.payload.workspaces],
        shellExecution: false,
        lastReceivedAt: receivedAt,
        lastSeenAt: receivedAt,
        lastSentAt: envelope.sentAt,
        status: options.live === true ? current?.status ?? "unknown" : "unknown",
        activeJobs: options.live === true ? current?.activeJobs ?? 0 : 0,
      };
      this.#rememberEnvelope(envelope.envelopeId, envelope.runnerId, envelope.kind, digest);
      this.runners.set(envelope.runnerId, runner);
      this.#setLive(envelope.runnerId, options.live === true);
      return;
    }

    if (event.type === "runner.heartbeat") {
      const { envelope, receivedAt } = parseRunnerHeartbeat(event);
      const digest = runnerEnvelopeDigest(envelope);
      if (this.#envelopeAlreadySeen(envelope.envelopeId, envelope.runnerId, envelope.kind, digest)) {
        return;
      }

      const current = this.runners.get(envelope.runnerId);
      if (current === undefined) {
        throw invalidEvent(event, "heartbeat references an unregistered runner");
      }
      if (Date.parse(envelope.sentAt) < Date.parse(current.lastSentAt)) {
        throw invalidEvent(event, "heartbeat sentAt moves backwards");
      }

      this.#rememberEnvelope(envelope.envelopeId, envelope.runnerId, envelope.kind, digest);
      this.runners.set(envelope.runnerId, {
        ...current,
        lastReceivedAt: receivedAt,
        lastSeenAt: receivedAt,
        lastSentAt: envelope.sentAt,
        status: options.live === true ? envelope.payload.status : "unknown",
        activeJobs: options.live === true ? envelope.payload.activeJobs : 0,
      });
      this.#setLive(envelope.runnerId, options.live === true);
      return;
    }

    // Channel ingress is intentionally audit-only in M2. It cannot mutate an
    // Owner task, approval, Runner, or long-term preference by itself.
    if (event.type === "channel.inbound") return;

    throw invalidEvent(event, "unsupported event type");
  }

  runnerEnvelopeIdentity(envelopeId: string): RunnerEnvelopeIdentity | undefined {
    const identity = this.#runnerEnvelopeIdentities.get(envelopeId);
    return identity === undefined ? undefined : { ...identity };
  }

  runnerView(nodeId: string, now = Date.now()): RunnerView | undefined {
    const runner = this.runners.get(nodeId);
    return runner === undefined ? undefined : this.#deriveRunnerView(runner, now);
  }

  listRunners(now = Date.now()): RunnerView[] {
    return [...this.runners.values()].map((runner) => this.#deriveRunnerView(runner, now));
  }

  #deriveRunnerView(runner: RunnerRecord, now: number): RunnerView {
    const receivedAt = Date.parse(runner.lastReceivedAt);
    const age = now - receivedAt;
    const online =
      this.#liveRunnerIds.has(runner.nodeId) &&
      Number.isFinite(receivedAt) &&
      age >= 0 &&
      age <= RUNNER_ONLINE_TTL_MS;
    return {
      ...runner,
      status: online ? runner.status : "unknown",
      activeJobs: online ? runner.activeJobs : 0,
      online,
    };
  }

  #envelopeAlreadySeen(
    envelopeId: string,
    runnerId: string,
    kind: "register" | "heartbeat",
    digest: string,
  ): boolean {
    const existing = this.#runnerEnvelopeIdentities.get(envelopeId);
    if (existing !== undefined) {
      if (
        existing.runnerId !== runnerId ||
        existing.kind !== kind ||
        existing.digest !== digest
      ) {
        throw new Error(`Runner envelopeId ${envelopeId} is reused by a different envelope`);
      }
      return true;
    }
    return false;
  }

  #rememberEnvelope(
    envelopeId: string,
    runnerId: string,
    kind: "register" | "heartbeat",
    digest: string,
  ): void {
    this.seenRunnerEnvelopeIds.add(envelopeId);
    this.#runnerEnvelopeIdentities.set(envelopeId, { runnerId, kind, digest });
  }

  #setLive(runnerId: string, live: boolean): void {
    if (live) {
      this.#liveRunnerIds.add(runnerId);
    } else {
      this.#liveRunnerIds.delete(runnerId);
    }
  }
}

/** Stable across JSON object key order; JSON array order remains significant. */
export function runnerEnvelopeDigest(envelope: RunnerEnvelopeV1): string {
  return jsonDigest(envelope);
}

/** Digest a JSON protocol value independently of object key order. */
export function jsonDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot canonicalize a non-finite JSON number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Cannot canonicalize a non-JSON value");
}

function parseAcceptedMessage(event: EventRecord): {
  digest: string;
  job: JobView;
  messageId: string;
} {
  const payload = requireRecord(event.payload, event, "payload must be an object");
  let digest: string;
  let messageId: string;
  if (Object.hasOwn(payload, "message")) {
    requireExactKeys(payload, ["job", "message"], event, "legacy message.accepted payload");
    const message = requireRecord(payload.message, event, "payload.message must be an object");
    messageId = requireUuid(message.messageId, event, "message.messageId");
    digest = jsonDigest(message);
  } else {
    requireExactKeys(payload, ["job", "messageDigest", "messageId"], event, "message.accepted payload");
    messageId = requireUuid(payload.messageId, event, "payload.messageId");
    digest = requireSha256(payload.messageDigest, event, "payload.messageDigest");
  }
  const job = requireRecord(payload.job, event, "payload.job must be an object");
  requireExactKeys(job, ["createdAt", "jobId", "sourceMessageId", "status"], event, "message.accepted job");
  const jobId = requireUuid(job.jobId, event, "job.jobId");
  const sourceMessageId = requireUuid(job.sourceMessageId, event, "job.sourceMessageId");
  const createdAt = requireTimestamp(job.createdAt, event, "job.createdAt");
  if (typeof job.status !== "string" || !JOB_STATES.has(job.status as JobStateV1)) {
    throw invalidEvent(event, "job.status is not a JobStateV1 value");
  }
  if (sourceMessageId !== messageId) {
    throw invalidEvent(event, "job.sourceMessageId does not match message.messageId");
  }
  return {
    digest,
    job: { jobId, sourceMessageId, status: job.status as JobStateV1, createdAt },
    messageId,
  };
}

function parseRunnerRegistration(event: EventRecord): {
  envelope: RunnerRegisterEnvelopeV1;
  receivedAt: string;
} {
  const payload = requireRecord(event.payload, event, "payload must be an object");
  const envelope = parseRunnerEnvelope(payload.envelope, event);
  if (envelope.kind !== "register") {
    throw invalidEvent(event, "payload.envelope.kind must be register");
  }
  return { envelope, receivedAt: readReceivedAt(payload, event) };
}

function parseRunnerHeartbeat(event: EventRecord): {
  envelope: RunnerHeartbeatEnvelopeV1;
  receivedAt: string;
} {
  const payload = requireRecord(event.payload, event, "payload must be an object");
  const envelope = parseRunnerEnvelope(payload.envelope, event);
  if (envelope.kind !== "heartbeat") {
    throw invalidEvent(event, "payload.envelope.kind must be heartbeat");
  }
  return { envelope, receivedAt: readReceivedAt(payload, event) };
}

function parseRunnerEnvelope(
  value: unknown,
  event: EventRecord,
): RunnerRegisterEnvelopeV1 | RunnerHeartbeatEnvelopeV1 {
  const envelope = requireRecord(value, event, "payload.envelope must be an object");
  if (envelope.protocolVersion !== "1") {
    throw invalidEvent(event, "envelope.protocolVersion must be 1");
  }
  requireUuid(envelope.envelopeId, event, "envelope.envelopeId");
  requireUuid(envelope.runnerId, event, "envelope.runnerId");
  requireTimestamp(envelope.sentAt, event, "envelope.sentAt");
  if (envelope.kind !== "register" && envelope.kind !== "heartbeat") {
    throw invalidEvent(event, "envelope.kind must be register or heartbeat");
  }

  const payload = requireRecord(envelope.payload, event, "envelope.payload must be an object");
  if (envelope.kind === "register") {
    requireString(payload.displayName, event, "register.displayName");
    requireString(payload.version, event, "register.version");
    const capabilities = requireStringArray(payload.capabilities, event, "register.capabilities");
    requireStringArray(payload.workspaces, event, "register.workspaces");
    if (capabilities.includes("shell")) {
      throw invalidEvent(event, "register.capabilities must not contain shell");
    }
    if (payload.shellExecution !== false) {
      throw invalidEvent(event, "register.shellExecution must be explicitly false");
    }
    return envelope as unknown as RunnerRegisterEnvelopeV1;
  }

  if (payload.status !== "online" && payload.status !== "degraded") {
    throw invalidEvent(event, "heartbeat.status must be online or degraded");
  }
  if (!Number.isSafeInteger(payload.activeJobs) || (payload.activeJobs as number) < 0) {
    throw invalidEvent(event, "heartbeat.activeJobs must be a non-negative integer");
  }
  return envelope as unknown as RunnerHeartbeatEnvelopeV1;
}

function readReceivedAt(payload: Record<string, unknown>, event: EventRecord): string {
  return payload.receivedAt === undefined
    ? requireTimestamp(event.recordedAt, event, "recordedAt")
    : requireTimestamp(payload.receivedAt, event, "payload.receivedAt");
}

function requireRecord(
  value: unknown,
  event: EventRecord,
  problem: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidEvent(event, problem);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, event: EventRecord, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidEvent(event, `${field} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value: unknown, event: EventRecord, field: string): string {
  const timestamp = requireString(value, event, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw invalidEvent(event, `${field} must be a timestamp`);
  }
  return timestamp;
}

function requireUuid(value: unknown, event: EventRecord, field: string): string {
  const uuid = requireString(value, event, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw invalidEvent(event, `${field} must be a UUID`);
  }
  return uuid;
}

function requireSha256(value: unknown, event: EventRecord, field: string): string {
  const digest = requireString(value, event, field);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw invalidEvent(event, `${field} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  event: EventRecord,
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || !actual.every((key, index) => key === sortedExpected[index])) {
    throw invalidEvent(event, `${field} has unexpected or missing fields`);
  }
}

function requireStringArray(value: unknown, event: EventRecord, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw invalidEvent(event, `${field} must be an array of strings`);
  }
  return value;
}

function invalidEvent(event: EventRecord, problem: string): Error {
  return new Error(`Invalid ${event.type} event at sequence ${event.sequence}: ${problem}`);
}
