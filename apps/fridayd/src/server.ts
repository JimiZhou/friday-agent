import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@friday/protocol";
import { JOB_PROTOCOL_VERSION } from "@friday/protocol";
import type { InboundMessageV1, PiWorkerImageV1, RunnerEnvelopeV1, RunnerJobEventV2, RunnerModelAccessRequestV2, RunnerModelProviderV2, RunnerPullRequestV2 } from "@friday/protocol";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as QRCode from "qrcode";
import { validateConfig, type FridayConfig } from "./config.js";
import type { EventStore } from "./event-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import { SqliteRunnerRegistry } from "./runner-registry.js";
import { loadOrCreateHubIdentity, type HubIdentity } from "./hub-identity.js";
import { SqliteJobRegistry, type JobCreateInput } from "./job-registry.js";
import { WebAuthnRegistry } from "./webauthn-registry.js";
import { ChannelIngestRegistry, MemoryRegistry, OpenAiVoiceClient, VoiceMediaRegistry } from "./m2-registry.js";
import { ChannelOutbox, JobChannelNotifier, type OutboundChannel } from "./channel-outbox.js";
import { AdapterRegistry, McpBroker, McpRegistry, ProcedureRegistry, SelfPatchRegistry, SkillRegistry, type AdapterDefinition, type ApprovalRisk, type McpDefinition, type SelfImprovementContext, type SignedProcedure, type SignedSkill } from "./m3-registry.js";
import { invokeMcpBrokerSidecar } from "./mcp-broker-sidecar.js";
import { FridayState, jsonDigest, runnerEnvelopeDigest, type JobView } from "./state.js";
import { JobArtifactStore } from "./job-artifact-store.js";
import { evaluateFleetRunners, requiredAdapter, selectFleetRunner } from "./fleet-scheduler.js";
import { ConversationRegistry, type ConversationJobProposal, type ConversationMessageInput, type ConversationSelfImprovementProposal } from "./conversation-registry.js";
import {
  ConversationMediaRegistry,
  MAX_CONVERSATION_IMAGE_BYTES,
  MAX_CONVERSATION_VIDEO_BYTES,
} from "./conversation-media.js";
import {
  ConversationExecutionError,
  ConversationMessageConflictError,
  ConversationOrchestrator,
  type ConversationAgent,
  type ConversationCapability,
  type ConversationScheduleResult,
  type ConversationToolCall,
  type ConversationToolDefinition,
  type ConversationToolResult,
} from "./conversation-orchestrator.js";
import { PiWorkerProcessClient } from "./pi-worker-client.js";
import { SelfImprovementCoordinator, SelfImprovementJobRegistry, selfImprovementJobPrompt } from "./self-improvement-coordinator.js";
import { FixedWebSearch } from "./web-search.js";
import { ownerPasswordMatches } from "./owner-password.js";
import { RunnerModelAccessBroker, modelProxyResponseHeaders } from "./model-access.js";
import {
  OWNER_WEB_CSS as OWNER_CONSOLE_CSS,
  OWNER_WEB_HTML as OWNER_CONSOLE_HTML,
  OWNER_WEB_SCRIPT as OWNER_CONSOLE_SCRIPT,
} from "./owner-web.js";

interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

const require = createRequire(import.meta.url);
const inboundMessageSchema: object = require("@friday/protocol/schemas/inbound-message.v1.schema.json");
const runnerEnvelopeSchema: object = require("@friday/protocol/schemas/runner-envelope.v1.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: true });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
ajv.addFormat("uuid", { type: "string", validate: (value: string) => uuidPattern.test(value) });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => rfc3339Pattern.test(value) && !Number.isNaN(Date.parse(value)),
});
const validateInboundMessage = ajv.compile<InboundMessageV1>(inboundMessageSchema);
const validateRunnerEnvelope = ajv.compile<RunnerEnvelopeV1>(runnerEnvelopeSchema);

export const RUNNER_SENT_AT_MAX_SKEW_MS = 5 * 60_000;

export function runnerSentAtWithinAllowedSkew(sentAt: string, receivedAt: string): boolean {
  const sentAtMs = Date.parse(sentAt);
  const receivedAtMs = Date.parse(receivedAt);
  return (
    Number.isFinite(sentAtMs) &&
    Number.isFinite(receivedAtMs) &&
    Math.abs(sentAtMs - receivedAtMs) <= RUNNER_SENT_AT_MAX_SKEW_MS
  );
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(encoded);
}

function error(response: ServerResponse, statusCode: number, code: string, message: string): void {
  json(response, statusCode, { error: { code, message } } satisfies ErrorBody);
}

function html(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), geolocation=(), microphone=(self)",
  });
  response.end(body);
}

function staticAsset(response: ServerResponse, contentType: string, body: string): void {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function conversationMediaResponse(
  request: IncomingMessage,
  response: ServerResponse,
  stored: ReturnType<ConversationMediaRegistry["read"]> & {},
): void {
  const baseHeaders = {
    "content-type": stored.media.mimeType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "content-security-policy": "default-src 'none'; sandbox",
  };
  const range = singleHeader(request.headers.range);
  if (range === undefined) {
    response.writeHead(200, { ...baseHeaders, "content-length": stored.bytes.byteLength });
    response.end(stored.bytes);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match === null || (match[1] === "" && match[2] === "")) {
    response.writeHead(416, { ...baseHeaders, "content-range": `bytes */${stored.bytes.byteLength}` });
    response.end();
    return;
  }
  const suffix = match[1] === "" ? Number.parseInt(match[2] as string, 10) : undefined;
  const start = suffix === undefined ? Number.parseInt(match[1] as string, 10) : Math.max(0, stored.bytes.byteLength - suffix);
  const end = suffix === undefined
    ? (match[2] === "" ? stored.bytes.byteLength - 1 : Number.parseInt(match[2] as string, 10))
    : stored.bytes.byteLength - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stored.bytes.byteLength) {
    response.writeHead(416, { ...baseHeaders, "content-range": `bytes */${stored.bytes.byteLength}` });
    response.end();
    return;
  }
  const boundedEnd = Math.min(end, stored.bytes.byteLength - 1);
  const bytes = stored.bytes.subarray(start, boundedEnd + 1);
  response.writeHead(206, {
    ...baseHeaders,
    "content-length": bytes.byteLength,
    "content-range": `bytes ${start}-${boundedEnd}/${stored.bytes.byteLength}`,
  });
  response.end(bytes);
}

function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined || !actual.startsWith("Bearer ")) return false;
  const provided = actual.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strictBase64(value: string): Buffer | undefined {
  if (value.length === 0 || value.length > 16 * 1_048_576 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}

function safeDownloadName(value: string): string { return value.replace(/[\\"\r\n]/g, "_").slice(0, 255) || "artifact"; }

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const source = singleHeader(request.headers.cookie);
  if (source === undefined) return undefined;
  const prefix = `${name}=`;
  for (const segment of source.split(";")) {
    const value = segment.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return undefined;
}

function isStateChanging(method: string): boolean { return method !== "GET" && method !== "HEAD" && method !== "OPTIONS"; }

function setOwnerSessionCookies(response: ServerResponse, session: { readonly token: string; readonly csrfToken: string }): void {
  response.setHeader("set-cookie", [
    `friday_owner=${session.token}; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Strict`,
    `friday_csrf=${session.csrfToken}; Path=/; Max-Age=28800; Secure; SameSite=Strict`,
  ]);
}

function clearOwnerSessionCookies(response: ServerResponse): void {
  response.setHeader("set-cookie", [
    "friday_owner=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict",
    "friday_csrf=; Path=/; Max-Age=0; Secure; SameSite=Strict",
  ]);
}


interface ParsedJsonBody {
  readonly value: unknown;
  readonly raw: string;
}

async function parseJsonBody(request: IncomingMessage, maxBytes: number): Promise<ParsedJsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }

  if (chunks.length === 0) throw new Error("EMPTY_BODY");
  const raw = Buffer.concat(chunks).toString("utf8");
  return { value: JSON.parse(raw) as unknown, raw };
}

async function parseRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("EMPTY_BODY");
  return Buffer.concat(chunks);
}

function parseInboundMessage(value: unknown): InboundMessageV1 | undefined {
  if (!validateInboundMessage(value)) return undefined;
  const message = structuredClone(value as InboundMessageV1);
  message.messageId = message.messageId.toLowerCase();
  if (message.replyTo !== undefined) message.replyTo = message.replyTo.toLowerCase();

  switch (message.content.kind) {
    case "text":
      break;
    case "voice":
      message.content.attachment.attachmentId = message.content.attachment.attachmentId.toLowerCase();
      break;
    case "attachments":
    case "mixed":
      for (const attachment of message.content.attachments) {
        attachment.attachmentId = attachment.attachmentId.toLowerCase();
      }
      break;
  }
  return message;
}

function parseRunnerEnvelope(value: unknown, expectedKind: "register" | "heartbeat"): RunnerEnvelopeV1 | undefined {
  if (!validateRunnerEnvelope(value)) return undefined;
  const envelope = structuredClone(value as RunnerEnvelopeV1);
  envelope.envelopeId = envelope.envelopeId.toLowerCase();
  envelope.runnerId = envelope.runnerId.toLowerCase();
  return envelope.kind === expectedKind ? envelope : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParsedJobCreate = {
  readonly target: { readonly mode: "explicit"; readonly runnerId: string } | { readonly mode: "auto" };
  readonly input: Omit<JobCreateInput, "runnerId">;
};

function parseJobCreate(value: unknown): ParsedJobCreate | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set(["idempotencyKey", "runnerId", "runnerSelector", "workspaceId", "tool", "operation", "prompt", "limits"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  const explicit = typeof value.runnerId === "string" && value.runnerSelector === undefined;
  const automatic = value.runnerId === undefined && value.runnerSelector === "auto";
  if (
    (!explicit && !automatic) ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.workspaceId !== "string" ||
    (!["codex", "pi", "claude", "diagnostic"].includes(value.tool as string)) ||
    !["develop", "diagnose", "review", "test"].includes(value.operation as string) ||
    typeof value.prompt !== "string"
  ) return undefined;
  if (value.limits !== undefined && !isRecord(value.limits)) return undefined;
  const rawLimits = value.limits;
  const limits = rawLimits === undefined ? undefined : {
    ...(typeof rawLimits.timeoutSeconds === "number" ? { timeoutSeconds: rawLimits.timeoutSeconds } : {}),
    ...(typeof rawLimits.maxOutputBytes === "number" ? { maxOutputBytes: rawLimits.maxOutputBytes } : {}),
    ...(typeof rawLimits.cpuMillis === "number" ? { cpuMillis: rawLimits.cpuMillis } : {}),
    ...(typeof rawLimits.memoryMiB === "number" ? { memoryMiB: rawLimits.memoryMiB } : {}),
  };
  if (rawLimits !== undefined && Object.keys(rawLimits).length !== Object.keys(limits ?? {}).length) return undefined;
  return {
    target: explicit
      ? { mode: "explicit", runnerId: (value.runnerId as string).toLowerCase() }
      : { mode: "auto" },
    input: { idempotencyKey: value.idempotencyKey, workspaceId: value.workspaceId, tool: value.tool as JobCreateInput["tool"], operation: value.operation as JobCreateInput["operation"], prompt: value.prompt, ...(limits === undefined ? {} : { limits }) },
  };
}

function parseRunnerPull(value: unknown, expectedRunnerId: string): RunnerPullRequestV2 | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 4) return undefined;
  if (value.protocolVersion !== JOB_PROTOCOL_VERSION || typeof value.requestId !== "string" || typeof value.runnerId !== "string" || typeof value.sentAt !== "string") return undefined;
  if (!uuidPattern.test(value.requestId) || !uuidPattern.test(value.runnerId) || value.runnerId.toLowerCase() !== expectedRunnerId || !rfc3339Pattern.test(value.sentAt)) return undefined;
  return { protocolVersion: JOB_PROTOCOL_VERSION, requestId: value.requestId.toLowerCase(), runnerId: expectedRunnerId, sentAt: value.sentAt };
}

function parseRunnerJobEvent(value: unknown, expectedRunnerId: string, expectedJobId: string): RunnerJobEventV2 | undefined {
  if (!isRecord(value)) return undefined;
  const event = value as Partial<RunnerJobEventV2>;
  if (
    event.protocolVersion !== JOB_PROTOCOL_VERSION ||
    typeof event.eventId !== "string" ||
    typeof event.jobId !== "string" ||
    typeof event.runnerId !== "string" ||
    typeof event.leaseId !== "string" ||
    !Number.isSafeInteger(event.sequence) ||
    typeof event.sentAt !== "string" ||
    !["state", "output", "artifact", "error"].includes(event.type as string) ||
    !uuidPattern.test(event.eventId) || !uuidPattern.test(event.jobId) || !uuidPattern.test(event.runnerId) || !uuidPattern.test(event.leaseId) ||
    event.jobId.toLowerCase() !== expectedJobId || event.runnerId.toLowerCase() !== expectedRunnerId || !rfc3339Pattern.test(event.sentAt)
  ) return undefined;
  return structuredClone({ ...event, eventId: event.eventId.toLowerCase(), jobId: expectedJobId, runnerId: expectedRunnerId }) as RunnerJobEventV2;
}

interface RunnerEnrollmentRequest {
  readonly protocolVersion: "1";
  readonly runnerId: string;
  readonly enrollmentToken: string;
  readonly publicKeyPem: string;
}

function parseRunnerEnrollment(value: unknown): RunnerEnrollmentRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["enrollmentToken", "protocolVersion", "publicKeyPem", "runnerId"];
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return undefined;
  if (
    record.protocolVersion !== PROTOCOL_VERSION ||
    typeof record.runnerId !== "string" ||
    !uuidPattern.test(record.runnerId) ||
    typeof record.enrollmentToken !== "string" ||
    typeof record.publicKeyPem !== "string"
  ) {
    return undefined;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    runnerId: record.runnerId.toLowerCase(),
    enrollmentToken: record.enrollmentToken,
    publicKeyPem: record.publicKeyPem,
  };
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function parseConversationMessage(
  value: unknown,
  conversationId: string,
  mediaRegistry: ConversationMediaRegistry,
): ConversationMessageInput | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  const expected = value.mediaIds === undefined
    ? ["channel", "messageId", "text"]
    : ["channel", "mediaIds", "messageId", "text"];
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return undefined;
  if (
    typeof value.messageId !== "string" ||
    !uuidPattern.test(value.messageId) ||
    (value.channel !== "web" && value.channel !== "telegram" && value.channel !== "wechat_ilink" && value.channel !== "voice") ||
    typeof value.text !== "string" ||
    (value.mediaIds !== undefined && (!Array.isArray(value.mediaIds) || value.mediaIds.some((id) => typeof id !== "string")))
  ) return undefined;
  let attachments;
  try { attachments = value.mediaIds === undefined ? [] : mediaRegistry.resolve(value.mediaIds as string[]); } catch { return undefined; }
  if (value.text.trim() === "" && attachments.length === 0) return undefined;
  return {
    conversationId,
    messageId: value.messageId.toLowerCase(),
    channel: value.channel,
    text: value.text,
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

function parseSelfImprovementCreate(value: unknown): {
  readonly id: string;
  readonly branch: string;
  readonly patch: string;
  readonly context: SelfImprovementContext;
} | undefined {
  if (!isRecord(value)) return undefined;
  const expected = ["background", "branch", "category", "expectedBenefit", "id", "patch", "requestedActions", "riskSummary", "rollbackPlan", "title"];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.patch !== "string" ||
    (value.category !== "pi_upgrade" && value.category !== "architecture" && value.category !== "capability" && value.category !== "security" && value.category !== "dependency") ||
    typeof value.title !== "string" ||
    typeof value.background !== "string" ||
    typeof value.expectedBenefit !== "string" ||
    typeof value.riskSummary !== "string" ||
    typeof value.rollbackPlan !== "string" ||
    !Array.isArray(value.requestedActions) ||
    value.requestedActions.some((action) => typeof action !== "string")
  ) return undefined;
  return {
    id: value.id,
    branch: value.branch,
    patch: value.patch,
    context: {
      category: value.category,
      title: value.title,
      background: value.background,
      expectedBenefit: value.expectedBenefit,
      riskSummary: value.riskSummary,
      rollbackPlan: value.rollbackPlan,
      requestedActions: value.requestedActions as SelfImprovementContext["requestedActions"],
    },
  };
}

function parseSelfImprovementJobCreate(value: unknown): {
  readonly improvementId: string;
  readonly context: SelfImprovementContext;
  readonly input: Omit<JobCreateInput, "runnerId">;
} | undefined {
  if (!isRecord(value)) return undefined;
  const required = ["background", "category", "expectedBenefit", "idempotencyKey", "improvementId", "prompt", "requestedActions", "riskSummary", "rollbackPlan", "runnerSelector", "title", "tool", "workspaceId"];
  const allowed = new Set([...required, "limits"]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    value.runnerSelector !== "auto" ||
    typeof value.improvementId !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.workspaceId !== "string" ||
    (value.tool !== "codex" && value.tool !== "pi" && value.tool !== "claude") ||
    typeof value.prompt !== "string" ||
    (value.category !== "pi_upgrade" && value.category !== "architecture" && value.category !== "capability" && value.category !== "security" && value.category !== "dependency") ||
    typeof value.title !== "string" ||
    typeof value.background !== "string" ||
    typeof value.expectedBenefit !== "string" ||
    typeof value.riskSummary !== "string" ||
    typeof value.rollbackPlan !== "string" ||
    !Array.isArray(value.requestedActions) || value.requestedActions.some((action) => typeof action !== "string")
  ) return undefined;
  const context: SelfImprovementContext = {
    category: value.category,
    title: value.title,
    background: value.background,
    expectedBenefit: value.expectedBenefit,
    riskSummary: value.riskSummary,
    rollbackPlan: value.rollbackPlan,
    requestedActions: value.requestedActions as SelfImprovementContext["requestedActions"],
  };
  let prompt: string;
  try { prompt = selfImprovementJobPrompt(value.improvementId, context, value.prompt); } catch { return undefined; }
  const parsedJob = parseJobCreate({
    idempotencyKey: value.idempotencyKey,
    runnerSelector: "auto",
    workspaceId: value.workspaceId,
    tool: value.tool,
    operation: "develop",
    prompt,
    ...(value.limits === undefined ? {} : { limits: value.limits }),
  });
  if (parsedJob === undefined) return undefined;
  return { improvementId: value.improvementId, context, input: parsedJob.input };
}

function conversationAgentFromConfig(config: FridayConfig): ConversationAgent | undefined {
  const agent = config.conversationAgent;
  if (agent === undefined) return undefined;
  return new PiWorkerProcessClient({
    nodeExecutable: agent.nodeExecutable,
    workerScriptPath: agent.workerScriptPath,
    workerEnvironment: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      FRIDAY_PI_BIN: agent.piBin,
      FRIDAY_PI_BASE_URL: agent.baseUrl.toString(),
      FRIDAY_PI_MODEL: agent.model,
      FRIDAY_PI_API_KEY: agent.apiKey,
    },
    requestTimeoutMs: agent.requestTimeoutMs,
    turnTimeoutMs: agent.turnTimeoutMs,
    onDiagnostic: (message) => console.error(JSON.stringify({ level: "warn", event: "pi-worker.diagnostic", message })),
  });
}

