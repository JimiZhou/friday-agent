import { createHash, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  type JsonValue,
  type PiWorkerEnvelopeV1,
  type PiWorkerImageV1,
} from "@friday/protocol";
import { PiRpcProxy } from "./pi-proxy.js";

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_MODEL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MODEL_IMAGES = 6;
const MAX_REPLAY_ENTRIES = 4096;

const OPERATIONS = [
  "ping",
  "start",
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "get_state",
  "compact",
  "close",
] as const;

type Operation = (typeof OPERATIONS)[number];

type RequestEnvelope = Extract<PiWorkerEnvelopeV1, { kind: "request" }>;
type ResponseEnvelope = Extract<PiWorkerEnvelopeV1, { kind: "response" }>;

interface SessionState {
  readonly sessionId: string;
  phase: "idle" | "ready" | "aborted" | "closed";
  promptCount: number;
  steerCount: number;
  followUpCount: number;
  compactionCount: number;
  updatedAt: string;
}

interface ParsedRequest {
  readonly envelope: RequestEnvelope;
  readonly operation: Operation;
  readonly payload: JsonValue;
}

interface DispatchResult {
  readonly payload: Record<string, unknown>;
  readonly sessionId?: string;
}

interface ProtocolFailure {
  readonly code: string;
  readonly message: string;
}

interface ReplayIdentity {
  readonly envelopeId: string;
  readonly requestId: string;
  readonly responseRequestId: string;
  readonly digest: string;
}

interface ReplayEntry {
  readonly digest: string;
  readonly response: ResponseEnvelope;
}

class RequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}

export interface PiSupervisorOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly errorOutput?: Writable;
  readonly piBin?: string | undefined;
  readonly maxLineBytes?: number;
  readonly maxReplayEntries?: number;
}

export class PiSupervisor {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #errorOutput: Writable;
  readonly #piBin: string | undefined;
  readonly #maxLineBytes: number;
  readonly #maxReplayEntries: number;
  readonly #sessions = new Map<string, SessionState>();
  readonly #requestsByRequestId = new Map<string, ReplayEntry>();
  readonly #requestsByEnvelopeId = new Map<string, ReplayEntry>();
  readonly #conflictResponses = new Map<string, ResponseEnvelope>();
  readonly #cachedDigests = new Set<string>();
  #proxy: PiRpcProxy | undefined;
  #proxySessionId: string | undefined;
  #proxyEventSequence = 0;
  #queue: Promise<void> = Promise.resolve();
  #buffer = "";
  #running = false;
  #discardingOversizedLine = false;

