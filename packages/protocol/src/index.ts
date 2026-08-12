import { createHash } from "node:crypto";

/** The wire-protocol version implemented by this package. */
export const PROTOCOL_VERSION = "1" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type Uuid = string;
export type IsoDateTime = string;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ProtocolErrorV1 {
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

/**
 * Canonical byte payload signed by an enrolled Runner for an HTTP request.
 * The body is the exact UTF-8 JSON string sent on the wire, so the signature
 * is bound to both route and content without trusting a shared bearer token.
 */
export function runnerRequestSignaturePayload(method: string, path: string, body: string): string {
  return `friday-runner-request-v1\n${method.toUpperCase()}\n${path}\n${body}`;
}

export type InboundChannelV1 =
  | "web"
  | "telegram"
  | "wechat_ilink"
  | "voice";

export type AuthStrengthV1 = "unverified" | "channel" | "strong";

export interface InboundAttachmentV1 {
  attachmentId: Uuid;
  kind: "image" | "audio" | "video" | "file";
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uri: string;
}

export interface InboundAudioAttachmentV1 extends InboundAttachmentV1 {
  kind: "audio";
}

export type InboundContentV1 =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "voice";
      attachment: InboundAudioAttachmentV1;
    }
  | {
      kind: "attachments";
      attachments: readonly InboundAttachmentV1[];
    }
  | {
      kind: "mixed";
      text: string;
      attachments: readonly InboundAttachmentV1[];
    };

export interface InboundMessageV1 {
  protocolVersion: ProtocolVersion;
  messageId: Uuid;
  channel: InboundChannelV1;
  senderId: string;
  conversationId: string;
  authStrength: AuthStrengthV1;
  receivedAt: IsoDateTime;
  content: InboundContentV1;
  replyTo?: Uuid;
}

export type PiWorkerOperationV1 =
  | "ping"
  | "start"
  | "prompt"
  | "steer"
  | "follow_up"
  | "abort"
  | "get_state"
  | "compact"
  | "close";

export type PiWorkerEventNameV1 =
  | "ready"
  | "session_started"
  | "assistant_delta"
  | "tool_started"
  | "tool_finished"
  | "state_changed"
  | "compacted"
  | "closed"
  | "worker_error";

interface PiWorkerEnvelopeBaseV1 {
  protocolVersion: ProtocolVersion;
  envelopeId: Uuid;
  sentAt: IsoDateTime;
  sessionId?: Uuid;
}

interface PiWorkerRequestBaseV1 {
  protocolVersion: ProtocolVersion;
  envelopeId: Uuid;
  sentAt: IsoDateTime;
  kind: "request";
  requestId: Uuid;
}

export interface PiWorkerStartPayloadV1 {
  /** Omit to let the worker allocate a session id. An empty object is valid. */
  sessionId?: Uuid;
}

export interface PiWorkerTextPayloadV1 {
  text: string;
  /** Decoded image bytes are capped again by the isolated Worker. */
  images?: readonly PiWorkerImageV1[];
}