export interface FridayServerOptions {
  /** Test/host injection point; null explicitly keeps the Agent disabled. */
  readonly conversationAgent?: ConversationAgent | null;
}

export interface FridayServer {
  readonly server: Server;
  readonly store: EventStore;
  readonly runnerRegistry: SqliteRunnerRegistry;
  readonly jobRegistry: SqliteJobRegistry;
  readonly mcpRegistry: McpRegistry;
  readonly adapterRegistry: AdapterRegistry;
  readonly procedureRegistry?: ProcedureRegistry;
  readonly skillRegistry?: SkillRegistry;
  readonly selfPatchRegistry: SelfPatchRegistry;
  readonly selfImprovementJobRegistry: SelfImprovementJobRegistry;
  readonly voiceMediaRegistry: VoiceMediaRegistry;
  readonly conversationMediaRegistry: ConversationMediaRegistry;
  readonly conversationRegistry: ConversationRegistry;
  readonly channelOutbox: ChannelOutbox;
  readonly modelAccessBroker?: RunnerModelAccessBroker;
  readonly artifactStore: JobArtifactStore;
  readonly hubIdentity: HubIdentity;
  readonly state: FridayState;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export async function createFridayServer(config: FridayConfig, options: FridayServerOptions = {}): Promise<FridayServer> {
  validateConfig(config);
  const selfImprovementWorkspaceId = config.selfImprovementWorkspaceId ?? "friday-agent";
  const databasePath = join(config.stateDir, "friday.sqlite");
  const store = new SqliteEventStore(
    databasePath,
    join(config.stateDir, "events.jsonl"),
  );
  await store.open();
  const runnerRegistry = new SqliteRunnerRegistry(databasePath);
  const hubIdentity = await loadOrCreateHubIdentity(config.stateDir);
  const jobRegistry = new SqliteJobRegistry(databasePath, hubIdentity);
  const modelAccessBroker = config.runnerModelProxy === undefined ? undefined : new RunnerModelAccessBroker(config.runnerModelProxy, jobRegistry);
  const memoryRegistry = new MemoryRegistry(databasePath);
  const channelRegistry = new ChannelIngestRegistry(databasePath);
  const channelOutbox = new ChannelOutbox(databasePath);
  const voiceMediaRegistry = new VoiceMediaRegistry(databasePath, join(config.stateDir, "voice-media"));
  const conversationMediaRegistry = new ConversationMediaRegistry(databasePath, join(config.stateDir, "conversation-media"));
  const conversationRegistry = new ConversationRegistry(databasePath);
  const artifactStore = new JobArtifactStore(config.stateDir);
  const voiceClient = config.voiceProvider === undefined ? undefined : new OpenAiVoiceClient(config.voiceProvider);
  const mcpRegistry = new McpRegistry(databasePath);
  const mcpBroker = new McpBroker(mcpRegistry);
  const adapterRegistry = new AdapterRegistry(databasePath);
  const selfPatchRegistry = new SelfPatchRegistry(databasePath);
  const selfImprovementJobRegistry = new SelfImprovementJobRegistry(databasePath);
  const procedureRegistry = config.procedureOwnerPublicKeyPem === undefined ? undefined : new ProcedureRegistry(databasePath, config.procedureOwnerPublicKeyPem);
  const skillRegistry = config.skillOwnerPublicKeyPem === undefined ? undefined : new SkillRegistry(databasePath, config.skillOwnerPublicKeyPem);
  const webauthnRegistry = config.publicOrigin === undefined ? undefined : new WebAuthnRegistry(databasePath, { ownerId: config.ownerId, origin: config.publicOrigin, rpId: config.webauthnRpId ?? new URL(config.publicOrigin).hostname });
  try {
    runnerRegistry.open();
    jobRegistry.open();
    memoryRegistry.open();
    channelRegistry.open();
    channelOutbox.open();
    voiceMediaRegistry.open();
    conversationMediaRegistry.open();
    conversationRegistry.open();
    mcpRegistry.open();
    adapterRegistry.open();
    selfPatchRegistry.open();
    selfImprovementJobRegistry.open();
    procedureRegistry?.open();
    skillRegistry?.open();
    webauthnRegistry?.open();
  } catch (caught) {
    webauthnRegistry?.close();
    channelOutbox.close();
    channelRegistry.close();
    voiceMediaRegistry.close();
    conversationMediaRegistry.close();
    conversationRegistry.close();
    memoryRegistry.close();
    procedureRegistry?.close();
    skillRegistry?.close();
    selfPatchRegistry.close();
    selfImprovementJobRegistry.close();
    mcpRegistry.close();
    adapterRegistry.close();
    jobRegistry.close();
    runnerRegistry.close();
    await store.close();
    throw caught;
  }
  const state = new FridayState();
  try {
    state.rehydrate(store.list());
  } catch (caught) {
    webauthnRegistry?.close();
    channelOutbox.close();
    channelRegistry.close();
    voiceMediaRegistry.close();
    conversationMediaRegistry.close();
    conversationRegistry.close();
    memoryRegistry.close();
    procedureRegistry?.close();
    skillRegistry?.close();
    selfPatchRegistry.close();
    selfImprovementJobRegistry.close();
    mcpRegistry.close();
    adapterRegistry.close();
    jobRegistry.close();
    runnerRegistry.close();
    await store.close();
    throw caught;
  }
  const selfImprovementCoordinator = new SelfImprovementCoordinator(
    selfImprovementJobRegistry,
    jobRegistry,
    artifactStore,
    selfPatchRegistry,
    (message) => console.error(JSON.stringify({ level: "warn", event: "self-improvement.promotion", message })),
  );
  await selfImprovementCoordinator.reconcile();
  const jobChannelNotifier = new JobChannelNotifier(channelOutbox, jobRegistry);
  jobChannelNotifier.reconcile();
  const conversationAgent = options.conversationAgent === null
    ? undefined
    : options.conversationAgent ?? conversationAgentFromConfig(config);
  const webSearch = config.webSearchEnabled === true ? new FixedWebSearch() : undefined;
  const passwordFailures = new Map<string, { readonly windowStartedAt: number; readonly failures: number }>();

  function passwordLoginKey(request: IncomingMessage): string {
    return request.socket.remoteAddress ?? "unknown";
  }

  function passwordLoginAllowed(key: string, now = Date.now()): boolean {
    const state = passwordFailures.get(key);
    if (state === undefined || now - state.windowStartedAt >= 10 * 60_000) {
      passwordFailures.delete(key);
      return true;
    }
    return state.failures < 5;
  }

  function recordPasswordFailure(key: string, now = Date.now()): void {
    const state = passwordFailures.get(key);
    if (state === undefined || now - state.windowStartedAt >= 10 * 60_000) {
      passwordFailures.set(key, { windowStartedAt: now, failures: 1 });
      return;
    }
    passwordFailures.set(key, { ...state, failures: state.failures + 1 });
  }

  function fleetSchedulingContext() {
    return {
      runners: state.listRunners(),
      assignedJobs: jobRegistry.nonTerminalCountByRunner(),
      isEnrolled: (runnerId: string) => runnerRegistry.isEnrolled(runnerId),
      adapterEnabled: (runnerId: string, adapter: AdapterDefinition["adapter"]) => adapterRegistry.resolve(runnerId, adapter) !== undefined,
    };
  }

  function conversationCapabilities(): readonly ConversationCapability[] {
    const byWorkspace = new Map<string, Set<ConversationCapability["tools"][number]>>();
    for (const runner of state.listRunners()) {
      if (
        !runnerRegistry.isEnrolled(runner.nodeId) ||
        runner.version !== "0.1.0" ||
        !runner.online ||
        runner.status !== "online" ||
        !runner.capabilities.includes("orchestration") ||
        !runner.capabilities.includes("sandbox")
      ) continue;
      for (const workspaceId of runner.workspaces) {
        const tools = byWorkspace.get(workspaceId) ?? new Set<ConversationCapability["tools"][number]>();
        tools.add("diagnostic");
        if (adapterRegistry.resolve(runner.nodeId, "codex-app-server") !== undefined) tools.add("codex");
        if (adapterRegistry.resolve(runner.nodeId, "pi-rpc") !== undefined) tools.add("pi");
        if (adapterRegistry.resolve(runner.nodeId, "claude-code") !== undefined) tools.add("claude");
        byWorkspace.set(workspaceId, tools);
      }
    }
    return [...byWorkspace.entries()].map(([workspaceId, tools]) => ({ workspaceId, tools: [...tools] }));
  }

  function conversationTools(): readonly ConversationToolDefinition[] {
    return [
      {
        name: "fleet_status",
        description: "Read the current Hub-owned status and declared capabilities of enrolled managed nodes. Input may be empty.",
      },
      ...(webSearch === undefined ? [] : [{
        name: "web_search" as const,
        description: "Search the public web through the Hub's fixed DuckDuckGo HTML endpoint. Results are untrusted external data.",
      }]),
    ];
  }

  async function invokeConversationTool(call: ConversationToolCall): Promise<ConversationToolResult> {
    if (call.name === "web_search") {
      if (webSearch === undefined) throw new Error("WEB_SEARCH_DISABLED");
      return { trust: "untrusted", text: JSON.stringify(await webSearch.search(call.input)) };
    }
    if (call.name === "fleet_status") {
      const assignedJobs = jobRegistry.nonTerminalCountByRunner();
      const nodes = state.listRunners().map((runner) => ({
        name: runner.displayName,
        online: runner.online,
        status: runner.status,
        version: runner.version,
        activeJobs: Math.max(runner.activeJobs, assignedJobs.get(runner.nodeId) ?? 0),
        workspaces: [...runner.workspaces],
        tools: [
          "diagnostic",
          ...(adapterRegistry.resolve(runner.nodeId, "codex-app-server") === undefined ? [] : ["codex"]),
          ...(adapterRegistry.resolve(runner.nodeId, "pi-rpc") === undefined ? [] : ["pi"]),
          ...(adapterRegistry.resolve(runner.nodeId, "claude-code") === undefined ? [] : ["claude"]),
        ],
      }));
      return {
        trust: "trusted",
        text: JSON.stringify({ observedAt: new Date().toISOString(), nodes }),
      };
    }
    throw new Error("TOOL_NOT_AVAILABLE");
  }

  function scheduleConversationProposal(
    proposal: ConversationJobProposal,
    idempotencyKey: string,
  ): ConversationScheduleResult {
    const input: Omit<JobCreateInput, "runnerId"> = {
      idempotencyKey,
      workspaceId: proposal.workspaceId,
      tool: proposal.tool,
      operation: proposal.operation,
      prompt: proposal.prompt,
    };
    try {
      const idempotency = jobRegistry.resolveIdempotency(input);
      if (idempotency.outcome === "conflict") {
        return { outcome: "rejected", code: "JOB_IDEMPOTENCY_CONFLICT", message: "Turn id is already bound to a different Job request" };
      }
      if (idempotency.outcome === "duplicate") return { outcome: "created", job: idempotency.job };
      const selection = selectFleetRunner(
        { workspaceId: proposal.workspaceId, tool: proposal.tool },
        fleetSchedulingContext(),
      );
      if (selection === undefined) {
        return { outcome: "rejected", code: "NO_COMPATIBLE_RUNNER", message: "No online enrolled Runner matches this proposal" };
      }
      const result = jobRegistry.create({ ...input, runnerId: selection.runnerId });
      return { outcome: "created", job: result.job };
    } catch {
      return { outcome: "rejected", code: "JOB_PROPOSAL_REJECTED", message: "The Hub rejected the proposed Job" };
    }
  }

  function scheduleConversationSelfImprovement(
    proposal: ConversationSelfImprovementProposal,
    idempotencyKey: string,
  ): ConversationScheduleResult {
    if (proposal.workspaceId !== selfImprovementWorkspaceId) {
      return { outcome: "rejected", code: "SELF_IMPROVEMENT_WORKSPACE_REJECTED", message: "The proposal does not target the configured Friday source workspace" };
    }
    const improvementId = `agent-${idempotencyKey.replaceAll("-", "")}`;
    const context: SelfImprovementContext = {
      category: proposal.category,
      title: proposal.title,
      background: proposal.background,
      expectedBenefit: proposal.expectedBenefit,
      riskSummary: proposal.riskSummary,
      rollbackPlan: proposal.rollbackPlan,
      requestedActions: proposal.requestedActions,
    };
    let prompt: string;
    try { prompt = selfImprovementJobPrompt(improvementId, context, proposal.prompt); } catch {
      return { outcome: "rejected", code: "SELF_IMPROVEMENT_PROPOSAL_REJECTED", message: "The Hub rejected the self improvement context" };
    }
    const input: Omit<JobCreateInput, "runnerId"> = {
      idempotencyKey,
      workspaceId: proposal.workspaceId,
      tool: proposal.tool,
      operation: "develop",
      prompt,
    };
    try {
      const idempotency = jobRegistry.resolveIdempotency(input);
      if (idempotency.outcome === "conflict") return { outcome: "rejected", code: "JOB_IDEMPOTENCY_CONFLICT", message: "Turn id is already bound to a different Job request" };
      if (idempotency.outcome === "duplicate") {
        selfImprovementJobRegistry.register(idempotency.job, improvementId, context);
        return { outcome: "created", job: idempotency.job };
      }
      if (selfPatchRegistry.get(improvementId) !== undefined) return { outcome: "rejected", code: "SELF_IMPROVEMENT_ID_CONFLICT", message: "The derived improvement id is already registered" };
      const selection = selectFleetRunner({ workspaceId: proposal.workspaceId, tool: proposal.tool }, fleetSchedulingContext());
      if (selection === undefined) return { outcome: "rejected", code: "NO_COMPATIBLE_RUNNER", message: "No online enrolled Runner matches this self improvement proposal" };
      const result = jobRegistry.create({ ...input, runnerId: selection.runnerId });
      selfImprovementJobRegistry.register(result.job, improvementId, context);
      return { outcome: "created", job: result.job };
    } catch {
      return { outcome: "rejected", code: "SELF_IMPROVEMENT_JOB_REJECTED", message: "The Hub rejected the self improvement Job" };
    }
  }

  const conversationOrchestrator = conversationAgent === undefined ? undefined : new ConversationOrchestrator({
    registry: conversationRegistry,
    agent: conversationAgent,
    capabilities: conversationCapabilities,
    schedule: scheduleConversationProposal,
    scheduleSelfImprovement: scheduleConversationSelfImprovement,
    selfImprovementWorkspaceId,
    tools: conversationTools,
    invokeTool: invokeConversationTool,
    loadImages: (input) => (input.attachments ?? []).flatMap((attachment): PiWorkerImageV1[] => {
      if (attachment.kind !== "image") return [];
      const stored = conversationMediaRegistry.read(attachment.id);
      if (stored === undefined || stored.media.sha256 !== attachment.sha256 || stored.media.mimeType !== attachment.mimeType) {
        throw new Error("Conversation image is unavailable or failed integrity validation");
      }
      return [{
        type: "image",
        data: stored.bytes.toString("base64"),
        mimeType: stored.media.mimeType as PiWorkerImageV1["mimeType"],
      }];
    }),
  });
  let mutationBarrier: Promise<void> = Promise.resolve();

  async function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationBarrier.then(operation);
    mutationBarrier = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function ownerAuthorized(request: IncomingMessage, method: string): boolean {
    if (tokenMatches(config.ownerToken, request.headers.authorization)) return true;
    if (webauthnRegistry === undefined) return false;
    if (isStateChanging(method) && singleHeader(request.headers.origin) !== config.publicOrigin) return false;
    return webauthnRegistry.validateSession(
      cookieValue(request, "friday_owner"),
      singleHeader(request.headers["x-friday-csrf"]),
      isStateChanging(method),
    );
  }

  function clearanceAuthorized(request: IncomingMessage, method: string): boolean {
    // A local-only deployment may use its high-entropy Owner token. Once the
    // Web console is configured, R2/R3 grants require a browser Owner session
    // plus CSRF/Origin checks; bearer fallback is intentionally not accepted.
    if (webauthnRegistry === undefined) return tokenMatches(config.ownerToken, request.headers.authorization);
    if (singleHeader(request.headers.origin) !== config.publicOrigin) return false;
    return webauthnRegistry.validateSession(
      cookieValue(request, "friday_owner"),
      singleHeader(request.headers["x-friday-csrf"]),
      isStateChanging(method),
    );
  }

  async function channelGatewayRequest(pathname: string, init?: RequestInit): Promise<Record<string, unknown>> {
    if (config.channelGateway === undefined) throw new Error("CHANNEL_GATEWAY_DISABLED");
    const response = await fetch(new URL(pathname.replace(/^\//, ""), config.channelGateway.controlUrl), {
      ...init,
      redirect: "error",
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${config.channelGateway.controlToken}`,
      },
      signal: AbortSignal.timeout(45_000),
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("CHANNEL_GATEWAY_INVALID_RESPONSE");
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; } catch { throw new Error("CHANNEL_GATEWAY_INVALID_RESPONSE"); }
    if (!response.ok || !isRecord(value)) throw new Error(`CHANNEL_GATEWAY_${response.status}`);
    return value;
  }

  function pairConfirmedIlink(value: Record<string, unknown>): void {
    if ((value.connected === true || value.status === "confirmed") && typeof value.userId === "string") {
      channelRegistry.pair("wechat_ilink", value.userId);
    }
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");
      if (method === "GET" && url.pathname === "/health") {
        json(response, 200, {
          status: "ok",
          service: "fridayd",
          version: "0.1.1",
          protocolVersion: PROTOCOL_VERSION,
        });
        return;
      }

      const isRunnerRegistration = method === "POST" && url.pathname === "/v1/runners/register";
      const isRunnerHeartbeat =
        method === "POST" && /^\/v1\/runners\/[^/]+\/heartbeat$/.test(url.pathname);
      const isRunnerEnrollment = method === "POST" && url.pathname === "/v1/runners/enroll";
      const isRunnerV2 = method === "POST" && /^\/v2\/runners\/[0-9a-f-]+(?:\/pull|\/jobs\/[0-9a-f-]+\/(?:events|reconcile|model-access|artifacts\/[0-9a-f-]+))$/i.test(url.pathname);
      const isModelProxy = method === "POST" && /^\/v2\/model-proxy\/(?:openai|anthropic)\/v1\/(?:responses(?:\/compact)?|chat\/completions|messages(?:\/count_tokens)?)$/.test(url.pathname);
      const isHubKey = method === "GET" && url.pathname === "/v2/hub-key";
      const isWebAuthnBootstrapContinue = method === "POST" && ["/v2/auth/register/options", "/v2/auth/register/verify"].includes(url.pathname);
      const isWebAuthnLogin = method === "POST" && ["/v2/auth/login/options", "/v2/auth/login/verify"].includes(url.pathname);
      const isPasswordLogin = method === "POST" && url.pathname === "/v2/auth/login";
      const isAuthStatus = method === "GET" && url.pathname === "/v2/auth/status";
      const isPublicWeb = method === "GET" && (url.pathname === "/" || url.pathname === "/app");
      const isPublicWebAsset = method === "GET" && (url.pathname === "/assets/friday.css" || url.pathname === "/assets/friday.js");
      const isChannelInbound = method === "POST" && url.pathname === "/v2/inbound";
      const isChannelOutbox = /^\/v2\/channels\/(telegram|wechat_ilink)\/outbox(?:\/[0-9a-f-]+\/ack)?$/i.test(url.pathname) && (method === "GET" || method === "POST");
      if (
        !isRunnerRegistration &&
        !isRunnerHeartbeat &&
        !isRunnerEnrollment &&
        !isRunnerV2 &&
        !isModelProxy &&
        !isHubKey &&
        !isWebAuthnBootstrapContinue &&
        !isWebAuthnLogin &&
        !isPasswordLogin &&
        !isAuthStatus &&
        !isPublicWeb &&
        !isPublicWebAsset &&
        !isChannelInbound &&
        !isChannelOutbox &&
        !ownerAuthorized(request, method)
      ) {
        error(response, 401, "UNAUTHORIZED", "A valid bearer token is required");
        return;
      }

      if (isPublicWeb) {
        if (webauthnRegistry === undefined) { error(response, 503, "WEB_DISABLED", "Set FRIDAY_PUBLIC_ORIGIN to enable Owner Web"); return; }
        html(response, 200, OWNER_CONSOLE_HTML);
        return;
      }

      if (isPublicWebAsset) {
        if (webauthnRegistry === undefined) { error(response, 503, "WEB_DISABLED", "Set FRIDAY_PUBLIC_ORIGIN to enable Owner Web"); return; }
        if (url.pathname.endsWith(".css")) staticAsset(response, "text/css; charset=utf-8", OWNER_CONSOLE_CSS);
        else staticAsset(response, "text/javascript; charset=utf-8", OWNER_CONSOLE_SCRIPT);
        return;
      }

      if (isAuthStatus) {
        const authenticated = webauthnRegistry?.validateSession(cookieValue(request, "friday_owner"), undefined, false) === true;
        json(response, 200, {
          authenticated,
          passwordEnabled: config.webPassword !== undefined,
          passkeyConfigured: (webauthnRegistry?.credentialCount() ?? 0) > 0,
        });
        return;
      }

      if (isPasswordLogin) {
        if (webauthnRegistry === undefined || config.webPassword === undefined) {
          error(response, 503, "PASSWORD_LOGIN_DISABLED", "Web password login is not configured");
          return;
        }
        if (singleHeader(request.headers.origin) !== config.publicOrigin) {
          error(response, 403, "LOGIN_ORIGIN_REQUIRED", "Login requires the configured HTTPS Origin");
          return;
        }
        const key = passwordLoginKey(request);
        if (!passwordLoginAllowed(key)) {
          response.setHeader("retry-after", "600");
          error(response, 429, "LOGIN_RATE_LIMITED", "Too many failed login attempts; try again later");
          return;
        }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const validBody = isRecord(body.value) && Object.keys(body.value).length === 1 && typeof body.value.password === "string";
        if (!validBody || !ownerPasswordMatches(config.webPassword, body.value.password as string)) {
          recordPasswordFailure(key);
          error(response, 401, "LOGIN_REJECTED", "Password login was rejected");
          return;
        }
        passwordFailures.delete(key);
        const session = webauthnRegistry.issueSession();
        setOwnerSessionCookies(response, session);
        json(response, 200, { authenticated: true, expiresAt: session.expiresAt });
        return;
      }

      if (method === "GET" && url.pathname === "/v4/channels/wechat-ilink/status") {
        if (config.channelGateway === undefined) { json(response, 200, { configured: false, connected: false, status: "disabled" }); return; }
        try {
          const result = await channelGatewayRequest("/v1/wechat-ilink/status");
          pairConfirmedIlink(result);
          json(response, 200, { configured: true, ...result });
        } catch {
          error(response, 502, "CHANNEL_GATEWAY_UNAVAILABLE", "The isolated Channel Gateway is unavailable");
        }
        return;
      }

      if (method === "POST" && url.pathname === "/v4/channels/wechat-ilink/login") {
        if (config.channelGateway === undefined) { error(response, 503, "CHANNEL_GATEWAY_DISABLED", "The isolated Channel Gateway is not configured"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_ILINK_LOGIN", "Body must be an empty JSON object"); return; }
        try {
          const result = await channelGatewayRequest("/v1/wechat-ilink/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          if (typeof result.qrcodeUrl !== "string" || result.qrcodeUrl.length === 0 || Buffer.byteLength(result.qrcodeUrl, "utf8") > 16 * 1024) throw new Error("CHANNEL_GATEWAY_INVALID_RESPONSE");
          const qrDataUrl = await QRCode.toDataURL(result.qrcodeUrl, { errorCorrectionLevel: "M", margin: 2, width: 320 });
          const { qrcodeUrl: _privateQrContent, ...publicResult } = result;
          json(response, 201, { ...publicResult, qrDataUrl });
        } catch {
          error(response, 502, "ILINK_LOGIN_UNAVAILABLE", "Friday could not start WeChat iLink pairing");
        }
        return;
      }

      const ilinkLoginMatch = url.pathname.match(/^\/v4\/channels\/wechat-ilink\/login\/([0-9a-f-]+)$/i);
      if (method === "GET" && ilinkLoginMatch?.[1] !== undefined) {
        if (config.channelGateway === undefined) { error(response, 503, "CHANNEL_GATEWAY_DISABLED", "The isolated Channel Gateway is not configured"); return; }
        try {
          const result = await channelGatewayRequest(`/v1/wechat-ilink/login/${ilinkLoginMatch[1]}`);
          pairConfirmedIlink(result);
          const { qrcodeUrl: _privateQrContent, ...publicResult } = result;
          json(response, 200, publicResult);
        } catch {
          error(response, 502, "ILINK_LOGIN_UNAVAILABLE", "Friday could not read WeChat iLink pairing status");
        }
        return;
      }

      const ilinkVerifyMatch = url.pathname.match(/^\/v4\/channels\/wechat-ilink\/login\/([0-9a-f-]+)\/verify$/i);
      if (method === "POST" && ilinkVerifyMatch?.[1] !== undefined) {
        if (config.channelGateway === undefined) { error(response, 503, "CHANNEL_GATEWAY_DISABLED", "The isolated Channel Gateway is not configured"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.code !== "string" || !/^\d{1,12}$/.test(body.value.code)) { error(response, 400, "INVALID_ILINK_VERIFY_CODE", "A numeric verification code is required"); return; }
        try {
          const result = await channelGatewayRequest(`/v1/wechat-ilink/login/${ilinkVerifyMatch[1]}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: body.value.code }) });
          const { qrcodeUrl: _privateQrContent, ...publicResult } = result;
          json(response, 202, publicResult);
        } catch {
          error(response, 502, "ILINK_VERIFY_UNAVAILABLE", "Friday could not submit the WeChat verification code");
        }
        return;
      }

      if (method === "GET" && url.pathname === "/v4/conversations") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          error(response, 400, "INVALID_CONVERSATION_LIMIT", "Conversation limit must be between 1 and 200");
          return;
        }
        json(response, 200, { conversations: conversationRegistry.listConversations(limit) });
        return;
      }

      if (method === "POST" && url.pathname === "/v4/media") {
        const mimeType = singleHeader(request.headers["content-type"])?.split(";", 1)[0]?.toLowerCase();
        const ttl = Number.parseInt(singleHeader(request.headers["x-friday-media-ttl-seconds"]) ?? "86400", 10);
        const sourceMediaId = singleHeader(request.headers["x-friday-source-media-id"])?.toLowerCase();
        const maximum = mimeType?.startsWith("image/")
          ? MAX_CONVERSATION_IMAGE_BYTES
          : mimeType?.startsWith("video/")
            ? MAX_CONVERSATION_VIDEO_BYTES
            : undefined;
        if (
          mimeType === undefined || maximum === undefined || !Number.isSafeInteger(ttl) ||
          (sourceMediaId !== undefined && !/^[a-f0-9]{32}$/.test(sourceMediaId))
        ) {
          error(response, 400, "INVALID_CONVERSATION_MEDIA", "Choose a supported image or short video file");
          return;
        }
        try {
          const media = conversationMediaRegistry.save(await parseRawBody(request, maximum), mimeType, ttl, sourceMediaId);
          json(response, 201, { media });
        } catch {
          error(response, 400, "INVALID_CONVERSATION_MEDIA", "The image or short video is unsupported, expired, or too large");
        }
        return;
      }

      const conversationMediaMatch = url.pathname.match(/^\/v4\/media\/([a-f0-9]{32})$/i);
      if (method === "GET" && conversationMediaMatch?.[1] !== undefined) {
        const stored = conversationMediaRegistry.read(conversationMediaMatch[1].toLowerCase());
        if (stored === undefined) { error(response, 404, "CONVERSATION_MEDIA_NOT_FOUND", "The image or video is unavailable or expired"); return; }
        conversationMediaResponse(request, response, stored);
        return;
      }
      if (method === "DELETE" && conversationMediaMatch?.[1] !== undefined) {
        json(response, 200, { deleted: conversationMediaRegistry.remove(conversationMediaMatch[1].toLowerCase()) });
        return;
      }

      const conversationTurnsMatch = url.pathname.match(/^\/v4\/conversations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/turns$/);
      if (method === "GET" && conversationTurnsMatch?.[1] !== undefined) {
        const conversation = conversationRegistry.getConversation(conversationTurnsMatch[1]);
        if (conversation === undefined) { error(response, 404, "CONVERSATION_NOT_FOUND", "No conversation matches this id"); return; }
        json(response, 200, { conversation, turns: conversationRegistry.listTurns(conversation.conversationId) });
        return;
      }

      const conversationMessageMatch = url.pathname.match(/^\/v4\/conversations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/messages$/);
      if (method === "POST" && conversationMessageMatch?.[1] !== undefined) {
        if (conversationOrchestrator === undefined) {
          error(response, 503, "AGENT_DISABLED", "Complete private Pi Worker configuration is required");
          return;
        }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const message = parseConversationMessage(body.value, conversationMessageMatch[1], conversationMediaRegistry);
        if (message === undefined) {
          error(response, 400, "INVALID_CONVERSATION_MESSAGE", "Send bounded text, or attach available image/video media ids");
          return;
        }
        try {
          const result = await conversationOrchestrator.submit(message);
          json(response, result.duplicate ? 200 : result.turn.jobProposal === undefined && result.turn.selfImprovementProposal === undefined ? 201 : 202, result);
        } catch (caught) {
          if (caught instanceof ConversationMessageConflictError) {
            error(response, 409, "MESSAGE_ID_CONFLICT", caught.message);
            return;
          }
          if (caught instanceof ConversationExecutionError) {
            json(response, 502, { error: { code: caught.code, message: caught.message }, turn: caught.turn });
            return;
          }
          throw caught;
        }
        return;
      }

      const conversationMatch = url.pathname.match(/^\/v4\/conversations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/);
      if (method === "GET" && conversationMatch?.[1] !== undefined) {
        const conversation = conversationRegistry.getConversation(conversationMatch[1]);
        if (conversation === undefined) { error(response, 404, "CONVERSATION_NOT_FOUND", "No conversation matches this id"); return; }
        json(response, 200, { conversation });
        return;
      }

      if (method === "GET" && url.pathname === "/v4/self-improvement-jobs") {
        json(response, 200, { improvementJobs: selfImprovementJobRegistry.list(), execution: "isolated-r1-job-only" });
        return;
      }
      if (method === "POST" && url.pathname === "/v4/self-improvement-jobs") {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const requestInput = parseSelfImprovementJobCreate(body.value);
        if (requestInput === undefined) {
          error(response, 400, "INVALID_SELF_IMPROVEMENT_JOB", "An auto-scheduled R1 develop task and complete Owner-visible improvement background are required");
          return;
        }
        if (requestInput.input.workspaceId !== selfImprovementWorkspaceId) {
          error(response, 409, "SELF_IMPROVEMENT_WORKSPACE_REJECTED", "Self improvement Jobs must target the configured Friday source workspace");
          return;
        }
        try {
          const idempotency = jobRegistry.resolveIdempotency(requestInput.input);
          if (idempotency.outcome === "conflict") {
            error(response, 409, "JOB_IDEMPOTENCY_CONFLICT", "idempotencyKey is already bound to a different Job request");
            return;
          }
          let job;
          let scheduling;
          let duplicate: boolean;
          if (idempotency.outcome === "duplicate") {
            job = idempotency.job;
            scheduling = { mode: "auto" as const, runnerId: job.runnerId, reason: "existing-idempotent-assignment" };
            duplicate = true;
          } else {
            if (selfPatchRegistry.get(requestInput.improvementId) !== undefined) {
              error(response, 409, "SELF_IMPROVEMENT_ID_CONFLICT", "improvementId is already registered");
              return;
            }
            const selection = selectFleetRunner(
              { workspaceId: requestInput.input.workspaceId, tool: requestInput.input.tool },
              fleetSchedulingContext(),
            );
            if (selection === undefined) {
              error(response, 409, "NO_COMPATIBLE_RUNNER", "No online enrolled Sandbox Runner matches this self-improvement workspace and tool");
              return;
            }
            const result = jobRegistry.create({ ...requestInput.input, runnerId: selection.runnerId });
            job = result.job;
            scheduling = { mode: "auto" as const, ...selection };
            duplicate = result.duplicate;
          }
          const registered = selfImprovementJobRegistry.register(job, requestInput.improvementId, requestInput.context);
          json(response, duplicate || registered.duplicate ? 200 : 202, {
            accepted: true,
            duplicate: duplicate || registered.duplicate,
            scheduling,
            job,
            improvementJob: registered.binding,
          });
        } catch (caught) {
          error(response, 409, "SELF_IMPROVEMENT_JOB_REJECTED", caught instanceof Error ? caught.message : "Self improvement Job was rejected");
        }
        return;
      }
      const selfImprovementJobMatch = url.pathname.match(/^\/v4\/self-improvement-jobs\/([0-9a-f-]+)$/i);
      if (method === "GET" && selfImprovementJobMatch?.[1] !== undefined) {
        const binding = selfImprovementJobRegistry.get(selfImprovementJobMatch[1].toLowerCase());
        if (binding === undefined) { error(response, 404, "SELF_IMPROVEMENT_JOB_NOT_FOUND", "No self improvement Job matches this id"); return; }
        json(response, 200, { improvementJob: binding, improvement: selfPatchRegistry.getImprovement(binding.improvementId) ?? null });
        return;
      }

      if (method === "GET" && url.pathname === "/v4/self-improvements") {
        json(response, 200, { improvements: selfPatchRegistry.listImprovements(), execution: "clearance-gated-canary-only" });
        return;
      }
      if (method === "POST" && url.pathname === "/v4/self-improvements") {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const input = parseSelfImprovementCreate(body.value);
        if (input === undefined) {
          error(response, 400, "INVALID_SELF_IMPROVEMENT", "A bounded patch and complete improvement background are required");
          return;
        }
        try {
          json(response, 201, { improvement: selfPatchRegistry.createImprovement(input.id, input.branch, input.patch, input.context) });
        } catch (caught) {
          error(response, 400, "INVALID_SELF_IMPROVEMENT", caught instanceof Error ? caught.message : "Self improvement was rejected");
        }
        return;
      }
      const improvementMatch = url.pathname.match(/^\/v4\/self-improvements\/([a-z][a-z0-9-]{0,63})$/);
      if (method === "GET" && improvementMatch?.[1] !== undefined) {
        const improvement = selfPatchRegistry.getImprovement(improvementMatch[1]);
        if (improvement === undefined) { error(response, 404, "SELF_IMPROVEMENT_NOT_FOUND", "No self improvement matches this id"); return; }
        json(response, 200, { improvement });
        return;
      }
      const improvementTested = url.pathname.match(/^\/v4\/self-improvements\/([a-z][a-z0-9-]{0,63})\/tested$/);
      if (method === "POST" && improvementTested?.[1] !== undefined) {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.evidenceSha256 !== "string") {
          error(response, 400, "INVALID_SELF_IMPROVEMENT_EVIDENCE", "A test evidence SHA-256 is required"); return;
        }
        try {
          selfPatchRegistry.markTested(improvementTested[1], body.value.evidenceSha256);
          json(response, 200, { improvement: selfPatchRegistry.getImprovement(improvementTested[1]) });
        } catch { error(response, 409, "SELF_IMPROVEMENT_NOT_TESTABLE", "Self improvement cannot accept this evidence"); }
        return;
      }
      const improvementClearanceRequest = url.pathname.match(/^\/v4\/self-improvements\/([a-z][a-z0-9-]{0,63})\/clearance-request$/);
      if (method === "POST" && improvementClearanceRequest?.[1] !== undefined) {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_CLEARANCE_REQUEST", "Body must be an empty JSON object"); return; }
        try {
          json(response, 200, { improvement: selfPatchRegistry.requestClearance(improvementClearanceRequest[1]) });
        } catch (caught) {
          error(response, 409, "CLEARANCE_NOT_REQUESTABLE", caught instanceof Error ? caught.message : "Clearance cannot be requested");
        }
        return;
      }
      const improvementClearanceGrant = url.pathname.match(/^\/v4\/self-improvements\/([a-z][a-z0-9-]{0,63})\/clearance-grant$/);
      if (method === "POST" && improvementClearanceGrant?.[1] !== undefined) {
        if (!clearanceAuthorized(request, method)) { error(response, 403, "STRONG_CLEARANCE_REQUIRED", "An authenticated Owner Web session is required for R2/R3 clearance"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.clearanceId !== "string") {
          error(response, 400, "INVALID_CLEARANCE_GRANT", "The exact pending clearanceId is required"); return;
        }
        try {
          json(response, 200, { improvement: selfPatchRegistry.grantClearance(improvementClearanceGrant[1], body.value.clearanceId, config.ownerId) });
        } catch (caught) {
          error(response, 409, "CLEARANCE_MISMATCH", caught instanceof Error ? caught.message : "Clearance grant does not match");
        }
        return;
      }
      const improvementCanary = url.pathname.match(/^\/v4\/self-improvements\/([a-z][a-z0-9-]{0,63})\/canary$/);
      if (method === "POST" && improvementCanary?.[1] !== undefined) {
        if (!clearanceAuthorized(request, method)) { error(response, 403, "STRONG_CLEARANCE_REQUIRED", "An authenticated Owner Web session is required to start Canary"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 2 || typeof body.value.clearanceId !== "string" || typeof body.value.canaryId !== "string") {
          error(response, 400, "INVALID_IMPROVEMENT_CANARY", "Matching clearanceId and canaryId are required"); return;
        }
        try {
          json(response, 200, { improvement: selfPatchRegistry.startImprovementCanary(improvementCanary[1], body.value.clearanceId, body.value.canaryId) });
        } catch (caught) {
          error(response, 409, "IMPROVEMENT_CANARY_NOT_CLEARED", caught instanceof Error ? caught.message : "Canary is not cleared");
        }
        return;
      }
      const improvementCanaryComplete = url.pathname.match(/^\/v4\/self-improvements\/([a-z][a-z0-9-]{0,63})\/canary\/(succeeded|failed)$/);
      if (method === "POST" && improvementCanaryComplete?.[1] !== undefined && improvementCanaryComplete[2] !== undefined) {
        if (!clearanceAuthorized(request, method)) { error(response, 403, "STRONG_CLEARANCE_REQUIRED", "An authenticated Owner Web session is required to finalize Canary"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_IMPROVEMENT_CANARY", "Body must be an empty JSON object"); return; }
        try {
          json(response, 200, { improvement: selfPatchRegistry.completeImprovementCanary(improvementCanaryComplete[1], improvementCanaryComplete[2] === "succeeded") });
        } catch { error(response, 409, "IMPROVEMENT_CANARY_NOT_RUNNING", "Self improvement has no active Canary"); }
        return;
      }

      if (isChannelInbound) {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || typeof body.value.channel !== "string" || typeof body.value.token !== "string" || typeof body.value.senderId !== "string" || typeof body.value.messageId !== "string" || typeof body.value.group !== "boolean" || typeof body.value.text !== "string") { error(response,400,"INVALID_INBOUND","Inbound message is invalid"); return; }
        const inbound = { channel: body.value.channel, token: body.value.token, senderId: body.value.senderId, messageId: body.value.messageId, group: body.value.group, text: body.value.text };
        const acceptance = channelRegistry.accept(inbound.channel,inbound.token,inbound.senderId,inbound.messageId,inbound.group);
        if (acceptance === "rejected") { error(response,401,"INBOUND_REJECTED","Channel is unpaired, grouped, or unauthorized"); return; }
        if (acceptance === "new") await mutate(async()=>{ await store.append("channel.inbound",{channel:inbound.channel,messageId:inbound.messageId,senderId:inbound.senderId,textDigest:jsonDigest(inbound.text)}); });
        if (conversationOrchestrator === undefined || (inbound.channel !== "telegram" && inbound.channel !== "wechat_ilink")) {
          json(response,202,{accepted:true,duplicate:acceptance === "replay"}); return;
        }
        const conversationId = `${inbound.channel}-${jsonDigest(inbound.senderId).slice(0, 24)}`;
        try {
          const result = await conversationOrchestrator.submit({ conversationId, messageId: inbound.messageId, channel: inbound.channel, text: inbound.text });
          if (result.turn.jobId !== undefined) {
            jobChannelNotifier.bind(result.turn.jobId, inbound.channel as OutboundChannel, inbound.senderId);
            jobChannelNotifier.observe(result.turn.jobId);
          }
          json(response, 202, { accepted: true, duplicate: result.duplicate, reply: result.turn.assistantReply, scheduling: result.scheduling });
        } catch (caught) {
          if (caught instanceof ConversationMessageConflictError) { error(response, 409, "MESSAGE_ID_CONFLICT", caught.message); return; }
          if (caught instanceof ConversationExecutionError) {
            json(response, 202, { accepted: true, reply: "Friday 暂时无法处理这条消息，请稍后再试。", turn: caught.turn });
            return;
          }
          throw caught;
        }
        return;
      }

      const channelOutboxMatch = url.pathname.match(/^\/v2\/channels\/(telegram|wechat_ilink)\/outbox$/i);
      if (method === "GET" && channelOutboxMatch?.[1] !== undefined) {
        const channel = channelOutboxMatch[1].toLowerCase() as OutboundChannel;
        const token = singleHeader(request.headers.authorization)?.replace(/^Bearer /, "") ?? "";
        if (!channelRegistry.authorize(channel, token)) { error(response, 401, "CHANNEL_AUTH_REQUIRED", "A valid channel ingest token is required"); return; }
        json(response, 200, { notification: channelOutbox.pull(channel) ?? null });
        return;
      }

      const channelOutboxAckMatch = url.pathname.match(/^\/v2\/channels\/(telegram|wechat_ilink)\/outbox\/([0-9a-f-]+)\/ack$/i);
      if (method === "POST" && channelOutboxAckMatch?.[1] !== undefined && channelOutboxAckMatch[2] !== undefined) {
        const channel = channelOutboxAckMatch[1].toLowerCase() as OutboundChannel;
        const token = singleHeader(request.headers.authorization)?.replace(/^Bearer /, "") ?? "";
        if (!channelRegistry.authorize(channel, token)) { error(response, 401, "CHANNEL_AUTH_REQUIRED", "A valid channel ingest token is required"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.leaseId !== "string") { error(response, 400, "INVALID_NOTIFICATION_ACK", "The exact notification leaseId is required"); return; }
        if (!channelOutbox.acknowledge(channel, channelOutboxAckMatch[2].toLowerCase(), body.value.leaseId)) { error(response, 409, "NOTIFICATION_ACK_REJECTED", "Notification lease does not match"); return; }
        json(response, 200, { delivered: true });
        return;
      }

      if (method === "POST" && url.pathname === "/v2/channels/rotate") {
        const body=await parseJsonBody(request,config.maxBodyBytes); if(!isRecord(body.value)||Object.keys(body.value).length!==1||typeof body.value.channel!=="string"){error(response,400,"INVALID_CHANNEL","channel is required");return;} try{json(response,201,{token:channelRegistry.rotate(body.value.channel)});}catch{error(response,400,"INVALID_CHANNEL","Unsupported channel");} return;
      }
      if (method === "POST" && url.pathname === "/v2/channels/pair") {
        const body=await parseJsonBody(request,config.maxBodyBytes); if(!isRecord(body.value)||Object.keys(body.value).length!==2||typeof body.value.channel!=="string"||typeof body.value.senderId!=="string"){error(response,400,"INVALID_PAIR","channel and senderId are required");return;} try{channelRegistry.pair(body.value.channel,body.value.senderId);json(response,200,{paired:true});}catch{error(response,400,"INVALID_PAIR","Channel pairing was rejected");} return;
      }
      if (method === "POST" && url.pathname === "/v2/memory/candidates") {
        const body=await parseJsonBody(request,config.maxBodyBytes);if(!isRecord(body.value)||Object.keys(body.value).length!==2||typeof body.value.source!=="string"||typeof body.value.candidate!=="string"){error(response,400,"INVALID_MEMORY","source and candidate are required");return;}try{json(response,201,{id:memoryRegistry.add(body.value.source,body.value.candidate),status:"PENDING"});}catch{error(response,400,"INVALID_MEMORY","Memory candidate was rejected");}return;
      }
      const memoryConfirm=url.pathname.match(/^\/v2\/memory\/candidates\/([a-f0-9]+)\/confirm$/i); if(method==="POST"&&memoryConfirm?.[1]!==undefined){const body=await parseJsonBody(request,config.maxBodyBytes);if(!isRecord(body.value)||Object.keys(body.value).some(k=>k!=="correction")||(body.value.correction!==undefined&&typeof body.value.correction!=="string")){error(response,400,"INVALID_MEMORY","Invalid confirmation");return;}try{memoryRegistry.confirm(memoryConfirm[1],body.value.correction as string|undefined);json(response,200,{confirmed:true});}catch{error(response,409,"MEMORY_NOT_CONFIRMABLE","Memory candidate cannot be confirmed");}return;}
      const memoryDelete=url.pathname.match(/^\/v2\/memory\/candidates\/([a-f0-9]+)$/i); if(method==="DELETE"&&memoryDelete?.[1]!==undefined){memoryRegistry.remove(memoryDelete[1]);json(response,200,{deleted:true});return;}
      if(method==="GET"&&url.pathname==="/v2/memory/export"){json(response,200,{memories:memoryRegistry.exportConfirmed()});return;}

      if (method === "POST" && url.pathname === "/v2/voice/media") {
        const mimeType = singleHeader(request.headers["content-type"])?.split(";", 1)[0]?.toLowerCase();
        const ttl = Number.parseInt(singleHeader(request.headers["x-friday-media-ttl-seconds"]) ?? "900", 10);
        if (mimeType === undefined || !/^audio\//.test(mimeType) || !Number.isSafeInteger(ttl)) { error(response, 400, "INVALID_VOICE_MEDIA", "An audio content type and valid TTL are required"); return; }
        try { json(response, 201, { media: voiceMediaRegistry.save(await parseRawBody(request, config.maxBodyBytes), mimeType, ttl) }); } catch { error(response, 400, "INVALID_VOICE_MEDIA", "Voice media is invalid or too large"); }
        return;
      }
      const voiceMediaMatch = url.pathname.match(/^\/v2\/voice\/media\/([a-f0-9]{32})$/i);
      if (method === "GET" && voiceMediaMatch?.[1] !== undefined) {
        const stored = voiceMediaRegistry.read(voiceMediaMatch[1].toLowerCase());
        if (stored === undefined) { error(response, 404, "VOICE_MEDIA_NOT_FOUND", "Voice media is unavailable or expired"); return; }
        response.writeHead(200, { "content-type": stored.media.mimeType, "content-length": stored.bytes.byteLength, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(stored.bytes); return;
      }
      if (method === "POST" && url.pathname === "/v2/voice/transcribe") {
        if (voiceClient === undefined) { error(response, 503, "VOICE_DISABLED", "Complete private STT/TTS configuration is required"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes); if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.mediaId !== "string") { error(response, 400, "INVALID_VOICE_REQUEST", "mediaId is required"); return; }
        const stored = voiceMediaRegistry.read(body.value.mediaId.toLowerCase()); if (stored === undefined) { error(response, 404, "VOICE_MEDIA_NOT_FOUND", "Voice media is unavailable or expired"); return; }
        try { json(response, 200, { text: await voiceClient.transcribe({ mimeType: stored.media.mimeType, bytes: stored.bytes }), media: stored.media }); } catch { error(response, 502, "VOICE_TRANSCRIPTION_FAILED", "Voice transcription provider failed"); }
        return;
      }
      if (method === "POST" && url.pathname === "/v2/voice/synthesize") {
        if (voiceClient === undefined) { error(response, 503, "VOICE_DISABLED", "Complete private STT/TTS configuration is required"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes); if (!isRecord(body.value) || Object.keys(body.value).some((key) => key !== "text" && key !== "voice") || typeof body.value.text !== "string" || (body.value.voice !== undefined && typeof body.value.voice !== "string")) { error(response, 400, "INVALID_VOICE_REQUEST", "text and optional voice are required"); return; }
        try { const generated = await voiceClient.synthesize(body.value.text, body.value.voice as string | undefined); json(response, 201, { media: voiceMediaRegistry.save(generated.bytes, generated.mimeType) }); } catch { error(response, 502, "VOICE_SYNTHESIS_FAILED", "Voice synthesis provider failed"); }
        return;
      }

      // M3 is Owner-only by the authorization gate above. The Channel Gateway
      // has no Owner session/token, so it cannot register or enable extensions.
      if (method === "GET" && url.pathname === "/v3/mcp") { json(response, 200, { mcps: mcpRegistry.list(), broker: config.mcpBrokerEnabled === true ? "isolated-unix-socket" : "disabled-without-isolated-transport" }); return; }
      if (method === "POST" && url.pathname === "/v3/mcp") {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 5 || typeof body.value.name !== "string" || typeof body.value.version !== "string" || typeof body.value.source !== "string" || typeof body.value.schemaSha256 !== "string" || !isRecord(body.value.budget)) { error(response, 400, "INVALID_MCP", "MCP definition is invalid"); return; }
        const budget = body.value.budget;
        if (Object.keys(budget).length !== 4 || !["networkRequests", "fileBytes", "secretRefs", "timeoutSeconds"].every((key) => typeof budget[key] === "number")) { error(response, 400, "INVALID_MCP", "MCP budget is invalid"); return; }
        try { mcpRegistry.register({ name: body.value.name, version: body.value.version, source: body.value.source, schemaSha256: body.value.schemaSha256, budget: budget as unknown as McpDefinition["budget"] }); json(response, 201, { registered: true, enabled: false }); } catch { error(response, 400, "INVALID_MCP", "MCP definition is invalid"); }
        return;
      }
      const mcpState = url.pathname.match(/^\/v3\/mcp\/([a-z][a-z0-9_-]{0,63})\/(enable|disable)$/);
      if (method === "POST" && mcpState?.[1] !== undefined && mcpState[2] !== undefined) {
        const body = await parseJsonBody(request, config.maxBodyBytes); if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_MCP", "Body must be an empty JSON object"); return; }
        try { if (mcpState[2] === "enable") mcpRegistry.enable(mcpState[1]); else mcpRegistry.disable(mcpState[1]); json(response, 200, { name: mcpState[1], enabled: mcpState[2] === "enable" }); } catch { error(response, 404, "MCP_NOT_FOUND", "MCP is not registered"); }
        return;
      }
      if (method === "POST" && url.pathname === "/v3/mcp/invoke") {
        if (config.mcpBrokerEnabled !== true || config.mcpBrokerSocketPath === undefined) { error(response, 503, "MCP_BROKER_DISABLED", "An isolated MCP Broker socket must be configured before invocation"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 2 || typeof body.value.name !== "string" || typeof body.value.input !== "string") { error(response, 400, "INVALID_MCP_INVOKE", "name and input are required"); return; }
        try { const result = await mcpBroker.invoke({ name: body.value.name, input: body.value.input, networkRequests: 1, fileBytes: 0, secretRefs: 0, elapsedSeconds: 0 }, (definition, input) => invokeMcpBrokerSidecar(config.mcpBrokerSocketPath as string, definition, input)); json(response, 200, { result }); } catch (caught) { const message = caught instanceof Error ? caught.message : "MCP invocation failed"; const code = /disabled|not registered/i.test(message) ? "MCP_NOT_ENABLED" : /budget/i.test(message) ? "MCP_BUDGET_EXCEEDED" : "MCP_INVOKE_FAILED"; error(response, 409, code, code === "MCP_INVOKE_FAILED" ? "MCP invocation failed without exposing transport output" : message); }
        return;
      }

      if (method === "GET" && url.pathname === "/v3/runner-adapters") { json(response, 200, { adapters: adapterRegistry.list(), scheduling: "explicit-runner-selection-only" }); return; }
      if (method === "POST" && url.pathname === "/v3/runner-adapters") {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 4 || typeof body.value.runnerId !== "string" || (body.value.adapter !== "codex-app-server" && body.value.adapter !== "pi-rpc" && body.value.adapter !== "claude-code") || typeof body.value.image !== "string" || typeof body.value.imageId !== "string") { error(response, 400, "INVALID_ADAPTER", "Runner adapter is invalid"); return; }
        const requestedRunnerId = body.value.runnerId.toLowerCase();
        if (!runnerRegistry.isEnrolled(requestedRunnerId) || !state.listRunners().some((runner) => runner.nodeId === requestedRunnerId)) { error(response, 409, "RUNNER_NOT_REGISTERED", "An adapter can only be pinned to an enrolled, registered Runner"); return; }
        try { adapterRegistry.register({ runnerId: body.value.runnerId.toLowerCase(), adapter: body.value.adapter, image: body.value.image, imageId: body.value.imageId } as AdapterDefinition); json(response, 201, { registered: true, enabled: false }); } catch { error(response, 400, "INVALID_ADAPTER", "Runner adapter requires an immutable image ID"); }
        return;
      }
      const adapterState = url.pathname.match(/^\/v3\/runners\/([0-9a-f-]+)\/adapters\/(codex-app-server|pi-rpc|claude-code)\/(enable|disable)$/i);
      if (method === "POST" && adapterState?.[1] !== undefined && adapterState[2] !== undefined && adapterState[3] !== undefined) {
        const body = await parseJsonBody(request, config.maxBodyBytes); if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_ADAPTER", "Body must be an empty JSON object"); return; }
        const runnerId = adapterState[1].toLowerCase(); const adapter = adapterState[2] as AdapterDefinition["adapter"];
        try { if (adapterState[3] === "enable") adapterRegistry.enable(runnerId, adapter); else adapterRegistry.disable(runnerId, adapter); json(response, 200, { runnerId, adapter, enabled: adapterState[3] === "enable" }); } catch { error(response, 409, "ADAPTER_NOT_ACTIONABLE", "Runner adapter is not registered"); }
        return;
      }

      if (method === "GET" && url.pathname === "/v3/procedures") {
        if (procedureRegistry === undefined) { error(response, 503, "PROCEDURES_DISABLED", "Configure an Owner Ed25519 procedure key to enable procedures"); return; }
        json(response, 200, { procedures: procedureRegistry.list() }); return;
      }
      if (method === "POST" && url.pathname === "/v3/procedures") {
        if (procedureRegistry === undefined) { error(response, 503, "PROCEDURES_DISABLED", "Configure an Owner Ed25519 procedure key to enable procedures"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 5 || typeof body.value.id !== "string" || typeof body.value.version !== "string" || !Array.isArray(body.value.capabilities) || body.value.capabilities.some((capability) => typeof capability !== "string") || typeof body.value.manifestSha256 !== "string" || typeof body.value.signature !== "string") { error(response, 400, "INVALID_PROCEDURE", "Signed procedure is invalid"); return; }
        try { procedureRegistry.register(body.value as unknown as SignedProcedure); json(response, 201, { registered: true, enabled: false }); } catch { error(response, 400, "INVALID_PROCEDURE", "Signed procedure is invalid"); }
        return;
      }
      const procedureVerify = url.pathname.match(/^\/v3\/procedures\/([a-z][a-z0-9_-]{0,63})\/versions\/(\d+\.\d+\.\d+)\/verify$/);
      if (method === "POST" && procedureVerify?.[1] !== undefined && procedureVerify[2] !== undefined) {
        if (procedureRegistry === undefined) { error(response, 503, "PROCEDURES_DISABLED", "Configure an Owner Ed25519 procedure key to enable procedures"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes); if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.evidenceSha256 !== "string") { error(response, 400, "INVALID_PROCEDURE", "Sandbox verification evidence is required"); return; }
        try { procedureRegistry.markSandboxVerified(procedureVerify[1], procedureVerify[2], body.value.evidenceSha256); json(response, 200, { sandboxVerified: true }); } catch { error(response, 409, "PROCEDURE_NOT_VERIFIABLE", "Procedure version cannot be verified"); }
        return;
      }
      const procedureAction = url.pathname.match(/^\/v3\/procedures\/([a-z][a-z0-9_-]{0,63})\/(enable|rollback)$/);
      if (method === "POST" && procedureAction?.[1] !== undefined && procedureAction[2] !== undefined) {
        if (procedureRegistry === undefined) { error(response, 503, "PROCEDURES_DISABLED", "Configure an Owner Ed25519 procedure key to enable procedures"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes); if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_PROCEDURE", "Body must be an empty JSON object"); return; }
        try { if (procedureAction[2] === "enable") procedureRegistry.enable(procedureAction[1]); else procedureRegistry.rollback(procedureAction[1]); json(response, 200, { procedure: procedureRegistry.active(procedureAction[1]) }); } catch { error(response, 409, "PROCEDURE_NOT_ACTIONABLE", "Procedure is not ready for this action"); }
        return;
      }

      if (method === "GET" && url.pathname === "/v3/skills") {
        if (skillRegistry === undefined) { error(response, 503, "SKILLS_DISABLED", "Configure an Owner Ed25519 skill key to enable skills"); return; }
        json(response, 200, { skills: skillRegistry.list() }); return;
      }
      if (method === "POST" && url.pathname === "/v3/skills") {
        if (skillRegistry === undefined) { error(response, 503, "SKILLS_DISABLED", "Configure an Owner Ed25519 skill key to enable skills"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 6 || typeof body.value.id !== "string" || typeof body.value.version !== "string" || typeof body.value.source !== "string" || typeof body.value.contentSha256 !== "string" || !Array.isArray(body.value.capabilities) || body.value.capabilities.some((capability) => typeof capability !== "string") || typeof body.value.signature !== "string") { error(response, 400, "INVALID_SKILL", "Signed skill is invalid"); return; }
        try { skillRegistry.register(body.value as unknown as SignedSkill); json(response, 201, { registered: true, enabled: false }); } catch { error(response, 400, "INVALID_SKILL", "Signed skill is invalid"); }
        return;
      }
      const skillVerify = url.pathname.match(/^\/v3\/skills\/([a-z][a-z0-9_-]{0,63})\/versions\/(\d+\.\d+\.\d+)\/verify$/);
      if (method === "POST" && skillVerify?.[1] !== undefined && skillVerify[2] !== undefined) {
        if (skillRegistry === undefined) { error(response, 503, "SKILLS_DISABLED", "Configure an Owner Ed25519 skill key to enable skills"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes); if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.evidenceSha256 !== "string") { error(response, 400, "INVALID_SKILL", "Sandbox verification evidence is required"); return; }
        try { skillRegistry.markSandboxVerified(skillVerify[1], skillVerify[2], body.value.evidenceSha256); json(response, 200, { sandboxVerified: true }); } catch { error(response, 409, "SKILL_NOT_VERIFIABLE", "Skill version cannot be verified"); }
        return;
      }
      const skillAction = url.pathname.match(/^\/v3\/skills\/([a-z][a-z0-9_-]{0,63})\/(enable|rollback)$/);
      if (method === "POST" && skillAction?.[1] !== undefined && skillAction[2] !== undefined) {
        if (skillRegistry === undefined) { error(response, 503, "SKILLS_DISABLED", "Configure an Owner Ed25519 skill key to enable skills"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes); if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_SKILL", "Body must be an empty JSON object"); return; }
        try { if (skillAction[2] === "enable") skillRegistry.enable(skillAction[1]); else skillRegistry.rollback(skillAction[1]); json(response, 200, { skill: skillRegistry.active(skillAction[1]) }); } catch { error(response, 409, "SKILL_NOT_ACTIONABLE", "Skill is not ready for this action"); }
        return;
      }

      if (method === "GET" && url.pathname === "/v3/self-patches") { json(response, 200, { patches: selfPatchRegistry.list(), execution: "manual-canary-only" }); return; }
      if (method === "POST" && url.pathname === "/v3/self-patches") {
        const body = await parseJsonBody(request, config.maxBodyBytes); if (!isRecord(body.value) || Object.keys(body.value).length !== 3 || typeof body.value.id !== "string" || typeof body.value.branch !== "string" || typeof body.value.patch !== "string") { error(response, 400, "INVALID_SELF_PATCH", "Self patch is invalid"); return; }
        try { selfPatchRegistry.create(body.value.id, body.value.branch, body.value.patch); json(response, 201, { patch: selfPatchRegistry.get(body.value.id) }); } catch { error(response, 400, "INVALID_SELF_PATCH", "Self patch must be an isolated Git diff"); } return;
      }
      const patchTest = url.pathname.match(/^\/v3\/self-patches\/([a-z][a-z0-9-]{0,63})\/tested$/);
      if (method === "POST" && patchTest?.[1] !== undefined) { const body = await parseJsonBody(request, config.maxBodyBytes); if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.evidenceSha256 !== "string") { error(response, 400, "INVALID_SELF_PATCH", "Test evidence hash is required"); return; } try { selfPatchRegistry.markTested(patchTest[1], body.value.evidenceSha256); json(response, 200, { patch: selfPatchRegistry.get(patchTest[1]) }); } catch { error(response, 409, "SELF_PATCH_NOT_TESTABLE", "Self patch cannot be marked tested"); } return; }
      const patchApproval = url.pathname.match(/^\/v3\/self-patches\/([a-z][a-z0-9-]{0,63})\/approval$/);
      if (method === "POST" && patchApproval?.[1] !== undefined) { const body = await parseJsonBody(request, config.maxBodyBytes); if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || (body.value.risk !== "R2" && body.value.risk !== "R3")) { error(response, 400, "INVALID_SELF_PATCH", "R2 or R3 approval is required"); return; } try { selfPatchRegistry.requestApproval(patchApproval[1], body.value.risk as ApprovalRisk); json(response, 200, { patch: selfPatchRegistry.get(patchApproval[1]) }); } catch { error(response, 409, "SELF_PATCH_NOT_APPROVABLE", "Self patch cannot request approval"); } return; }
      const patchCanary = url.pathname.match(/^\/v3\/self-patches\/([a-z][a-z0-9-]{0,63})\/canary$/);
      if (method === "POST" && patchCanary?.[1] !== undefined) { const body = await parseJsonBody(request, config.maxBodyBytes); if (!isRecord(body.value) || Object.keys(body.value).length !== 2 || (body.value.risk !== "R2" && body.value.risk !== "R3") || typeof body.value.canaryId !== "string") { error(response, 400, "INVALID_SELF_PATCH", "Matching approval and canary id are required"); return; } try { selfPatchRegistry.approveCanary(patchCanary[1], body.value.risk as ApprovalRisk, body.value.canaryId); json(response, 200, { patch: selfPatchRegistry.get(patchCanary[1]) }); } catch { error(response, 409, "SELF_PATCH_NOT_CANARY_READY", "Self patch requires matching approval"); } return; }
      const patchComplete = url.pathname.match(/^\/v3\/self-patches\/([a-z][a-z0-9-]{0,63})\/canary\/(succeeded|failed)$/);
      if (method === "POST" && patchComplete?.[1] !== undefined && patchComplete[2] !== undefined) { const body = await parseJsonBody(request, config.maxBodyBytes); if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_SELF_PATCH", "Body must be an empty JSON object"); return; } try { selfPatchRegistry.completeCanary(patchComplete[1], patchComplete[2] === "succeeded"); json(response, 200, { patch: selfPatchRegistry.get(patchComplete[1]) }); } catch { error(response, 409, "SELF_PATCH_NOT_CANARY", "Self patch is not running a canary"); } return; }

      if (method === "GET" && url.pathname === "/v1/info") {
        json(response, 200, {
          ownerId: config.ownerId,
          protocolVersion: PROTOCOL_VERSION,
          persistence: "sqlite-wal-hash-chain",
          capabilities: [
            "messages.accept",
            "runners.enrollment.issue",
            "runners.enrollment.consume",
            "runners.device-revoke",
            "runners.device-signed-register",
            "runners.device-signed-heartbeat",
            "events.read",
          ],
        });
        return;
      }

      if (isHubKey) {
        json(response, 200, {
          protocolVersion: JOB_PROTOCOL_VERSION,
          algorithm: hubIdentity.algorithm,
          publicKeyPem: hubIdentity.publicKeyPem,
        });
        return;
      }

      const modelProxyMatch = url.pathname.match(/^\/v2\/model-proxy\/(openai|anthropic)(\/v1\/(?:responses(?:\/compact)?|chat\/completions|messages(?:\/count_tokens)?))$/);
      if (method === "POST" && modelProxyMatch?.[1] !== undefined && modelProxyMatch[2] !== undefined) {
        if (modelAccessBroker === undefined || config.runnerModelProxy === undefined) {
          error(response, 503, "RUNNER_MODEL_PROXY_DISABLED", "Runner model access is not configured");
          return;
        }
        if (url.search !== "" || singleHeader(request.headers["content-type"])?.split(";", 1)[0]?.toLowerCase() !== "application/json") {
          error(response, 400, "INVALID_MODEL_PROXY_REQUEST", "Model proxy accepts JSON requests without query parameters");
          return;
        }
        let grant;
        try {
          grant = modelAccessBroker.authorize(singleHeader(request.headers.authorization), modelProxyMatch[1] as RunnerModelProviderV2, modelProxyMatch[2]);
        } catch {
          error(response, 401, "MODEL_ACCESS_DENIED", "Model access token is invalid, expired, or outside its Job scope");
          return;
        }
        try {
          const upstream = await modelAccessBroker.forward({
            grant,
            path: modelProxyMatch[2],
            body: await parseRawBody(request, config.runnerModelProxy.maxRequestBytes),
            headers: {
              accept: singleHeader(request.headers.accept),
              "openai-beta": singleHeader(request.headers["openai-beta"]),
              "anthropic-version": singleHeader(request.headers["anthropic-version"]),
              "anthropic-beta": singleHeader(request.headers["anthropic-beta"]),
            },
          });
          response.writeHead(upstream.status, modelProxyResponseHeaders(upstream.headers));
          if (upstream.body === null) { response.end(); return; }
          const reader = upstream.body.getReader();
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (!response.write(Buffer.from(chunk.value))) await new Promise<void>((resolve) => response.once("drain", resolve));
            }
            response.end();
          } finally {
            reader.releaseLock();
          }
        } catch {
          if (!response.headersSent) error(response, 502, "MODEL_PROXY_FAILED", "The configured model provider could not complete the request");
          else response.destroy();
        }
        return;
      }

      if (method === "POST" && url.pathname === "/v2/auth/bootstrap") {
        if (webauthnRegistry === undefined) { error(response, 503, "WEBAUTHN_DISABLED", "Set FRIDAY_PUBLIC_ORIGIN to enable Passkey bootstrap"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_BOOTSTRAP", "Body must be an empty JSON object"); return; }
        const bootstrap = await webauthnRegistry.issueBootstrap();
        json(response, 201, { bootstrapToken: bootstrap.token, expiresAt: bootstrap.expiresAt });
        return;
      }

      if (method === "POST" && url.pathname === "/v2/auth/login/options") {
        if (webauthnRegistry === undefined || singleHeader(request.headers.origin) !== config.publicOrigin) { error(response, 403, "PASSKEY_ORIGIN_REQUIRED", "Passkey login requires the configured HTTPS Origin"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_LOGIN", "Body must be an empty JSON object"); return; }
        try { json(response, 200, await webauthnRegistry.authenticationOptions()); } catch { error(response, 401, "PASSKEY_REJECTED", "Passkey login was rejected"); }
        return;
      }

      if (method === "POST" && url.pathname === "/v2/auth/login/verify") {
        if (webauthnRegistry === undefined || singleHeader(request.headers.origin) !== config.publicOrigin) { error(response, 403, "PASSKEY_ORIGIN_REQUIRED", "Passkey login requires the configured HTTPS Origin"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || !isRecord(body.value.response)) { error(response, 400, "INVALID_PASSKEY_RESPONSE", "A passkey response is required"); return; }
        try {
          const session = await webauthnRegistry.verifyAuthentication(body.value.response as never);
          setOwnerSessionCookies(response, session);
          json(response, 200, { authenticated: true, expiresAt: session.expiresAt });
        } catch { error(response, 401, "PASSKEY_REJECTED", "Passkey login was rejected"); }
        return;
      }

      if (method === "POST" && url.pathname === "/v2/auth/logout") {
        webauthnRegistry?.revokeSession(cookieValue(request, "friday_owner"));
        clearOwnerSessionCookies(response);
        json(response, 200, { loggedOut: true });
        return;
      }

      if (method === "GET" && url.pathname === "/v2/events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "keep-alive" });
        const send = (): void => { response.write(`data: ${JSON.stringify({ jobs: jobRegistry.list(), emittedAt: new Date().toISOString() })}\n\n`); };
        send();
        const timer = setInterval(send, 2_000);
        request.once("close", () => clearInterval(timer));
        return;
      }

      if (method === "POST" && url.pathname === "/v2/auth/register/options") {
        if (webauthnRegistry === undefined) { error(response, 503, "WEBAUTHN_DISABLED", "Passkey is not configured"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 1 || typeof body.value.bootstrapToken !== "string") { error(response, 400, "INVALID_BOOTSTRAP", "A bootstrapToken is required"); return; }
        try { json(response, 200, await webauthnRegistry.registrationOptions(body.value.bootstrapToken)); } catch (caught) { error(response, 401, "BOOTSTRAP_REJECTED", caught instanceof Error ? caught.message : "Bootstrap rejected"); }
        return;
      }

      if (method === "POST" && url.pathname === "/v2/auth/register/verify") {
        if (webauthnRegistry === undefined) { error(response, 503, "WEBAUTHN_DISABLED", "Passkey is not configured"); return; }
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || Object.keys(body.value).length !== 2 || typeof body.value.bootstrapToken !== "string" || !isRecord(body.value.response)) { error(response, 400, "INVALID_PASSKEY_RESPONSE", "bootstrapToken and a registration response are required"); return; }
        try { await webauthnRegistry.verifyRegistration(body.value.bootstrapToken, body.value.response as never); json(response, 201, { registered: true }); } catch (caught) { error(response, 401, "PASSKEY_REJECTED", caught instanceof Error ? caught.message : "Passkey was rejected"); }
        return;
      }

      if (method === "POST" && url.pathname === "/v2/jobs") {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const requestInput = parseJobCreate(body.value);
        if (requestInput === undefined) {
          error(response, 400, "INVALID_JOB_CREATE", "Body does not match JobCreate v2");
          return;
        }
        let idempotency;
        try {
          idempotency = jobRegistry.resolveIdempotency(
            requestInput.input,
            requestInput.target.mode === "explicit" ? requestInput.target.runnerId : undefined,
          );
        } catch (caught) {
          error(response, 400, "INVALID_JOB_CREATE", caught instanceof Error ? caught.message : "Invalid job request");
          return;
        }
        if (idempotency.outcome === "conflict") {
          error(response, 409, "JOB_IDEMPOTENCY_CONFLICT", "idempotencyKey is already bound to a different Job request");
          return;
        }
        if (idempotency.outcome === "duplicate") {
          json(response, 200, {
            accepted: true,
            duplicate: true,
            scheduling: { mode: requestInput.target.mode, runnerId: idempotency.job.runnerId, reason: "existing-idempotent-assignment" },
            job: idempotency.job,
          });
          return;
        }
        const schedulingContext = {
          runners: state.listRunners(),
          assignedJobs: jobRegistry.nonTerminalCountByRunner(),
          isEnrolled: (runnerId: string) => runnerRegistry.isEnrolled(runnerId),
          adapterEnabled: (runnerId: string, adapter: AdapterDefinition["adapter"]) => adapterRegistry.resolve(runnerId, adapter) !== undefined,
        };
        const selection = requestInput.target.mode === "auto"
          ? selectFleetRunner({ workspaceId: requestInput.input.workspaceId, tool: requestInput.input.tool }, schedulingContext)
          : undefined;
        if (requestInput.target.mode === "auto" && selection === undefined) {
          error(response, 409, "NO_COMPATIBLE_RUNNER", "No online enrolled Runner matches the workspace, tool, and enabled adapter");
          return;
        }
        const runnerId = requestInput.target.mode === "explicit" ? requestInput.target.runnerId : selection?.runnerId;
        if (runnerId === undefined) throw new Error("Fleet selection did not produce a Runner");
        const adapter = requiredAdapter(requestInput.input.tool);
        if (adapter !== undefined && adapterRegistry.resolve(runnerId, adapter) === undefined) {
          error(response, 409, "RUNNER_ADAPTER_NOT_ENABLED", "Select an explicitly enabled compatible Runner adapter");
          return;
        }
        try {
          const result = jobRegistry.create({ ...requestInput.input, runnerId });
          json(response, result.duplicate ? 200 : 202, {
            accepted: true,
            duplicate: result.duplicate,
            scheduling: requestInput.target.mode === "explicit"
              ? { mode: "explicit", runnerId }
              : { mode: "auto", ...selection },
            job: result.job,
          });
        } catch (caught) {
          error(response, 400, "INVALID_JOB_CREATE", caught instanceof Error ? caught.message : "Invalid job request");
        }
        return;
      }

      if (method === "GET" && url.pathname === "/v2/jobs") {
        json(response, 200, { jobs: jobRegistry.list() });
        return;
      }

      if (method === "GET" && url.pathname === "/v2/fleet") {
        const workspaceId = url.searchParams.get("workspaceId");
        const tool = url.searchParams.get("tool");
        if (workspaceId === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId) || tool === null || !["codex", "pi", "claude", "diagnostic"].includes(tool)) {
          error(response, 400, "INVALID_FLEET_QUERY", "workspaceId and tool are required");
          return;
        }
        json(response, 200, {
          runners: evaluateFleetRunners(
            { workspaceId, tool: tool as JobCreateInput["tool"] },
            {
              runners: state.listRunners(),
              assignedJobs: jobRegistry.nonTerminalCountByRunner(),
              isEnrolled: (runnerId) => runnerRegistry.isEnrolled(runnerId),
              adapterEnabled: (runnerId, adapterName) => adapterRegistry.resolve(runnerId, adapterName) !== undefined,
            },
          ),
        });
        return;
      }

      const approvalMatch = url.pathname.match(/^\/v2\/jobs\/([0-9a-f-]+)\/approve$/i);
      if (method === "POST" && approvalMatch?.[1] !== undefined) {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isEmptyObject(body.value)) {
          error(response, 400, "INVALID_JOB_APPROVAL", "Body must be an empty JSON object");
          return;
        }
        try {
          json(response, 200, { approved: true, job: jobRegistry.approve(approvalMatch[1].toLowerCase(), config.ownerId) });
        } catch (caught) {
          error(response, 409, "JOB_NOT_APPROVABLE", caught instanceof Error ? caught.message : "Job cannot be approved");
        }
        return;
      }

      const stopMatch = url.pathname.match(/^\/v2\/jobs\/([0-9a-f-]+)\/stop$/i);
      if (method === "POST" && stopMatch?.[1] !== undefined) {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isEmptyObject(body.value)) { error(response, 400, "INVALID_JOB_STOP", "Body must be an empty JSON object"); return; }
        try { const jobId = stopMatch[1].toLowerCase(); const job = jobRegistry.cancel(jobId); modelAccessBroker?.revokeJob(jobId); jobChannelNotifier.observe(jobId); json(response, 200, { stopped: true, job }); } catch (caught) { error(response, 409, "JOB_NOT_STOPPABLE", caught instanceof Error ? caught.message : "Job cannot be stopped"); }
        return;
      }

      const jobMatchV2 = url.pathname.match(/^\/v2\/jobs\/([0-9a-f-]+)$/i);
      if (method === "GET" && jobMatchV2?.[1] !== undefined) {
        const job = jobRegistry.get(jobMatchV2[1].toLowerCase());
        if (job === undefined) {
          error(response, 404, "JOB_NOT_FOUND", "No v2 job matches this id");
          return;
        }
        json(response, 200, { job });
        return;
      }

      const jobEventsMatchV2 = url.pathname.match(/^\/v2\/jobs\/([0-9a-f-]+)\/events$/i);
      if (method === "GET" && jobEventsMatchV2?.[1] !== undefined) {
        try {
          json(response, 200, { events: jobRegistry.listEvents(jobEventsMatchV2[1].toLowerCase()) });
        } catch {
          error(response, 404, "JOB_NOT_FOUND", "No v2 job matches this id");
        }
        return;
      }

      const artifactDownloadMatch = url.pathname.match(/^\/v2\/jobs\/([0-9a-f-]+)\/artifacts\/([0-9a-f-]+)$/i);
      if (method === "GET" && artifactDownloadMatch?.[1] !== undefined && artifactDownloadMatch[2] !== undefined) {
        const downloadJobId = artifactDownloadMatch[1].toLowerCase(); const downloadArtifactId = artifactDownloadMatch[2].toLowerCase();
        const events = jobRegistry.listEvents(downloadJobId);
        const artifactEvent = events.find((entry) => entry.event.type === "artifact" && entry.event.artifact?.artifactId === downloadArtifactId);
        const artifact = artifactEvent?.event.artifact;
        if (artifact === undefined) { error(response, 404, "ARTIFACT_NOT_FOUND", "No artifact matches this Job"); return; }
        const bytes = await artifactStore.read(downloadJobId, downloadArtifactId);
        if (bytes === undefined) { error(response, 404, "ARTIFACT_NOT_FOUND", "Artifact bytes are unavailable"); return; }
        response.writeHead(200, { "content-type": artifact.mediaType, "content-length": bytes.byteLength, "content-disposition": `attachment; filename="${safeDownloadName(artifact.name)}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(bytes); return;
      }

      const runnerPullMatchV2 = url.pathname.match(/^\/v2\/runners\/([0-9a-f-]+)\/pull$/i);
      if (method === "POST" && runnerPullMatchV2?.[1] !== undefined) {
        const runnerId = runnerPullMatchV2[1].toLowerCase();
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const pull = parseRunnerPull(body.value, runnerId);
        if (pull === undefined || !runnerRegistry.verifyRequestV2(runnerId, singleHeader(request.headers["x-friday-runner-signature"]), method, url.pathname, body.raw)) {
          error(response, 401, "RUNNER_DEVICE_AUTH_REQUIRED", "A valid Runner v2 signature is required");
          return;
        }
        try {
          json(response, 200, { assignment: jobRegistry.pull(runnerId) ?? null });
        } catch (caught) {
          error(response, 409, "RUNNER_PULL_REJECTED", caught instanceof Error ? caught.message : "Runner pull was rejected");
        }
        return;
      }

      const runnerModelAccessMatchV2 = url.pathname.match(/^\/v2\/runners\/([0-9a-f-]+)\/jobs\/([0-9a-f-]+)\/model-access$/i);
      if (method === "POST" && runnerModelAccessMatchV2?.[1] !== undefined && runnerModelAccessMatchV2[2] !== undefined) {
        const runnerId = runnerModelAccessMatchV2[1].toLowerCase();
        const jobId = runnerModelAccessMatchV2[2].toLowerCase();
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const value = body.value;
        if (modelAccessBroker === undefined) { error(response, 503, "RUNNER_MODEL_PROXY_DISABLED", "Runner model access is not configured"); return; }
        if (!isRecord(value) || Object.keys(value).length !== 7 || value.protocolVersion !== JOB_PROTOCOL_VERSION || value.runnerId !== runnerId || value.jobId !== jobId || typeof value.requestId !== "string" || typeof value.leaseId !== "string" || (value.tool !== "codex" && value.tool !== "pi" && value.tool !== "claude") || typeof value.sentAt !== "string" || !runnerRegistry.verifyRequestV2(runnerId, singleHeader(request.headers["x-friday-runner-signature"]), method, url.pathname, body.raw)) {
          error(response, 401, "RUNNER_DEVICE_AUTH_REQUIRED", "A valid signed Runner model access request is required");
          return;
        }
        try {
          json(response, 201, { grant: modelAccessBroker.issue(value as unknown as RunnerModelAccessRequestV2) });
        } catch {
          error(response, 409, "MODEL_ACCESS_REJECTED", "Model access does not match an active assigned Job lease");
        }
        return;
      }

      const artifactUploadMatchV2 = url.pathname.match(/^\/v2\/runners\/([0-9a-f-]+)\/jobs\/([0-9a-f-]+)\/artifacts\/([0-9a-f-]+)$/i);
      if (method === "POST" && artifactUploadMatchV2?.[1] !== undefined && artifactUploadMatchV2[2] !== undefined && artifactUploadMatchV2[3] !== undefined) {
        const runnerId = artifactUploadMatchV2[1].toLowerCase(); const jobId = artifactUploadMatchV2[2].toLowerCase(); const artifactId = artifactUploadMatchV2[3].toLowerCase();
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!runnerRegistry.verifyRequestV2(runnerId, singleHeader(request.headers["x-friday-runner-signature"]), method, url.pathname, body.raw) || !isRecord(body.value) || body.value.protocolVersion !== JOB_PROTOCOL_VERSION || body.value.runnerId !== runnerId || body.value.jobId !== jobId || body.value.artifactId !== artifactId || typeof body.value.leaseId !== "string" || typeof body.value.name !== "string" || typeof body.value.mediaType !== "string" || typeof body.value.sha256 !== "string" || !Number.isSafeInteger(body.value.sizeBytes) || typeof body.value.contentBase64 !== "string" || Object.keys(body.value).length !== 10) { error(response, 400, "INVALID_ARTIFACT_UPLOAD", "Artifact upload is invalid"); return; }
        const bytes = strictBase64(body.value.contentBase64);
        if (bytes === undefined) { error(response, 400, "INVALID_ARTIFACT_UPLOAD", "Artifact bytes are invalid"); return; }
        const upload = { name: body.value.name, mediaType: body.value.mediaType, sha256: body.value.sha256, sizeBytes: body.value.sizeBytes as number };
        try {
          jobRegistry.assertActiveLease(jobId, runnerId, body.value.leaseId);
          json(response, 201, { artifact: await artifactStore.save({ artifactId, jobId, ...upload }, bytes) });
        } catch { error(response, 409, "ARTIFACT_UPLOAD_REJECTED", "Artifact upload was rejected"); }
        return;
      }

      const runnerEventMatchV2 = url.pathname.match(/^\/v2\/runners\/([0-9a-f-]+)\/jobs\/([0-9a-f-]+)\/events$/i);
      if (method === "POST" && runnerEventMatchV2?.[1] !== undefined && runnerEventMatchV2[2] !== undefined) {
        const runnerId = runnerEventMatchV2[1].toLowerCase();
        const jobId = runnerEventMatchV2[2].toLowerCase();
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const event = parseRunnerJobEvent(body.value, runnerId, jobId);
        if (event === undefined || !runnerRegistry.verifyRequestV2(runnerId, singleHeader(request.headers["x-friday-runner-signature"]), method, url.pathname, body.raw)) {
          error(response, 401, "RUNNER_DEVICE_AUTH_REQUIRED", "A valid Runner v2 signature is required");
          return;
        }
        try {
          const result = jobRegistry.acceptEvent(event);
          if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(result.job.status)) modelAccessBroker?.revokeJob(jobId);
          if (!result.duplicate) jobChannelNotifier.observe(jobId);
          const promotion = await selfImprovementCoordinator.observe(jobId);
          json(response, result.duplicate ? 200 : 202, { accepted: true, duplicate: result.duplicate, job: result.job, ...(promotion === undefined ? {} : { selfImprovement: promotion }) });
        } catch (caught) {
          error(response, 409, "RUNNER_EVENT_REJECTED", caught instanceof Error ? caught.message : "Runner event was rejected");
        }
        return;
      }

      const runnerReconcileMatchV2 = url.pathname.match(/^\/v2\/runners\/([0-9a-f-]+)\/jobs\/([0-9a-f-]+)\/reconcile$/i);
      if (method === "POST" && runnerReconcileMatchV2?.[1] !== undefined && runnerReconcileMatchV2[2] !== undefined) {
        const runnerId = runnerReconcileMatchV2[1].toLowerCase();
        const jobId = runnerReconcileMatchV2[2].toLowerCase();
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isRecord(body.value) || body.value.protocolVersion !== JOB_PROTOCOL_VERSION || body.value.runnerId !== runnerId || body.value.jobId !== jobId || typeof body.value.leaseId !== "string" || !runnerRegistry.verifyRequestV2(runnerId, singleHeader(request.headers["x-friday-runner-signature"]), method, url.pathname, body.raw)) {
          error(response, 401, "RUNNER_DEVICE_AUTH_REQUIRED", "A valid Runner v2 signature is required");
          return;
        }
        try {
          json(response, 200, { reconciled: true, job: jobRegistry.reconcile(jobId, runnerId, body.value.leaseId) });
        } catch (caught) {
          error(response, 409, "RUNNER_RECONCILE_REJECTED", caught instanceof Error ? caught.message : "Runner reconcile was rejected");
        }
        return;
      }

      const runnerRevokeMatch = url.pathname.match(/^\/v1\/runners\/([0-9a-f-]+)\/revoke$/i);
      if (method === "POST" && runnerRevokeMatch?.[1] !== undefined) {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isEmptyObject(body.value)) {
          error(response, 400, "INVALID_RUNNER_REVOKE_REQUEST", "Body must be an empty JSON object");
          return;
        }
        const result = runnerRegistry.revokeDevice(runnerRevokeMatch[1].toLowerCase());
        if (result.outcome === "not_found") {
          error(response, 404, "RUNNER_DEVICE_NOT_FOUND", "No enrolled Runner device matches this id");
          return;
        }
        json(response, 200, {
          revoked: true,
          duplicate: result.outcome === "already_revoked",
          runnerId: runnerRevokeMatch[1].toLowerCase(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/runners/enrollment-tokens") {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        if (!isEmptyObject(body.value)) {
          error(response, 400, "INVALID_ENROLLMENT_TOKEN_REQUEST", "Body must be an empty JSON object");
          return;
        }
        const enrollment = runnerRegistry.issueEnrollment();
        json(response, 201, enrollment);
        return;
      }

      if (isRunnerEnrollment) {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const enrollment = parseRunnerEnrollment(body.value);
        if (enrollment === undefined) {
          error(response, 400, "INVALID_RUNNER_ENROLLMENT", "Body does not match RunnerEnrollment v1");
          return;
        }
        const result = runnerRegistry.consumeEnrollment(
          enrollment.runnerId,
          enrollment.enrollmentToken,
          enrollment.publicKeyPem,
        );
        if (result.outcome === "invalid_key") {
          error(response, 400, "INVALID_RUNNER_PUBLIC_KEY", "Runner enrollment requires an Ed25519 public key");
          return;
        }
        if (result.outcome === "invalid") {
          error(response, 401, "INVALID_ENROLLMENT_TOKEN", "Runner enrollment token is invalid");
          return;
        }
        if (result.outcome === "expired") {
          error(response, 410, "ENROLLMENT_TOKEN_EXPIRED", "Runner enrollment token has expired");
          return;
        }
        if (result.outcome === "consumed") {
          error(response, 409, "ENROLLMENT_TOKEN_CONSUMED", "Runner enrollment token was already consumed");
          return;
        }
        json(response, result.duplicate ? 200 : 201, {
          enrolled: true,
          duplicate: result.duplicate,
          runnerId: enrollment.runnerId,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/messages") {
        const message = parseInboundMessage((await parseJsonBody(request, config.maxBodyBytes)).value);
        if (message === undefined) {
          error(response, 400, "INVALID_INBOUND_MESSAGE", "Body does not match InboundMessage v1");
          return;
        }
        if (message.channel !== "web") {
          error(response, 400, "CHANNEL_NOT_ENABLED", "M0 /v1/messages only accepts direct Web messages");
          return;
        }
        if (message.senderId !== config.ownerId) {
          error(response, 403, "OWNER_MISMATCH", "senderId must match the configured M0 owner");
          return;
        }
        const messageDigest = jsonDigest(message);

        const result = await mutate(async () => {
          const existing = [...state.jobs.values()].find((job) => job.sourceMessageId === message.messageId);
          if (existing !== undefined) {
            const acceptedDigest = state.acceptedMessageDigests.get(message.messageId);
            if (acceptedDigest === undefined) {
              throw new Error("Accepted message has no durable idempotency digest");
            }
            return acceptedDigest === messageDigest
              ? { outcome: "duplicate" as const, job: existing }
              : { outcome: "conflict" as const };
          }

          const job: JobView = {
            jobId: randomUUID(),
            sourceMessageId: message.messageId,
            status: "NEW",
            createdAt: new Date().toISOString(),
          };
          const event = await store.append("message.accepted", {
            messageId: message.messageId,
            messageDigest,
            job,
          });
          state.apply(event);
          return { outcome: "accepted" as const, job };
        });
        if (result.outcome === "conflict") {
          error(response, 409, "MESSAGE_ID_CONFLICT", "messageId was already accepted with different content");
          return;
        }
        const duplicate = result.outcome === "duplicate";
        json(response, duplicate ? 200 : 202, { accepted: true, duplicate, job: result.job });
        return;
      }

      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)$/i);
      if (method === "GET" && jobMatch?.[1] !== undefined) {
        const job = state.jobs.get(jobMatch[1]);
        if (job === undefined) {
          error(response, 404, "JOB_NOT_FOUND", "No job exists with that id");
          return;
        }
        json(response, 200, { job });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/runners/register") {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const envelope = parseRunnerEnvelope(body.value, "register");
        if (envelope === undefined || envelope.kind !== "register") {
          error(response, 400, "INVALID_RUNNER_REGISTER", "Body does not match RunnerEnvelope register v1");
          return;
        }
        if (
          !runnerRegistry.verifyRequest(
            envelope.runnerId,
            singleHeader(request.headers["x-friday-runner-signature"]),
            method,
            url.pathname,
            body.raw,
          )
        ) {
          error(response, 401, "RUNNER_DEVICE_AUTH_REQUIRED", "A valid enrolled Runner device signature is required");
          return;
        }
        const receivedAt = new Date().toISOString();
        const envelopeDigest = runnerEnvelopeDigest(envelope);
        const result = await mutate(async () => {
          const seen = state.runnerEnvelopeIdentity(envelope.envelopeId);
          if (seen !== undefined) {
            if (
              seen.runnerId !== envelope.runnerId ||
              seen.kind !== envelope.kind ||
              seen.digest !== envelopeDigest
            ) {
              return { outcome: "conflict" as const };
            }
            const runner = state.runnerView(envelope.runnerId);
            if (runner === undefined) {
              throw new Error("Seen runner registration has no materialized runner");
            }
            return { outcome: "duplicate" as const, runner };
          }
          if (!runnerSentAtWithinAllowedSkew(envelope.sentAt, receivedAt)) {
            return { outcome: "clock_skew" as const };
          }

          const event = await store.append("runner.registered", { envelope, receivedAt });
          state.apply(event, { live: true });
          const runner = state.runnerView(envelope.runnerId);
          if (runner === undefined) {
            throw new Error("Runner registration did not materialize state");
          }
          return { outcome: "accepted" as const, runner };
        });
        if (result.outcome === "conflict") {
          error(response, 409, "ENVELOPE_ID_CONFLICT", "envelopeId was already used by another runner envelope");
          return;
        }
        if (result.outcome === "clock_skew") {
          error(response, 409, "RUNNER_CLOCK_SKEW", "Runner sentAt must be within five minutes of Hub time");
          return;
        }
        json(response, result.outcome === "duplicate" ? 200 : 202, {
          accepted: true,
          duplicate: result.outcome === "duplicate",
          runner: result.runner,
        });
        return;
      }

      const heartbeatMatch = url.pathname.match(/^\/v1\/runners\/([^/]+)\/heartbeat$/);
      if (method === "POST" && heartbeatMatch?.[1] !== undefined) {
        const body = await parseJsonBody(request, config.maxBodyBytes);
        const envelope = parseRunnerEnvelope(body.value, "heartbeat");
        if (
          envelope === undefined ||
          envelope.kind !== "heartbeat" ||
          envelope.runnerId !== heartbeatMatch[1].toLowerCase()
        ) {
          error(response, 400, "INVALID_RUNNER_HEARTBEAT", "Body does not match RunnerEnvelope heartbeat v1");
          return;
        }
        if (
          !runnerRegistry.verifyRequest(
            envelope.runnerId,
            singleHeader(request.headers["x-friday-runner-signature"]),
            method,
            url.pathname,
            body.raw,
          )
        ) {
          error(response, 401, "RUNNER_DEVICE_AUTH_REQUIRED", "A valid enrolled Runner device signature is required");
          return;
        }
        const receivedAt = new Date().toISOString();
        const envelopeDigest = runnerEnvelopeDigest(envelope);
        const result = await mutate(async () => {
          const current = state.runners.get(envelope.runnerId);
          if (current === undefined) return { outcome: "not_registered" as const };

          const seen = state.runnerEnvelopeIdentity(envelope.envelopeId);
          if (seen !== undefined) {
            return seen.runnerId === envelope.runnerId &&
              seen.kind === envelope.kind &&
              seen.digest === envelopeDigest
              ? { outcome: "duplicate" as const }
              : { outcome: "conflict" as const };
          }
          if (!runnerSentAtWithinAllowedSkew(envelope.sentAt, receivedAt)) {
            return { outcome: "clock_skew" as const };
          }
          if (Date.parse(envelope.sentAt) < Date.parse(current.lastSentAt)) {
            return { outcome: "sent_at_regression" as const };
          }

          const event = await store.append("runner.heartbeat", {
            envelope,
            receivedAt,
          });
          state.apply(event, { live: true });
          return { outcome: "accepted" as const };
        });
        if (result.outcome === "not_registered") {
          error(response, 409, "RUNNER_NOT_REGISTERED", "Register the runner before sending heartbeats");
          return;
        }
        if (result.outcome === "conflict") {
          error(response, 409, "ENVELOPE_ID_CONFLICT", "envelopeId was already used by another runner envelope");
          return;
        }
        if (result.outcome === "clock_skew") {
          error(response, 409, "RUNNER_CLOCK_SKEW", "Runner sentAt must be within five minutes of Hub time");
          return;
        }
        if (result.outcome === "sent_at_regression") {
          error(response, 409, "HEARTBEAT_SENT_AT_REGRESSION", "Heartbeat sentAt is older than the latest accepted runner envelope");
          return;
        }
        json(response, result.outcome === "duplicate" ? 200 : 202, {
          accepted: true,
          duplicate: result.outcome === "duplicate",
        });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/runners") {
        json(response, 200, { runners: state.listRunners() });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/events") {
        const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
        json(response, 200, { events: store.list(Number.isNaN(after) ? 0 : after) });
        return;
      }

      error(response, 404, "NOT_FOUND", "No route matches this request");
    } catch (caught) {
      if ((caught as Error).message === "BODY_TOO_LARGE") {
        error(response, 413, "BODY_TOO_LARGE", "Request body exceeds the configured limit");
        return;
      }
      if (caught instanceof SyntaxError || (caught as Error).message === "EMPTY_BODY") {
        error(response, 400, "INVALID_JSON", "Request body must contain one JSON object");
        return;
      }
      console.error(caught);
      error(response, 500, "INTERNAL_ERROR", "The request could not be completed");
    }
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((caught: unknown) => {
      console.error(caught);
      if (!response.headersSent) {
        error(response, 500, "INTERNAL_ERROR", "The request could not be completed");
      } else {
        response.destroy(caught instanceof Error ? caught : undefined);
      }
    });
  });

  return {
    server,
    store,
    runnerRegistry,
    jobRegistry,
    mcpRegistry,
    adapterRegistry,
    ...(procedureRegistry === undefined ? {} : { procedureRegistry }),
    ...(skillRegistry === undefined ? {} : { skillRegistry }),
    selfPatchRegistry,
    selfImprovementJobRegistry,
    voiceMediaRegistry,
    conversationMediaRegistry,
    conversationRegistry,
    channelOutbox,
    ...(modelAccessBroker === undefined ? {} : { modelAccessBroker }),
    artifactStore,
    hubIdentity,
    state,
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (caught: Error): void => {
          server.off("error", onError);
          webauthnRegistry?.close();
          channelOutbox.close();
          channelRegistry.close();
          voiceMediaRegistry.close();
          conversationMediaRegistry.close();
          conversationRegistry.close();
          memoryRegistry.close();
          procedureRegistry?.close();
          skillRegistry?.close();
          selfPatchRegistry.close();
          selfImprovementJobRegistry.close();
          mcpRegistry.close();
          adapterRegistry.close();
          jobRegistry.close();
          runnerRegistry.close();
          void Promise.all([store.close(), conversationOrchestrator?.close() ?? Promise.resolve()]).then(
            () => reject(caught),
            (closeError: unknown) => reject(new AggregateError([caught, closeError], "fridayd bind and cleanup failed")),
          );
        };
        server.once("error", onError);
        server.listen(config.port, config.host, () => {
          server.off("error", onError);
          const address = server.address();
          if (address === null || typeof address === "string") {
            const addressError = new Error("fridayd did not bind a TCP address");
            webauthnRegistry?.close();
            channelOutbox.close();
            channelRegistry.close();
            voiceMediaRegistry.close();
            conversationMediaRegistry.close();
            conversationRegistry.close();
            memoryRegistry.close();
            procedureRegistry?.close();
            skillRegistry?.close();
            selfPatchRegistry.close();
            selfImprovementJobRegistry.close();
            mcpRegistry.close();
            adapterRegistry.close();
            jobRegistry.close();
            runnerRegistry.close();
            void Promise.all([store.close(), conversationOrchestrator?.close() ?? Promise.resolve()]).then(
              () => reject(addressError),
              (closeError: unknown) => reject(new AggregateError([addressError, closeError], "fridayd address and cleanup failed")),
            );
            return;
          }
          resolve({ host: config.host, port: address.port });
        });
      }),
    stop: async () => {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((caught) => (caught === undefined ? resolve() : reject(caught)));
        });
      }
      await mutationBarrier;
      await conversationOrchestrator?.close();
      webauthnRegistry?.close();
      channelOutbox.close();
      channelRegistry.close();
      voiceMediaRegistry.close();
      conversationMediaRegistry.close();
      conversationRegistry.close();
      memoryRegistry.close();
      procedureRegistry?.close();
      skillRegistry?.close();
      selfPatchRegistry.close();
      selfImprovementJobRegistry.close();
      mcpRegistry.close();
      adapterRegistry.close();
      jobRegistry.close();
      runnerRegistry.close();
      await store.close();
    },
  };
}