  constructor(options: PiSupervisorOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#errorOutput = options.errorOutput ?? process.stderr;
    this.#piBin = normalizeOptionalString(options.piBin ?? process.env.FRIDAY_PI_BIN);
    this.#maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
    this.#maxReplayEntries = options.maxReplayEntries ?? MAX_REPLAY_ENTRIES;

    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes < 1) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxReplayEntries) || this.#maxReplayEntries < 1) {
      throw new RangeError("maxReplayEntries must be a positive safe integer");
    }
  }

  get mode(): "stub" | "rpc" {
    return this.#piBin === undefined ? "stub" : "rpc";
  }

  run(): void {
    if (this.#running) {
      throw new Error("PiSupervisor is already running");
    }

    this.#running = true;
    this.#input.setEncoding("utf8");
    this.#input.on("data", (chunk: string) => this.#consume(chunk));
    this.#input.on("end", () => this.#finish());
    this.#input.on("error", (error: Error) => {
      this.#writeDiagnostic(`stdin error: ${error.message}`);
      process.exitCode = 1;
    });
  }

  /** Test and host hook: resolves after all already-framed client records run. */
  async idle(): Promise<void> { await this.#queue; }

  #consume(chunk: string): void {
    if (this.#discardingOversizedLine) {
      const discardedLineEnd = chunk.indexOf("\n");
      if (discardedLineEnd === -1) {
        return;
      }
      this.#discardingOversizedLine = false;
      chunk = chunk.slice(discardedLineEnd + 1);
    }

    this.#buffer += chunk;

    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      this.#enqueue(line);
      newlineIndex = this.#buffer.indexOf("\n");
    }

    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxLineBytes) {
      this.#writeFailure(randomUUID(), {
        code: "LINE_TOO_LONG",
        message: `JSONL input exceeds ${this.#maxLineBytes} bytes`,
      });
      this.#buffer = "";
      this.#discardingOversizedLine = true;
    }
  }

  #finish(): void {
    void this.#queue.then(async () => {
      if (this.#discardingOversizedLine) { this.#discardingOversizedLine = false; return; }
      if (this.#buffer.length > 0) {
        this.#writeFailure(extractRequestId(this.#buffer), { code: "LF_REQUIRED", message: "Every JSONL record must end with a single LF byte" });
        this.#buffer = "";
      }
      await this.#proxy?.close();
    }).catch((error: unknown) => this.#writeDiagnostic(`shutdown error: ${error instanceof Error ? error.message : String(error)}`));
  }

  #enqueue(line: string): void {
    this.#queue = this.#queue.then(() => this.#handleLine(line)).catch((error: unknown) => {
      this.#writeDiagnostic(`request processing error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async #handleLine(line: string): Promise<void> {
    if (line.length === 0) {
      this.#writeFailure(randomUUID(), {
        code: "EMPTY_LINE",
        message: "Empty JSONL records are not allowed",
      });
      return;
    }

    if (line.includes("\r")) {
      this.#writeFailure(extractRequestId(line), {
        code: "LF_REQUIRED",
        message: "CR and CRLF framing are not accepted; use LF JSONL",
      });
      return;
    }

    if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
      this.#writeFailure(extractRequestId(line), {
        code: "LINE_TOO_LONG",
        message: `JSONL input exceeds ${this.#maxLineBytes} bytes`,
      });
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.#writeFailure(randomUUID(), {
        code: "INVALID_JSON",
        message: "Input must be one JSON object per LF-terminated line",
      });
      return;
    }

    let replayIdentity: ReplayIdentity | undefined;
    try {
      replayIdentity = readReplayIdentity(value);
    } catch {
      this.#writeFailure(extractRequestId(value), {
        code: "INVALID_ENVELOPE",
        message: "Request could not be canonicalized as a JSON value",
      });
      return;
    }
    if (replayIdentity !== undefined) {
      const replay = this.#findReplay(replayIdentity);
      if (replay !== undefined) {
        this.#writeEnvelope(replay);
        return;
      }
      if (!this.#hasReplayCapacity(replayIdentity.digest)) {
        this.#writeEnvelope(
          deterministicFailureEnvelope(replayIdentity, {
            code: "REQUEST_REPLAY_CACHE_FULL",
            message: `Replay cache reached its ${this.#maxReplayEntries}-request limit; restart the worker before sending new request ids`,
          }),
        );
        return;
      }
    }

    let request: ParsedRequest;
    try {
      request = parseRequest(value);
    } catch (error) {
      const failure = asProtocolFailure(error);
      const response = this.#failureEnvelope(extractRequestId(value), failure);
      this.#rememberReplay(replayIdentity, response);
      this.#writeEnvelope(response);
      return;
    }

    let response: ResponseEnvelope;
    try {
      const result = await this.#dispatch(request);
      response = this.#successEnvelope(
        request.envelope.requestId,
        result.payload,
        result.sessionId ?? request.envelope.sessionId,
      );
    } catch (error) {
      const failure = asProtocolFailure(error);
      response = this.#failureEnvelope(
        request.envelope.requestId,
        failure,
        request.envelope.sessionId,
      );
    }
    this.#rememberReplay(replayIdentity, response);
    this.#writeEnvelope(response);
  }

  #findReplay(identity: ReplayIdentity): ResponseEnvelope | undefined {
    const byRequestId = this.#requestsByRequestId.get(identity.requestId);
    const byEnvelopeId = this.#requestsByEnvelopeId.get(identity.envelopeId);
    const known = [byRequestId, byEnvelopeId].filter(
      (entry): entry is ReplayEntry => entry !== undefined,
    );
    if (known.length === 0) {
      return undefined;
    }

    if (known.every((entry) => entry.digest === identity.digest)) {
      const replay = known[0];
      if (replay === undefined) {
        throw new Error("Replay lookup lost its cached response");
      }
      this.#rememberReplay(identity, replay.response, true);
      return replay.response;
    }

    let conflict = this.#conflictResponses.get(identity.digest);
    if (conflict === undefined) {
      const failure = {
        code: "REQUEST_REPLAY_CONFLICT",
        message: "requestId or envelopeId was already used by a different request",
      };
      if (!this.#hasReplayCapacity(identity.digest)) {
        return deterministicFailureEnvelope(identity, failure);
      }
      conflict = this.#failureEnvelope(identity.responseRequestId, failure);
      this.#conflictResponses.set(identity.digest, conflict);
    }
    this.#rememberReplay(identity, conflict, true);
    return conflict;
  }

  #rememberReplay(
    identity: ReplayIdentity | undefined,
    response: ResponseEnvelope,
    preserveExisting = false,
  ): void {
    if (identity === undefined) {
      return;
    }
    if (!this.#cachedDigests.has(identity.digest)) {
      if (!this.#hasReplayCapacity(identity.digest)) {
        throw new Error("Replay cache capacity must be checked before dispatch");
      }
      this.#cachedDigests.add(identity.digest);
    }
    const entry: ReplayEntry = { digest: identity.digest, response };
    if (!preserveExisting || !this.#requestsByRequestId.has(identity.requestId)) {
      this.#requestsByRequestId.set(identity.requestId, entry);
    }
    if (!preserveExisting || !this.#requestsByEnvelopeId.has(identity.envelopeId)) {
      this.#requestsByEnvelopeId.set(identity.envelopeId, entry);
    }
  }

  #hasReplayCapacity(digest: string): boolean {
    return this.#cachedDigests.has(digest) || this.#cachedDigests.size < this.#maxReplayEntries;
  }

  async #dispatch(request: ParsedRequest): Promise<DispatchResult> {
    const { envelope, operation, payload } = request;

    switch (operation) {
      case "ping":
        return {
          payload: {
            alive: true,
            mode: this.mode,
            piProxyConfigured: this.#piBin !== undefined,
            protocolVersion: PROTOCOL_VERSION,
          },
        };
      case "start": {
        const sessionId = isRecord(payload) ? readOptionalUuid(payload, "sessionId") ?? randomUUID() : randomUUID();
        if (this.#sessions.has(sessionId)) {
          throw new RequestError("SESSION_EXISTS", `Session ${sessionId} already exists`);
        }
        if (this.#piBin !== undefined) {
          if (this.#proxySessionId !== undefined) throw new RequestError("PI_SESSION_BUSY", "Only one external Pi session is allowed per isolated worker");
          await this.#externalProxy().start();
          this.#proxySessionId = sessionId;
        }

        const state: SessionState = {
          sessionId,
          phase: "ready",
          promptCount: 0,
          steerCount: 0,
          followUpCount: 0,
          compactionCount: 0,
          updatedAt: new Date().toISOString(),
        };
        this.#sessions.set(sessionId, state);
        return { payload: { state: snapshot(state) }, sessionId };
      }
      case "prompt": {
        const state = this.#requireActiveSession(envelope.sessionId);
        state.promptCount += 1;
        touch(state);
        const input = readTextPayload(payload);
        const piResponse = this.#piBin === undefined ? undefined : await this.#externalProxy().command("prompt", input.text, input.images);
        return { payload: { accepted: true, state: snapshot(state), ...(piResponse === undefined ? {} : { piResponse }) } };
      }
      case "steer": {
        const state = this.#requireActiveSession(envelope.sessionId);
        state.steerCount += 1;
        touch(state);
        const input = readTextPayload(payload);
        const piResponse = this.#piBin === undefined ? undefined : await this.#externalProxy().command("steer", input.text, input.images);
        return { payload: { accepted: true, state: snapshot(state), ...(piResponse === undefined ? {} : { piResponse }) } };
      }
      case "follow_up": {
        const state = this.#requireActiveSession(envelope.sessionId);
        state.followUpCount += 1;
        touch(state);
        const input = readTextPayload(payload);
        const piResponse = this.#piBin === undefined ? undefined : await this.#externalProxy().command("follow_up", input.text, input.images);
        return { payload: { accepted: true, state: snapshot(state), ...(piResponse === undefined ? {} : { piResponse }) } };
      }
      case "abort": {
        const state = this.#requireSession(envelope.sessionId);
        if (state.phase === "closed") {
          throw new RequestError("SESSION_CLOSED", `Session ${state.sessionId} is closed`);
        }
        state.phase = "aborted";
        touch(state);
        const piResponse = this.#piBin === undefined ? undefined : await this.#externalProxy().command("abort");
        return { payload: { aborted: true, state: snapshot(state), ...(piResponse === undefined ? {} : { piResponse }) } };
      }
      case "get_state": {
        const state = this.#requireSession(envelope.sessionId);
        const piResponse = this.#piBin === undefined ? undefined : await this.#externalProxy().command("get_state");
        return { payload: { state: snapshot(state), ...(piResponse === undefined ? {} : { piResponse }) } };
      }
      case "compact": {
        const state = this.#requireActiveSession(envelope.sessionId);
        state.compactionCount += 1;
        touch(state);
        const piResponse = this.#piBin === undefined ? undefined : await this.#externalProxy().command("compact");
        return { payload: { compacted: true, state: snapshot(state), ...(piResponse === undefined ? {} : { piResponse }) } };
      }
      case "close": {
        const state = this.#requireSession(envelope.sessionId);
        state.phase = "closed";
        touch(state);
        if (this.#proxySessionId === state.sessionId) {
          this.#proxySessionId = undefined;
          const proxy = this.#proxy;
          this.#proxy = undefined;
          await proxy?.close();
        }
        return { payload: { closed: true, state: snapshot(state) } };
      }
    }
  }

  #externalProxy(): PiRpcProxy {
    if (this.#piBin === undefined) throw new Error("Pi RPC proxy is not configured");
    if (this.#proxy === undefined) {
      this.#proxy = new PiRpcProxy({
        piBin: this.#piBin,
        onDiagnostic: (message) => this.#writeDiagnostic(message),
        onEvent: (record) => this.#writeEnvelope({
          protocolVersion: PROTOCOL_VERSION,
          envelopeId: randomUUID(),
          sentAt: new Date().toISOString(),
          kind: "event",
          sequence: this.#proxyEventSequence++,
          event: "state_changed",
          ...(this.#proxySessionId === undefined ? {} : { sessionId: this.#proxySessionId }),
          payload: { source: "pi-rpc", record },
        }),
      });
    }
    return this.#proxy;
  }

  #requireSession(sessionId: string | undefined): SessionState {
    if (sessionId === undefined) {
      throw new RequestError("SESSION_REQUIRED", "sessionId is required for this operation");
    }

    const state = this.#sessions.get(sessionId);
    if (state === undefined) {
      throw new RequestError("SESSION_NOT_FOUND", `Unknown session ${sessionId}`);
    }
    return state;
  }

  #requireActiveSession(sessionId: string | undefined): SessionState {
    const state = this.#requireSession(sessionId);
    if (state.phase === "closed") {
      throw new RequestError("SESSION_CLOSED", `Session ${state.sessionId} is closed`);
    }
    return state;
  }

  #successEnvelope(
    requestId: string,
    payload: Record<string, unknown>,
    sessionId?: string,
  ): ResponseEnvelope {
    const common = {
      protocolVersion: PROTOCOL_VERSION,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "response" as const,
      requestId,
      ok: true,
      payload,
    };
    const envelope = sessionId === undefined ? common : { ...common, sessionId };
    return envelope as ResponseEnvelope;
  }

  #writeFailure(requestId: string, error: ProtocolFailure, sessionId?: string): void {
    this.#writeEnvelope(this.#failureEnvelope(requestId, error, sessionId));
  }

  #failureEnvelope(
    requestId: string,
    error: ProtocolFailure,
    sessionId?: string,
  ): ResponseEnvelope {
    const common = {
      protocolVersion: PROTOCOL_VERSION,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "response" as const,
      requestId,
      ok: false,
      error: { ...error, retryable: false },
    };
    const envelope = sessionId === undefined ? common : { ...common, sessionId };
    return envelope as ResponseEnvelope;
  }

  #writeEnvelope(envelope: PiWorkerEnvelopeV1): void {
    const line = JSON.stringify(envelope);
    if (line.includes("\n") || line.includes("\r")) {
      throw new Error("Serialized JSONL envelopes must not contain literal line breaks");
    }
    this.#output.write(`${line}\n`);
  }

  #writeDiagnostic(message: string): void {
    this.#errorOutput.write(`[pi-worker] ${message}\n`);
  }
}

