import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  PROTOCOL_VERSION,
  type JsonValue,
  type PiWorkerEnvelopeV1,
  type PiWorkerImageV1,
  type PiWorkerOperationV1,
  type PiWorkerRequestV1,
} from "@friday/protocol";

import type { ConversationAgent, ConversationAgentTurn } from "./conversation-orchestrator.js";

const MAX_LINE_BYTES = 16 * 1_048_576;
const MAX_ASSISTANT_BYTES = 64 * 1024;

type PiWorkerResponse = Extract<PiWorkerEnvelopeV1, { kind: "response" }>;
type PiWorkerSuccessResponse = Extract<PiWorkerResponse, { ok: true }>;
type PiWorkerEvent = Extract<PiWorkerEnvelopeV1, { kind: "event" }>;

export interface PiWorkerProcessClientOptions {
  readonly nodeExecutable: string;
  readonly workerScriptPath: string;
  readonly workerEnvironment: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly onDiagnostic?: (message: string) => void;
}

interface PendingRequest {
  readonly timer: NodeJS.Timeout;
  resolve(response: PiWorkerResponse): void;
  reject(error: Error): void;
}

interface ActiveTurn {
  readonly sessionId: string;
  readonly settled: Promise<string>;
  readonly timer: NodeJS.Timeout;
  resolve(text: string): void;
  reject(error: Error): void;
  lastAssistantText?: string;
}

/**
 * Strict, crash-contained JSONL client for the separately pinned Pi Worker.
 * A turn uses a fresh ephemeral Pi session and waits for upstream
 * `agent_settled`; the prompt acknowledgement is never mistaken for a reply.
 */
export class PiWorkerProcessClient implements ConversationAgent {
  readonly #nodeExecutable: string;
  readonly #workerScriptPath: string;
  readonly #workerEnvironment: Readonly<Record<string, string>>;
  readonly #requestTimeoutMs: number;
  readonly #turnTimeoutMs: number;
  readonly #onDiagnostic: (message: string) => void;
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #activeTurn: ActiveTurn | undefined;
  #serial: Promise<void> = Promise.resolve();
  #closed = false;
  #verifiedRpcMode = false;
  #completedTurns = 0;

  constructor(options: PiWorkerProcessClientOptions) {
    if (!isAbsolute(options.nodeExecutable) || options.nodeExecutable.includes("\0")) {
      throw new Error("Pi Worker Node executable must be an absolute path");
    }
    if (!isAbsolute(options.workerScriptPath) || options.workerScriptPath.includes("\0")) {
      throw new Error("Pi Worker script must be an absolute path");
    }
    this.#nodeExecutable = options.nodeExecutable;
    this.#workerScriptPath = options.workerScriptPath;
    this.#workerEnvironment = Object.freeze({ ...options.workerEnvironment });
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 180_000;
    this.#onDiagnostic = options.onDiagnostic ?? (() => {});
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 100 || this.#requestTimeoutMs > 60_000) {
      throw new Error("Pi Worker request timeout is invalid");
    }
    if (!Number.isSafeInteger(this.#turnTimeoutMs) || this.#turnTimeoutMs < 1_000 || this.#turnTimeoutMs > 15 * 60_000) {
      throw new Error("Pi Worker turn timeout is invalid");
    }
  }

  runTurn(turn: ConversationAgentTurn): Promise<string> {
    const operation = this.#serial.then(() => this.#runTurn(turn));
    this.#serial = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminate(new Error("Pi Worker client closed"));
    await this.#serial;
  }

