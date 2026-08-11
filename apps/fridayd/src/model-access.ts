import { createHash, randomBytes } from "node:crypto";

import {
  JOB_PROTOCOL_VERSION,
  type RunnerModelAccessGrantV2,
  type RunnerModelAccessRequestV2,
  type RunnerModelProviderV2,
} from "@friday/protocol";

import type { RunnerModelProxyConfig } from "./config.js";
import type { SqliteJobRegistry } from "./job-registry.js";

const ACCESS_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MODEL_ROUTE: Readonly<Record<RunnerModelProviderV2, ReadonlySet<string>>> = {
  openai: new Set(["/v1/responses", "/v1/responses/compact", "/v1/chat/completions"]),
  anthropic: new Set(["/v1/messages", "/v1/messages/count_tokens"]),
};

interface StoredGrant {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly grant: RunnerModelAccessGrantV2;
}

export interface ModelProxyRequest {
  readonly grant: RunnerModelAccessGrantV2;
  readonly path: string;
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/**
 * Keeps upstream credentials inside the Hub while issuing only short-lived,
 * in-memory authorities to an enrolled Runner. Hub restart intentionally
 * revokes every outstanding token.
 */
export class RunnerModelAccessBroker {
  readonly #config: RunnerModelProxyConfig;
  readonly #jobs: SqliteJobRegistry;
  readonly #byTokenHash = new Map<string, StoredGrant>();
  readonly #byRequest = new Map<string, StoredGrant>();

  constructor(config: RunnerModelProxyConfig, jobs: SqliteJobRegistry) {
    this.#config = config;
    this.#jobs = jobs;
  }