function parseRequest(value: unknown): ParsedRequest {
  if (!isRecord(value)) {
    throw new RequestError("INVALID_ENVELOPE", "Request must be a JSON object");
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new RequestError("UNSUPPORTED_PROTOCOL", `protocolVersion must be ${PROTOCOL_VERSION}`);
  }
  if (value.kind !== "request") {
    throw new RequestError("INVALID_ENVELOPE", "kind must be request");
  }
  const allowedKeys = new Set([
    "protocolVersion",
    "envelopeId",
    "sentAt",
    "sessionId",
    "kind",
    "requestId",
    "operation",
    "payload",
  ]);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    throw new RequestError("INVALID_ENVELOPE", `Unknown envelope property: ${unknownKey}`);
  }
  requireNonEmptyString(value, "envelopeId");
  requireNonEmptyString(value, "requestId");
  requireIsoTimestamp(value, "sentAt");

  if (value.sessionId !== undefined && !isNonEmptyString(value.sessionId)) {
    throw new RequestError("INVALID_ENVELOPE", "sessionId must be a non-empty string when present");
  }

  if (typeof value.operation !== "string" || !isOperation(value.operation)) {
    throw new RequestError("UNKNOWN_OPERATION", "operation is not supported");
  }

  if (!isUuid(value.envelopeId)) {
    throw new RequestError("INVALID_ENVELOPE", "envelopeId must be a UUID");
  }
  if (!isUuid(value.requestId)) {
    throw new RequestError("INVALID_ENVELOPE", "requestId must be a UUID");
  }
  if (value.sessionId !== undefined && !isUuid(value.sessionId)) {
    throw new RequestError("INVALID_ENVELOPE", "sessionId must be a UUID when present");
  }
  if ((value.operation === "ping" || value.operation === "start") && value.sessionId !== undefined) {
    throw new RequestError("INVALID_ENVELOPE", `${value.operation} must not include sessionId`);
  }
  if (value.operation !== "ping" && value.operation !== "start" && value.sessionId === undefined) {
    throw new RequestError("SESSION_REQUIRED", "sessionId is required for this operation");
  }

  if (!Object.hasOwn(value, "payload") || !isJsonValue(value.payload)) {
    throw new RequestError("INVALID_PAYLOAD", "payload must be a JSON value");
  }
  validateOperationPayload(value.operation, value.payload);

  const normalizedPayload = normalizeOperationPayload(value.operation, value.payload);
  const normalizedEnvelope = {
    ...value,
    envelopeId: value.envelopeId.toLowerCase(),
    requestId: value.requestId.toLowerCase(),
    ...(value.sessionId === undefined
      ? {}
      : { sessionId: (value.sessionId as string).toLowerCase() }),
    payload: normalizedPayload,
  } as unknown as RequestEnvelope;

  return {
    envelope: normalizedEnvelope,
    operation: value.operation,
    payload: normalizedPayload,
  };
}