export interface PiWorkerImageV1 {
  type: "image";
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

export interface PiWorkerPingRequestV1 extends PiWorkerRequestBaseV1 {
  operation: "ping";
  payload: null;
  sessionId?: never;
}

export interface PiWorkerStartRequestV1 extends PiWorkerRequestBaseV1 {
  operation: "start";
  payload: PiWorkerStartPayloadV1;
  sessionId?: never;
}

export interface PiWorkerTextRequestV1 extends PiWorkerRequestBaseV1 {
  operation: "prompt" | "steer" | "follow_up";
  payload: PiWorkerTextPayloadV1;
  sessionId: Uuid;
}

export interface PiWorkerSessionControlRequestV1 extends PiWorkerRequestBaseV1 {
  operation: "abort" | "get_state" | "compact" | "close";
  payload: null;
  sessionId: Uuid;
}

export type PiWorkerStatelessRequestV1 =
  | PiWorkerPingRequestV1
  | PiWorkerStartRequestV1;

export type PiWorkerSessionRequestV1 =
  | PiWorkerTextRequestV1
  | PiWorkerSessionControlRequestV1;

export type PiWorkerRequestV1 =
  | PiWorkerStatelessRequestV1
  | PiWorkerSessionRequestV1;

export interface PiWorkerSuccessResponseV1 extends PiWorkerEnvelopeBaseV1 {
  kind: "response";
  requestId: Uuid;
  ok: true;
  payload?: JsonValue;
}

export interface PiWorkerErrorResponseV1 extends PiWorkerEnvelopeBaseV1 {
  kind: "response";
  requestId: Uuid;
  ok: false;
  error: ProtocolErrorV1;
}

export interface PiWorkerEventV1 extends PiWorkerEnvelopeBaseV1 {
  kind: "event";
  sequence: number;
  event: PiWorkerEventNameV1;
  payload: JsonValue;
}

export type PiWorkerEnvelopeV1 =
  | PiWorkerRequestV1
  | PiWorkerSuccessResponseV1
  | PiWorkerErrorResponseV1
  | PiWorkerEventV1;

export type JobToolV1 = "codex" | "claude_code" | "pi" | "diagnostic";
export type JobOperationV1 =
  | "develop"
  | "diagnose"
  | "review"
  | "test"
  | "custom";
export type ApprovalLevelV1 = "R0" | "R1" | "R2" | "R3";
export type ApprovalStatusV1 = "not_required" | "pending" | "approved";
export type NetworkModeV1 = "none" | "tailscale" | "restricted";

export type JobApprovalV1 =
  | {
      level: "R0";
      status: "not_required";
      approvedBy?: never;
      approvedAt?: never;
      manifestSha256?: never;
    }
  | {
      level: Exclude<ApprovalLevelV1, "R0">;
      status: "pending";
      approvedBy?: never;
      approvedAt?: never;
      manifestSha256?: never;
    }
  | {
      level: Exclude<ApprovalLevelV1, "R0">;
      status: "approved";
      approvedBy: string;
      approvedAt: IsoDateTime;
      manifestSha256: string;
    };

export interface JobLimitsV1 {
  timeoutSeconds: number;
  maxOutputBytes: number;
  maxCostUsd: number;
}

export type JobNetworkPolicyV1 =
  | {
      mode: "none";
      allowedHosts: readonly [];
    }
  | {
      mode: Exclude<NetworkModeV1, "none">;
      allowedHosts: readonly string[];
    };

export interface JobInputV1 {
  prompt: string;
  context?: JsonValue;
}

export interface JobSpecV1 {
  protocolVersion: ProtocolVersion;
  jobId: Uuid;
  idempotencyKey: Uuid;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
  runnerId: Uuid;
  workspaceId: string;
  tool: JobToolV1;
  operation: JobOperationV1;
  approval: JobApprovalV1;
  limits: JobLimitsV1;
  network: JobNetworkPolicyV1;
  secrets: readonly string[];
  input: JobInputV1;
}

export type JobStateV1 =
  | "NEW"
  | "PLANNING"
  | "WAIT_APPROVAL"
  | "DISPATCHED"
  | "RUNNING"
  | "WAIT_USER"
  | "UNKNOWN"
  | "RECONCILING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface RunnerRegisterPayloadV1 {
  displayName: string;
  version: string;
  capabilities: readonly string[];
  workspaces: readonly string[];
  /** The v1 skeleton advertises orchestration only and cannot execute a shell. */
  shellExecution: false;
}

export interface RunnerHeartbeatPayloadV1 {
  status: "online" | "degraded";
  activeJobs: number;
}

export type RunnerEventPayloadV1 =
  | {
      jobId: Uuid;
      sequence: number;
      event: "state";
      state: JobStateV1;
    }
  | {
      jobId: Uuid;
      sequence: number;
      event: "output";
      stream: "stdout" | "stderr" | "log";
      chunk: string;
    }
  | {
      jobId: Uuid;
      sequence: number;
      event: "artifact";
      artifact: RunnerArtifactV1;
    }
  | {
      jobId: Uuid;
      sequence: number;
      event: "input_request";
      prompt: string;
      secret: boolean;
    }
  | {
      jobId: Uuid;
      sequence: number;
      event: "error";
      error: ProtocolErrorV1;
    };

export interface RunnerArtifactV1 {
  artifactId: Uuid;
  name: string;
  mediaType: string;
  uri: string;
  sha256: string;
  sizeBytes: number;
}

interface RunnerEnvelopeBaseV1 {
  protocolVersion: ProtocolVersion;
  envelopeId: Uuid;
  runnerId: Uuid;
  sentAt: IsoDateTime;
}