  issue(request: RunnerModelAccessRequestV2, now = new Date()): RunnerModelAccessGrantV2 {
    validateAccessRequest(request, now);
    this.#prune(now);
    const requestDigest = sha256(JSON.stringify(request));
    const requestKey = `${request.runnerId}:${request.requestId}`;
    const previous = this.#byRequest.get(requestKey);
    if (previous !== undefined) {
      if (previous.requestDigest !== requestDigest) throw new Error("Model access request id is already bound to different content");
      this.#assertGrantActive(previous.grant, now);
      return previous.grant;
    }

    this.#jobs.assertActiveLease(request.jobId, request.runnerId, request.leaseId, now);
    const job = this.#jobs.get(request.jobId);
    if (job === undefined || job.tool !== request.tool || job.spec?.leaseId !== request.leaseId) {
      throw new Error("Model access request does not match the assigned Job");
    }
    const target = this.#targetFor(request.tool);
    const expiresAtMs = Math.min(
      now.getTime() + this.#config.tokenTtlSeconds * 1_000,
      Date.parse(job.spec.leaseExpiresAt),
      Date.parse(job.spec.expiresAt),
    );
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) throw new Error("Model access lease has expired");
    const grant: RunnerModelAccessGrantV2 = Object.freeze({
      protocolVersion: JOB_PROTOCOL_VERSION,
      accessToken: randomBytes(32).toString("base64url"),
      jobId: request.jobId,
      runnerId: request.runnerId,
      leaseId: request.leaseId,
      tool: request.tool,
      provider: target.provider,
      model: target.model,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    const stored = { requestId: request.requestId, requestDigest, grant } satisfies StoredGrant;
    this.#byRequest.set(requestKey, stored);
    this.#byTokenHash.set(sha256(grant.accessToken), stored);
    return grant;
  }

  authorize(authorization: string | undefined, provider: RunnerModelProviderV2, path: string, now = new Date()): RunnerModelAccessGrantV2 {
    this.#prune(now);
    if (authorization === undefined || !authorization.startsWith("Bearer ")) throw new Error("Model access token is required");
    const token = authorization.slice("Bearer ".length);
    if (!ACCESS_TOKEN.test(token)) throw new Error("Model access token is invalid");
    const stored = this.#byTokenHash.get(sha256(token));
    if (stored === undefined || stored.grant.provider !== provider || !MODEL_ROUTE[provider].has(path)) {
      throw new Error("Model access token is not authorized for this route");
    }
    this.#assertGrantActive(stored.grant, now);
    if ((stored.grant.tool === "codex" && path !== "/v1/responses" && path !== "/v1/responses/compact") ||
        (stored.grant.tool === "pi" && path !== "/v1/chat/completions" && path !== "/v1/responses") ||
        (stored.grant.tool === "claude" && path !== "/v1/messages" && path !== "/v1/messages/count_tokens")) {
      throw new Error("Model access token is not authorized for this tool route");
    }
    return stored.grant;
  }

  async forward(request: ModelProxyRequest): Promise<Response> {
    const target = this.#targetFor(request.grant.tool);
    if (target.provider !== request.grant.provider || target.model !== request.grant.model) throw new Error("Model access target changed after issuance");
    if (request.body.byteLength < 2 || request.body.byteLength > this.#config.maxRequestBytes) throw new Error("Model request body is outside the configured limit");
    let value: unknown;
    try { value = JSON.parse(request.body.toString("utf8")) as unknown; } catch { throw new Error("Model request body must be JSON"); }
    if (!isRecord(value)) throw new Error("Model request body must be a JSON object");
    const encoded = Buffer.from(JSON.stringify({ ...value, model: target.model }), "utf8");
    if (encoded.byteLength > this.#config.maxRequestBytes) throw new Error("Model request body is outside the configured limit");

    const endpoint = new URL(request.path.replace(/^\/v1\//, ""), target.baseUrl);
    const headers: Record<string, string> = {
      accept: request.headers.accept ?? "application/json",
      "content-type": "application/json",
      "user-agent": "friday-model-proxy/0.1",
    };
    if (target.provider === "openai") {
      headers.authorization = `Bearer ${target.apiKey}`;
      if (request.headers["openai-beta"] !== undefined) headers["openai-beta"] = request.headers["openai-beta"];
    } else {
      headers["x-api-key"] = target.apiKey;
      headers["anthropic-version"] = request.headers["anthropic-version"] ?? "2023-06-01";
      if (request.headers["anthropic-beta"] !== undefined) headers["anthropic-beta"] = request.headers["anthropic-beta"];
    }
    return fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers,
      body: encoded,
      signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
    });
  }

  revokeJob(jobId: string): void {
    for (const [hash, stored] of this.#byTokenHash) {
      if (stored.grant.jobId !== jobId) continue;
      this.#byTokenHash.delete(hash);
      this.#byRequest.delete(`${stored.grant.runnerId}:${stored.requestId}`);
    }
  }

  activeGrantCount(now = new Date()): number { this.#prune(now); return this.#byTokenHash.size; }

  #targetFor(tool: RunnerModelAccessGrantV2["tool"]): { readonly provider: RunnerModelProviderV2; readonly baseUrl: URL; readonly apiKey: string; readonly model: string } {
    if (tool === "codex" || tool === "pi") {
      const provider = this.#config.openai;
      if (provider === undefined) throw new Error("OpenAI-compatible Runner model proxy is not configured");
      return { provider: "openai", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: tool === "codex" ? provider.codexModel : provider.piModel };
    }
    const provider = this.#config.anthropic;
    if (provider === undefined) throw new Error("Anthropic-compatible Runner model proxy is not configured");
    return { provider: "anthropic", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.claudeModel };
  }

  #assertGrantActive(grant: RunnerModelAccessGrantV2, now: Date): void {
    if (Date.parse(grant.expiresAt) <= now.getTime()) throw new Error("Model access token expired");
    this.#jobs.assertActiveLease(grant.jobId, grant.runnerId, grant.leaseId, now);
  }

  #prune(now: Date): void {
    for (const [hash, stored] of this.#byTokenHash) {
      if (Date.parse(stored.grant.expiresAt) > now.getTime()) continue;
      this.#byTokenHash.delete(hash);
      this.#byRequest.delete(`${stored.grant.runnerId}:${stored.requestId}`);
    }
  }
}

export function modelProxyResponseHeaders(upstream: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  for (const name of ["content-type", "request-id", "x-request-id", "retry-after"]) {
    const value = upstream.get(name);
    if (value !== null) result[name] = value;
  }
  for (const [name, value] of upstream.entries()) {
    if (/^(?:x-ratelimit-|anthropic-ratelimit-)/i.test(name)) result[name] = value;
  }
  return result;
}

function validateAccessRequest(request: RunnerModelAccessRequestV2, now: Date): void {
  if (request.protocolVersion !== JOB_PROTOCOL_VERSION || !isUuid(request.requestId) || !isUuid(request.jobId) || !isUuid(request.runnerId) || !isUuid(request.leaseId) || !["codex", "pi", "claude"].includes(request.tool)) {
    throw new Error("Model access request is invalid");
  }
  const sentAt = Date.parse(request.sentAt);
  if (!Number.isFinite(sentAt) || Math.abs(sentAt - now.getTime()) > 5 * 60_000) throw new Error("Model access request timestamp is outside the accepted window");
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
