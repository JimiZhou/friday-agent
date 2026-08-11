#!/usr/bin/env node

import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";

import { invokeStreamableHttpMcp, type McpDefinition, type McpInvocation } from "./m3-registry.js";

const MAX_MESSAGE_BYTES = 1_048_576;
const SHA256 = /^[a-f0-9]{64}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export interface McpBrokerSidecarConfig {
  readonly socketPath: string;
  /** Exact HTTPS origins that this independently deployed process may contact. */
  readonly allowedOrigins: readonly string[];
}

export interface McpBrokerRequest {
  readonly definition: McpDefinition;
  readonly input: string;
}

export interface McpBrokerResponse {
  readonly ok: boolean;
  readonly output?: string;
  readonly usage?: Omit<McpInvocation, "name" | "input">;
  readonly error?: "BROKER_REQUEST_REJECTED" | "BROKER_TRANSPORT_FAILED";
}

/**
 * Load the sidecar's deliberately small configuration. It never accepts an
 * Owner/Hub token, model key, proxy credential, or arbitrary endpoint.
 */
export function loadMcpBrokerSidecarConfig(env: NodeJS.ProcessEnv = process.env): McpBrokerSidecarConfig {
  const socketPath = env.FRIDAY_MCP_BROKER_SOCKET ?? "/run/friday-mcp-broker/broker.sock";
  if (!isAbsolute(socketPath)) throw new Error("FRIDAY_MCP_BROKER_SOCKET must be an absolute Unix socket path");
  const rawOrigins = env.FRIDAY_MCP_BROKER_ALLOWED_ORIGINS;
  if (rawOrigins === undefined || rawOrigins.trim() === "") throw new Error("FRIDAY_MCP_BROKER_ALLOWED_ORIGINS must list one or more HTTPS origins");
  const allowedOrigins = rawOrigins.split(",").map((value) => parseOrigin(value.trim()));
  if (new Set(allowedOrigins).size !== allowedOrigins.length) throw new Error("FRIDAY_MCP_BROKER_ALLOWED_ORIGINS contains a duplicate origin");
  return { socketPath, allowedOrigins };
}

/** Hub-side client. This is the only production transport Fridayd may use. */
export async function invokeMcpBrokerSidecar(
  socketPath: string,
  definition: McpDefinition,
  input: string,
  timeoutMs = definition.budget.timeoutSeconds * 1000,
): Promise<{ readonly output: string; readonly usage: Omit<McpInvocation, "name" | "input"> }> {
  if (!isAbsolute(socketPath)) throw new Error("MCP broker socket must be absolute");
  const payload = JSON.stringify({ definition, input } satisfies McpBrokerRequest);
  if (Buffer.byteLength(payload, "utf8") > MAX_MESSAGE_BYTES) throw new Error("MCP broker request exceeds maximum size");
  const response = await exchange(socketPath, payload, timeoutMs);
  if (!response.ok || typeof response.output !== "string" || response.usage === undefined) {
    throw new Error(response.error === "BROKER_REQUEST_REJECTED" ? "MCP broker rejected the request" : "MCP broker transport failed");
  }
  return { output: response.output, usage: response.usage };
}

/** Starts an independently deployable, one-request-per-connection sidecar. */
export async function startMcpBrokerSidecar(config: McpBrokerSidecarConfig): Promise<{ stop(): Promise<void> }> {
  mkdirSync(dirname(config.socketPath), { recursive: true, mode: 0o700 });
  removeSocketIfPresent(config.socketPath);
  const server = createServer({ allowHalfOpen: true }, (socket) => void handleSocket(socket, config));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.socketPath, () => { server.off("error", reject); resolve(); });
  });
  // The containing directory is supplied as a private shared runtime volume;
  // do not make the socket world-readable merely to simplify deployment.
  chmodSync(config.socketPath, 0o600);
  return {
    stop: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      removeSocketIfPresent(config.socketPath);
    },
  };
}