export interface RunnerRegisterEnvelopeV1 extends RunnerEnvelopeBaseV1 {
  kind: "register";
  payload: RunnerRegisterPayloadV1;
}

export interface RunnerHeartbeatEnvelopeV1 extends RunnerEnvelopeBaseV1 {
  kind: "heartbeat";
  payload: RunnerHeartbeatPayloadV1;
}

export interface RunnerEventEnvelopeV1 extends RunnerEnvelopeBaseV1 {
  kind: "event";
  payload: RunnerEventPayloadV1;
}

export type RunnerEnvelopeV1 =
  | RunnerRegisterEnvelopeV1
  | RunnerHeartbeatEnvelopeV1
  | RunnerEventEnvelopeV1;

/**
 * M1 task dispatch deliberately uses a separate protocol version. The v1
 * Runner registration schema has `shellExecution: false` as an invariant and
 * must never be widened in place.
 */
export const JOB_PROTOCOL_VERSION = "2" as const;
export type JobProtocolVersion = typeof JOB_PROTOCOL_VERSION;

/**
 * Evidence emitted by the trusted Runner after a successful isolated job.
 * Model output is deliberately excluded: the digest binds only Hub-signed
 * assignment facts, the verified executor image, bounded output bytes, and
 * the collected patch.
 */
export const SELF_IMPROVEMENT_TEST_EVIDENCE_VERSION = "1" as const;
export interface SelfImprovementTestEvidenceV1 {
  readonly protocolVersion: typeof SELF_IMPROVEMENT_TEST_EVIDENCE_VERSION;
  readonly jobId: Uuid;
  readonly runnerId: Uuid;
  readonly jobManifestSha256: string;
  readonly executorImageId: string;
  readonly operation: "develop" | "test";
  readonly exitCode: 0;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly patchSha256: string;
  readonly completedAt: IsoDateTime;
}

export type JobRiskLevelV2 = "R0" | "R1" | "R2" | "R3";
export type JobExecutionStateV2 =
  | "NEW"
  | "PLANNING"
  | "WAIT_APPROVAL"
  | "DISPATCHED"
  | "RUNNING"
  | "WAIT_USER"
  | "UNKNOWN"
  | "RECONCILING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface JobLimitsV2 {
  timeoutSeconds: number;
  maxOutputBytes: number;
  cpuMillis: number;
  memoryMiB: number;
}

/** Only `none` is executable in M1; other values are reserved and rejected. */
export interface JobNetworkV2 {
  mode: "none";
  allowedHosts: readonly [];
}

/**
 * `agent` is Friday's general remote runtime. It plans against Hub-owned
 * structured node tools; it is not a synonym for a diagnostic fixture.
 * Codex/Pi/Claude remain optional specialist runtimes for isolated worktrees.
 */
export type JobToolV2 = "agent" | "codex" | "pi" | "claude";

export interface JobSpecV2 {
  protocolVersion: JobProtocolVersion;
  jobId: Uuid;
  idempotencyKey: Uuid;
  runnerId: Uuid;
  workspaceId: string;
  tool: JobToolV2;
  operation: "develop" | "diagnose" | "review" | "test";
  prompt: string;
  risk: JobRiskLevelV2;
  limits: JobLimitsV2;
  network: JobNetworkV2;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
  leaseId: Uuid;
  leaseExpiresAt: IsoDateTime;
  manifestSha256: string;
  hubSignature: string;
}

export interface RunnerPullRequestV2 {
  protocolVersion: JobProtocolVersion;
  requestId: Uuid;
  runnerId: Uuid;
  sentAt: IsoDateTime;
}

export interface RunnerJobEventV2 {
  protocolVersion: JobProtocolVersion;
  eventId: Uuid;
  jobId: Uuid;
  runnerId: Uuid;
  leaseId: Uuid;
  sequence: number;
  sentAt: IsoDateTime;
  type: "state" | "output" | "artifact" | "error";
  state?: JobExecutionStateV2;
  stream?: "stdout" | "stderr" | "log";
  chunk?: string;
  artifact?: RunnerArtifactV1;
  error?: ProtocolErrorV1;
}

export type NodeToolNameV1 =
  | "system.snapshot"
  | "process.list"
  | "service.status"
  | "journal.read"
  | "network.sockets"
  | "file.read"
  | "file.search"
  | "file.write"
  | "file.delete"
  | "process.signal"
  | "service.restart"
  | "command.exec";