function validateOperationPayload(operation: Operation, payload: JsonValue): void {
  switch (operation) {
    case "ping":
    case "abort":
    case "get_state":
    case "compact":
    case "close":
      if (payload !== null) {
        throw new RequestError("INVALID_PAYLOAD", `${operation} payload must be null`);
      }
      return;
    case "start":
      if (!isRecord(payload) || !hasOnlyKeys(payload, ["sessionId"])) {
        throw new RequestError(
          "INVALID_PAYLOAD",
          "start payload must be an object containing only optional sessionId; {} is valid",
        );
      }
      readOptionalUuid(payload, "sessionId");
      return;
    case "prompt":
    case "steer":
    case "follow_up":
      if (
        !isRecord(payload) ||
        !hasOnlyKeys(payload, ["text", "images"]) ||
        !Object.hasOwn(payload, "text") ||
        typeof payload.text !== "string" ||
        payload.text.length < 1 ||
        (payload.images !== undefined && !validImages(payload.images))
      ) {
        throw new RequestError(
          "INVALID_PAYLOAD",
          `${operation} payload must contain bounded text and optional bounded images`,
        );
      }
      return;
  }
}

function readTextPayload(payload: JsonValue): { readonly text: string; readonly images?: readonly PiWorkerImageV1[] } {
  if (!isRecord(payload) || typeof payload.text !== "string") throw new RequestError("INVALID_PAYLOAD", "text payload is required");
  return {
    text: payload.text,
    ...(Array.isArray(payload.images) ? { images: payload.images as unknown as readonly PiWorkerImageV1[] } : {}),
  };
}