async function handleSocket(socket: Socket, config: McpBrokerSidecarConfig): Promise<void> {
  let raw = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) socket.destroy(new Error("MCP broker request too large"));
  });
  socket.once("end", async () => {
    try {
      const request = parseRequest(JSON.parse(raw) as unknown, config);
      const result = await invokeStreamableHttpMcp(request.definition, request.input);
      socket.end(JSON.stringify({ ok: true, ...result } satisfies McpBrokerResponse));
    } catch (error) {
      // Never proxy an upstream response or error into the Hub's audit/UI
      // channel. External content is untrusted and failures are intentionally
      // coarse grained at this capability boundary.
      const rejected = error instanceof Error && /Invalid|must|allowed|budget|source|input/i.test(error.message);
      socket.end(JSON.stringify({ ok: false, error: rejected ? "BROKER_REQUEST_REJECTED" : "BROKER_TRANSPORT_FAILED" } satisfies McpBrokerResponse));
    }
  });
}

function parseRequest(value: unknown, config: McpBrokerSidecarConfig): McpBrokerRequest {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !isRecord(value.definition) || typeof value.input !== "string") throw new Error("Invalid MCP broker request");
  const definition = value.definition;
  if (Object.keys(definition).length !== 5 || typeof definition.name !== "string" || typeof definition.version !== "string" || typeof definition.source !== "string" || typeof definition.schemaSha256 !== "string" || !isRecord(definition.budget)) throw new Error("Invalid MCP definition");
  const budget = definition.budget;
  if (Object.keys(budget).length !== 4 || !NAME.test(definition.name) || !VERSION.test(definition.version) || !SHA256.test(definition.schemaSha256) || Buffer.byteLength(value.input, "utf8") === 0 || Buffer.byteLength(value.input, "utf8") > 64 * 1024) throw new Error("Invalid MCP broker request");
  if (!Object.values(budget).every((item) => Number.isSafeInteger(item) && (item as number) >= 0) || budget.networkRequests !== 1 || budget.secretRefs !== 0 || (budget.fileBytes as number) < 1 || (budget.fileBytes as number) > 1_048_576 || (budget.timeoutSeconds as number) < 1 || (budget.timeoutSeconds as number) > 3600) throw new Error("Invalid MCP budget");
  let source: URL;
  try { source = new URL(definition.source); } catch { throw new Error("MCP source must be an absolute HTTPS URL"); }
  if (source.protocol !== "https:" || source.username !== "" || source.password !== "" || !config.allowedOrigins.includes(source.origin)) throw new Error("MCP source origin is not allowed");
  return { definition: { name: definition.name, version: definition.version, source: source.toString(), schemaSha256: definition.schemaSha256, budget: { networkRequests: budget.networkRequests as number, fileBytes: budget.fileBytes as number, secretRefs: budget.secretRefs as number, timeoutSeconds: budget.timeoutSeconds as number } }, input: value.input };
}

function exchange(socketPath: string, payload: string, timeoutMs: number): Promise<McpBrokerResponse> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("MCP broker timeout is invalid");
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let raw = "";
    const timer = setTimeout(() => socket.destroy(new Error("MCP broker timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(payload));
    socket.on("data", (chunk: string) => { raw += chunk; if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) socket.destroy(new Error("MCP broker response too large")); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("end", () => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(raw) as unknown;
        if (!isRecord(response) || typeof response.ok !== "boolean") throw new Error("MCP broker response is invalid");
        resolve(response as unknown as McpBrokerResponse);
      } catch (error) { reject(error); }
    });
  });
}

function parseOrigin(value: string): string {
  let origin: URL;
  try { origin = new URL(value); } catch { throw new Error("MCP broker origins must be absolute HTTPS origins"); }
  if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") throw new Error("MCP broker origins must be origin-only HTTPS URLs");
  return origin.origin;
}

function removeSocketIfPresent(path: string): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isSocket()) throw new Error("MCP broker socket path exists and is not a socket");
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startMcpBrokerSidecar(loadMcpBrokerSidecarConfig()).catch((error: unknown) => {
    process.stderr.write(`[mcp-broker] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