  async #runTurn(turn: ConversationAgentTurn): Promise<string> {
    if (this.#closed) throw new Error("Pi Worker client is closed");
    requireUuid(turn.sessionId, "sessionId");
    if (typeof turn.prompt !== "string" || turn.prompt.trim() === "" || Buffer.byteLength(turn.prompt, "utf8") > 256 * 1024) {
      throw new Error("Pi Worker prompt is invalid");
    }
    validateTurnImages(turn.images);
    await this.#ensureRpcMode();
    await this.#request("start", { sessionId: turn.sessionId });
    const active = this.#beginTurn(turn.sessionId);
    try {
      await this.#request("prompt", {
        text: turn.prompt,
        ...(turn.images === undefined || turn.images.length === 0 ? {} : { images: turn.images }),
      } as unknown as JsonValue, turn.sessionId);
      return await active.settled;
    } finally {
      this.#finishTurn(active);
      if (this.#child !== undefined) {
        try {
          await this.#request("close", null, turn.sessionId);
          this.#completedTurns += 1;
          if (this.#completedTurns >= 1_000) {
            this.#completedTurns = 0;
            this.#terminate(new Error("Pi Worker rotated before replay cache saturation"));
          }
        } catch {
          // A failed close means isolation cannot be proven for the next turn.
          this.#terminate(new Error("Pi Worker session close failed"));
        }
      }
    }
  }

  async #ensureRpcMode(): Promise<void> {
    if (this.#verifiedRpcMode) return;
    const response = await this.#request("ping", null);
    if (!isRecord(response.payload) || response.payload.mode !== "rpc" || response.payload.piProxyConfigured !== true) {
      this.#terminate(new Error("Pi Worker is not backed by a configured Pi RPC process"));
      throw new Error("AGENT_DISABLED: Pi Worker stub mode cannot serve conversations");
    }
    this.#verifiedRpcMode = true;
  }

  #beginTurn(sessionId: string): ActiveTurn {
    if (this.#activeTurn !== undefined) throw new Error("Pi Worker already has an active turn");
    let resolveTurn!: (text: string) => void;
    let rejectTurn!: (error: Error) => void;
    const settled = new Promise<string>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const active: ActiveTurn = {
      sessionId,
      settled,
      timer: setTimeout(() => {
        rejectTurn(new Error("Pi Worker turn timed out before agent_settled"));
        this.#terminate(new Error("Pi Worker turn timed out"));
      }, this.#turnTimeoutMs),
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    this.#activeTurn = active;
    return active;
  }

  #finishTurn(active: ActiveTurn): void {
    clearTimeout(active.timer);
    if (this.#activeTurn === active) this.#activeTurn = undefined;
  }

  async #request(operation: PiWorkerOperationV1, payload: JsonValue, sessionId?: string): Promise<PiWorkerSuccessResponse> {
    const child = this.#ensureChild();
    const requestId = randomUUID();
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      envelopeId: randomUUID(),
      sentAt: new Date().toISOString(),
      kind: "request",
      requestId,
      operation,
      payload,
      ...(sessionId === undefined ? {} : { sessionId }),
    } as PiWorkerRequestV1;
    const line = JSON.stringify(envelope);
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("Pi Worker request exceeds the JSONL record limit");
    return new Promise<PiWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Pi Worker ${operation} request timed out`));
        this.#terminate(new Error("Pi Worker request timed out"));
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, { timer, resolve, reject });
      child.stdin.write(`${line}\n`, (error) => {
        if (error !== undefined && error !== null) {
          const pending = this.#pending.get(requestId);
          if (pending !== undefined) {
            this.#pending.delete(requestId);
            clearTimeout(pending.timer);
            pending.reject(new Error(`Pi Worker request could not be written: ${error.message}`));
          }
        }
      });
    }).then((response) => {
      if (!response.ok) throw new Error(`Pi Worker rejected ${operation}: ${response.error.code}`);
      return response;
    });
  }

  #ensureChild(): ChildProcessWithoutNullStreams {
    if (this.#closed) throw new Error("Pi Worker client is closed");
    if (this.#child !== undefined) return this.#child;
    this.#buffer = "";
    const child = spawn(this.#nodeExecutable, [this.#workerScriptPath], {
      env: { ...this.#workerEnvironment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.stderr.on("data", (chunk: string) => this.#onDiagnostic(truncate(chunk.trim(), 512)));
    child.once("error", (error) => this.#terminate(new Error(`Pi Worker process failed: ${error.message}`), child));
    child.once("close", (code, signal) => {
      this.#terminate(new Error(`Pi Worker process exited (${code === null ? signal ?? "unknown" : code})`), child);
    });
    return child;
  }

  #consume(chunk: string): void {
    if (chunk.includes("\r")) {
      this.#terminate(new Error("Pi Worker emitted forbidden CR framing"));
      return;
    }
    this.#buffer += chunk;
    while (true) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === "" || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this.#terminate(new Error("Pi Worker emitted an empty or oversized JSONL record"));
        return;
      }
      let value: unknown;
      try { value = JSON.parse(line) as unknown; } catch {
        this.#terminate(new Error("Pi Worker emitted invalid JSON"));
        return;
      }
      if (!isPiWorkerEnvelope(value)) {
        this.#terminate(new Error("Pi Worker emitted an invalid protocol envelope"));
        return;
      }
      if (value.kind === "response") this.#handleResponse(value);
      else if (value.kind === "event") this.#handleEvent(value);
      else {
        this.#terminate(new Error("Pi Worker emitted a request on its output stream"));
        return;
      }
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES) {
      this.#terminate(new Error("Pi Worker emitted an oversized unterminated record"));
    }
  }

  #handleResponse(response: PiWorkerResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) {
      this.#terminate(new Error("Pi Worker response has no pending request"));
      return;
    }
    this.#pending.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  #handleEvent(event: PiWorkerEvent): void {
    const active = this.#activeTurn;
    if (active === undefined || event.sessionId !== active.sessionId) return;
    const record = unwrapPiRpcRecord(event.payload);
    if (record === undefined || typeof record.type !== "string") return;
    const assistantText = extractAssistantTextFromEvent(record);
    if (assistantText !== undefined) active.lastAssistantText = assistantText;
    if (record.type === "agent_settled") {
      const text = active.lastAssistantText;
      if (text === undefined || text.trim() === "" || Buffer.byteLength(text, "utf8") > MAX_ASSISTANT_BYTES) {
        active.reject(new Error("Pi Worker settled without a bounded assistant response"));
      } else {
        active.resolve(text);
      }
    }
  }

  #terminate(error: Error, expectedChild?: ChildProcessWithoutNullStreams): void {
    const child = this.#child;
    if (expectedChild !== undefined && child !== expectedChild) return;
    this.#child = undefined;
    this.#verifiedRpcMode = false;
    this.#buffer = "";
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (this.#activeTurn !== undefined) this.#activeTurn.reject(error);
    if (child !== undefined && !child.killed) child.kill("SIGTERM");
  }
}

function unwrapPiRpcRecord(payload: JsonValue): Record<string, unknown> | undefined {
  if (!isRecord(payload) || payload.source !== "pi-rpc" || !isRecord(payload.record)) return undefined;
  return payload.record;
}

function extractAssistantTextFromEvent(event: Record<string, unknown>): string | undefined {
  if ((event.type === "message_end" || event.type === "turn_end") && isRecord(event.message)) {
    return extractAssistantMessageText(event.message);
  }
  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    for (const message of [...event.messages].reverse()) {
      const text = isRecord(message) ? extractAssistantMessageText(message) : undefined;
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

function extractAssistantMessageText(message: Record<string, unknown>): string | undefined {
  if (message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return [];
    return [part.text];
  }).join("");
  return text === "" ? undefined : text;
}

function isPiWorkerEnvelope(value: unknown): value is PiWorkerEnvelopeV1 {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.envelopeId !== "string" || typeof value.sentAt !== "string" || typeof value.kind !== "string") return false;
  if (!requireUuidBoolean(value.envelopeId) || Number.isNaN(Date.parse(value.sentAt))) return false;
  if (value.kind === "response") {
    return typeof value.requestId === "string" && requireUuidBoolean(value.requestId) && typeof value.ok === "boolean";
  }
  if (value.kind === "event") {
    return Number.isSafeInteger(value.sequence) && typeof value.event === "string" && Object.hasOwn(value, "payload");
  }
  return value.kind === "request";
}

function requireUuid(value: string, name: string): void {
  if (!requireUuidBoolean(value)) throw new Error(`${name} must be a UUID`);
}

function requireUuidBoolean(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function truncate(value: string, maximum: number): string {
  return Buffer.byteLength(value, "utf8") <= maximum ? value : Buffer.from(value).subarray(0, maximum).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTurnImages(images: readonly PiWorkerImageV1[] | undefined): void {
  if (images === undefined) return;
  if (!Array.isArray(images) || images.length < 1 || images.length > 6) throw new Error("Pi Worker images are invalid");
  let totalBytes = 0;
  for (const image of images) {
    if (
      !isRecord(image) || image.type !== "image" ||
      typeof image.data !== "string" ||
      typeof image.mimeType !== "string" ||
      !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mimeType) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
    ) throw new Error("Pi Worker images are invalid");
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length < 1 || bytes.toString("base64") !== image.data) throw new Error("Pi Worker images are invalid");
    totalBytes += bytes.length;
    if (totalBytes > 10 * 1_048_576) throw new Error("Pi Worker images exceed the decoded byte limit");
  }
}