function validImages(value: JsonValue): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MODEL_IMAGES) return false;
  let totalBytes = 0;
  for (const image of value) {
    if (
      !isRecord(image) ||
      !hasOnlyKeys(image, ["type", "data", "mimeType"]) ||
      image.type !== "image" ||
      typeof image.data !== "string" ||
      typeof image.mimeType !== "string" ||
      !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mimeType) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
    ) return false;
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length < 1 || bytes.toString("base64") !== image.data) return false;
    totalBytes += bytes.length;
    if (totalBytes > MAX_MODEL_IMAGE_BYTES) return false;
  }
  return true;
}

function normalizeOperationPayload(operation: Operation, payload: JsonValue): JsonValue {
  if (operation !== "start" || !isRecord(payload) || payload.sessionId === undefined) {
    return payload;
  }
  return { ...payload, sessionId: (payload.sessionId as string).toLowerCase() };
}

function readReplayIdentity(value: unknown): ReplayIdentity | undefined {
  if (!isRecord(value) || !isUuid(value.envelopeId) || !isUuid(value.requestId)) {
    return undefined;
  }
  return {
    envelopeId: value.envelopeId.toLowerCase(),
    requestId: value.requestId.toLowerCase(),
    responseRequestId: value.requestId.toLowerCase(),
    digest: createHash("sha256")
      .update(canonicalJson(normalizeRequestUuids(value)))
      .digest("hex"),
  };
}