/** Untrusted model proposal. Risk and authority are deliberately absent. */
export interface NodeToolCallV1 {
  readonly protocolVersion: JobProtocolVersion;
  readonly callId: Uuid;
  readonly jobId: Uuid;
  readonly runnerId: Uuid;
  readonly leaseId: Uuid;
  readonly name: NodeToolNameV1;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly reason: string;
  readonly requestedAt: IsoDateTime;
}

/**
 * Exact, short-lived authority issued by the Hub after deterministic policy
 * evaluation (and Owner clearance when required). The Runner verifies this
 * signature before invoking a local node tool.
 */
export interface NodeToolAuthorizationV1 {
  readonly protocolVersion: JobProtocolVersion;
  readonly callId: Uuid;
  readonly jobId: Uuid;
  readonly runnerId: Uuid;
  readonly leaseId: Uuid;
  readonly callSha256: string;
  readonly risk: JobRiskLevelV2;
  readonly approvedBy: "policy" | string;
  readonly approvedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly hubSignature: string;
}

export interface NodeToolDecisionV1 {
  readonly status: "APPROVED" | "WAIT_APPROVAL" | "DENIED";
  readonly risk: JobRiskLevelV2;
  readonly background: string;
  readonly authorization?: NodeToolAuthorizationV1;
}

export type RemoteAgentActionV1 =
  | {
      readonly type: "tool_call";
      readonly callId: Uuid;
      readonly name: NodeToolNameV1;
      readonly arguments: Readonly<Record<string, JsonValue>>;
      readonly reason: string;
    }
  | {
      readonly type: "finish";
      readonly summary: string;
    };

export interface RunnerReconcileV2 {
  protocolVersion: JobProtocolVersion;
  jobId: Uuid;
  runnerId: Uuid;
  leaseId: Uuid;
  sentAt: IsoDateTime;
  state: JobExecutionStateV2;
  lastSequence: number;
}

/**
 * A Runner may request model access only after it has received and verified a
 * live Hub-signed JobSpec. The request is itself signed by the enrolled Runner
 * device key; it never contains an upstream endpoint or long-lived API key.
 */
export interface RunnerModelAccessRequestV2 {
  protocolVersion: JobProtocolVersion;
  requestId: Uuid;
  jobId: Uuid;
  runnerId: Uuid;
  leaseId: Uuid;
  tool: JobToolV2;
  sentAt: IsoDateTime;
}

export type RunnerModelProviderV2 = "openai" | "anthropic";

/**
 * Opaque, short-lived authority returned by the Hub. The token is scoped on
 * the Hub to one Job, Runner, lease, tool, provider, and model.
 */
export interface RunnerModelAccessGrantV2 {
  protocolVersion: JobProtocolVersion;
  accessToken: string;
  jobId: Uuid;
  runnerId: Uuid;
  leaseId: Uuid;
  tool: JobToolV2;
  provider: RunnerModelProviderV2;
  model: string;
  expiresAt: IsoDateTime;
}

/** The v2 byte payload keeps method, path, and JSON bytes inseparable. */
export function runnerRequestSignaturePayloadV2(method: string, path: string, body: string): string {
  return `friday-runner-request-v2\n${method.toUpperCase()}\n${path}\n${body}`;
}

/** Stable manifest projection used for the Hub signature and approval binding. */
export function jobManifestProjectionV2(spec: JobSpecV2): Omit<JobSpecV2, "manifestSha256" | "hubSignature"> {
  const { manifestSha256: _digest, hubSignature: _signature, ...projection } = spec;
  return projection;
}

export function nodeToolCallSha256V1(call: NodeToolCallV1): string {
  return createHash("sha256").update(canonicalJsonV2(call as unknown as Record<string, unknown>)).digest("hex");
}

export function nodeToolAuthorizationProjectionV1(value: NodeToolAuthorizationV1): Omit<NodeToolAuthorizationV1, "hubSignature"> {
  const { hubSignature: _signature, ...projection } = value;
  return projection;
}

export function canonicalJsonV2(value: JsonValue | Record<string, unknown>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonV2(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonV2(record[key] as JsonValue)}`).join(",")}}`;
  }
  throw new Error("Cannot canonicalize a non-JSON value");
}