function normalizeRequestUuids(value: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...value,
    envelopeId: (value.envelopeId as string).toLowerCase(),
    requestId: (value.requestId as string).toLowerCase(),
  };
  if (isUuid(value.sessionId)) {
    normalized.sessionId = value.sessionId.toLowerCase();
  }
  if (value.operation === "start" && isRecord(value.payload) && isUuid(value.payload.sessionId)) {
    normalized.payload = {
      ...value.payload,
      sessionId: value.payload.sessionId.toLowerCase(),
    };
  }
  return normalized;
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
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Cannot canonicalize a non-JSON value");
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function deterministicFailureEnvelope(
  identity: ReplayIdentity,
  failure: ProtocolFailure,
): ResponseEnvelope {
  const digest = createHash("sha256")
    .update(`friday-pi-worker-response-v1\n${identity.digest}\n${failure.code}`)
    .digest("hex");
  return {
    protocolVersion: PROTOCOL_VERSION,
    envelopeId: uuidFromHexDigest(digest),
    sentAt: "1970-01-01T00:00:00.000Z",
    kind: "response",
    requestId: identity.responseRequestId,
    ok: false,
    error: { ...failure, retryable: false },
  };
}

function uuidFromHexDigest(digest: string): string {
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function isOperation(value: string): value is Operation {
  return (OPERATIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (!isNonEmptyString(value)) {
    throw new RequestError("INVALID_ENVELOPE", `${key} must be a non-empty string`);
  }
  return value;
}

function requireIsoTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requireNonEmptyString(record, key);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new RequestError("INVALID_ENVELOPE", `${key} must be an ISO 8601 timestamp`);
  }
  return value;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function readOptionalUuid(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isUuid(value)) {
    throw new RequestError("INVALID_PAYLOAD", `${key} must be a UUID when present`);
  }
  return value.toLowerCase();
}

function touch(state: SessionState): void {
  state.updatedAt = new Date().toISOString();
}

function snapshot(state: SessionState): Record<string, unknown> {
  return { ...state };
}

function extractRequestId(value: unknown): string {
  if (isRecord(value) && isUuid(value.requestId)) {
    return value.requestId.toLowerCase();
  }

  if (typeof value === "string") {
    try {
      return extractRequestId(JSON.parse(value) as unknown);
    } catch {
      return randomUUID();
    }
  }

  return randomUUID();
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function asProtocolFailure(error: unknown): ProtocolFailure {
  if (error instanceof RequestError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "Unknown supervisor error" };
}
