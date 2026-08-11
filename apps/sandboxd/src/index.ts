#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { JOB_PROTOCOL_VERSION, canonicalJsonV2, jobManifestProjectionV2, type JobSpecV2, type RunnerModelAccessGrantV2 } from "@friday/protocol";

const execFile = promisify(execFileCallback);
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
export interface SandboxImage { readonly image: string; readonly imageId: string; }

export interface SandboxdConfig {
  readonly socketPath: string;
  readonly runnerStateDir: string;
  readonly hubPublicKeyFile: string;
  readonly image: string;
  /** A Docker content ID is checked before every run, making a local fixture tag immutable in practice. */
  readonly imageId: string;
  /** Optional M3 adapters; absent configuration rejects every non-diagnostic agent job. */
  readonly codexImage?: SandboxImage;
  readonly piImage?: SandboxImage;
  readonly claudeImage?: SandboxImage;
  /** Fixed Hub origin reached only by the host-side per-Job relay. */
  readonly hubUrl?: URL;
  readonly modelRelayDirectory?: string;
  readonly modelRelayMaxRequestBytes?: number;
  readonly runnerUid: number;
  readonly runnerGid: number;
}

export interface SandboxRequest { readonly spec: JobSpecV2; readonly worktreePath: string; readonly modelAccess?: RunnerModelAccessGrantV2; }
interface SandboxResponse { readonly ok: boolean; readonly exitCode?: number; readonly stdout?: string; readonly stderr?: string; readonly error?: string; readonly executorImageId?: string; }

export function loadSandboxdConfig(env: NodeJS.ProcessEnv = process.env): SandboxdConfig {
  const socketPath = requireAbsolute(env.FRIDAY_SANDBOX_SOCKET ?? "/run/friday-sandboxd/sandboxd.sock", "FRIDAY_SANDBOX_SOCKET");
  const runnerStateDir = canonicalDirectory(env.FRIDAY_SANDBOX_RUNNER_STATE_DIR ?? "/var/lib/friday-runner", "FRIDAY_SANDBOX_RUNNER_STATE_DIR");
  const hubPublicKeyFile = requireAbsolute(env.FRIDAY_SANDBOX_HUB_PUBLIC_KEY_FILE ?? "", "FRIDAY_SANDBOX_HUB_PUBLIC_KEY_FILE");
  if (typeof env.FRIDAY_SANDBOX_IMAGE !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,255}(?::[A-Za-z0-9._-]{1,128})?$/.test(env.FRIDAY_SANDBOX_IMAGE)) throw new Error("FRIDAY_SANDBOX_IMAGE must be a fixed local image reference without registry credentials");
  if (!IMAGE_ID.test(env.FRIDAY_SANDBOX_IMAGE_ID ?? "")) throw new Error("FRIDAY_SANDBOX_IMAGE_ID must be an immutable sha256 Docker image id");
  const runnerUid = parseUnixId(env.FRIDAY_SANDBOX_RUNNER_UID, "FRIDAY_SANDBOX_RUNNER_UID");
  const runnerGid = parseUnixId(env.FRIDAY_SANDBOX_RUNNER_GID, "FRIDAY_SANDBOX_RUNNER_GID");
  const keyStats = lstatSync(hubPublicKeyFile);
  if (!keyStats.isFile() || keyStats.isSymbolicLink() || (keyStats.mode & 0o077) !== 0) throw new Error("FRIDAY_SANDBOX_HUB_PUBLIC_KEY_FILE must be a private regular file");
  const codexImage = readAdapterImage(env, "CODEX");
  const piImage = readAdapterImage(env, "PI");
  const claudeImage = readAdapterImage(env, "CLAUDE");
  const hasAgentImage = codexImage !== undefined || piImage !== undefined || claudeImage !== undefined;
  const hubUrl = env.FRIDAY_SANDBOX_HUB_URL === undefined || env.FRIDAY_SANDBOX_HUB_URL === "" ? undefined : parseHubUrl(env.FRIDAY_SANDBOX_HUB_URL);
  const modelRelayDirectory = hasAgentImage ? requireAbsolute(env.FRIDAY_SANDBOX_MODEL_RELAY_DIR ?? "/run/friday-sandboxd/model-relays", "FRIDAY_SANDBOX_MODEL_RELAY_DIR") : undefined;
  if (hasAgentImage && hubUrl === undefined) throw new Error("FRIDAY_SANDBOX_HUB_URL is required when an Agent image is enabled");
  const modelRelayMaxRequestBytes = parsePositiveInteger(env.FRIDAY_SANDBOX_MODEL_MAX_REQUEST_BYTES, 16 * 1_048_576, "FRIDAY_SANDBOX_MODEL_MAX_REQUEST_BYTES");
  return { socketPath, runnerStateDir, hubPublicKeyFile, image: env.FRIDAY_SANDBOX_IMAGE as string, imageId: env.FRIDAY_SANDBOX_IMAGE_ID as string, ...(codexImage === undefined ? {} : { codexImage }), ...(piImage === undefined ? {} : { piImage }), ...(claudeImage === undefined ? {} : { claudeImage }), ...(hubUrl === undefined ? {} : { hubUrl }), ...(modelRelayDirectory === undefined ? {} : { modelRelayDirectory }), modelRelayMaxRequestBytes, runnerUid, runnerGid };
}

export function sandboxDockerArguments(config: SandboxdConfig, request: SandboxRequest): readonly string[] {
  const spec = validateRequest(config, request);
  const image = imageFor(config, spec.tool);
  const memory = `${spec.limits.memoryMiB}m`;
  const cpu = (spec.limits.cpuMillis / 1000).toFixed(3);
  const command = commandFor(spec.tool);
  const modelMounts = spec.tool === "diagnostic" ? [] : [
    "--mount", `type=bind,src=${modelRelaySocketPath(config, spec)},dst=/tmp/friday-model.sock,readonly`,
    "--env", "FRIDAY_MODEL_SOCKET=/tmp/friday-model.sock",
    "--env", "FRIDAY_MODEL_RELAY_PORT=34123",
    "--env", `FRIDAY_MODEL_PROVIDER=${request.modelAccess?.provider ?? ""}`,
    "--env", `FRIDAY_MODEL_NAME=${request.modelAccess?.model ?? ""}`,
  ];
  return Object.freeze([
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", "128", "--memory", memory, "--cpus", cpu, "--user", `${config.runnerUid}:${config.runnerGid}`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--mount", `type=bind,src=${request.worktreePath},dst=/workspace`,
    "--workdir", "/workspace", "--env", `FRIDAY_JOB_ID=${spec.jobId}`, "--env", `FRIDAY_JOB_PROMPT=${spec.prompt}`,
    ...modelMounts,
    image.image, ...command,
  ]);
}

export function validateRequest(config: SandboxdConfig, request: SandboxRequest): JobSpecV2 {
  if (typeof request !== "object" || request === null || typeof request.worktreePath !== "string") throw new Error("Sandbox request is invalid");
  const spec = request.spec;
  verifyAssignment(spec, readFileSync(config.hubPublicKeyFile, "utf8"));
  imageFor(config, spec.tool);
  validateModelAccess(config, spec, request.modelAccess);
  const runnerStateDir = canonicalDirectory(config.runnerStateDir, "Sandbox Runner state directory");
  const expected = join(runnerStateDir, "jobs", spec.jobId, "worktree");
  const worktree = canonicalDirectory(request.worktreePath, "Sandbox worktree");
  if (worktree !== expected || !isDescendant(runnerStateDir, worktree)) throw new Error("Sandbox worktree is outside the signed Runner job directory");
  return spec;
}

export async function runSandboxJob(config: SandboxdConfig, request: SandboxRequest): Promise<SandboxResponse> {
  const spec = validateRequest(config, request);
  const image = imageFor(config, spec.tool);
  await assertImageId(image.image, image.imageId);
  const relay = spec.tool === "diagnostic" ? undefined : await startModelRelay(config, request);
  try {
    const args = sandboxDockerArguments(config, request);
    const { stdout, stderr } = await execFile("docker", args, { env: { PATH: process.env.PATH ?? "" }, timeout: spec.limits.timeoutSeconds * 1000, maxBuffer: spec.limits.maxOutputBytes, windowsHide: true });
    return { ok: true, exitCode: 0, stdout: truncate(stdout, spec.limits.maxOutputBytes), stderr: truncate(stderr, spec.limits.maxOutputBytes), executorImageId: image.imageId };
  } catch (error) {
    const detail = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { ok: false, exitCode: typeof detail.code === "number" ? detail.code : 1, stdout: truncate(detail.stdout ?? "", spec.limits.maxOutputBytes), stderr: truncate(detail.stderr ?? detail.message ?? "sandbox execution failed", spec.limits.maxOutputBytes) };
  } finally { await relay?.close(); }
}

export async function startSandboxd(config: SandboxdConfig): Promise<void> {
  // Socket group members need execute permission on the parent to connect, but
  // cannot list it or replace the root-owned socket.
  chmodSync(dirname(config.socketPath), 0o710);
  chownSync(dirname(config.socketPath), 0, config.runnerGid);
  try { const stats = lstatSync(config.socketPath); if (stats.isSocket()) unlinkSync(config.socketPath); else throw new Error("Sandbox socket path exists and is not a socket"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  if (config.modelRelayDirectory !== undefined) ensurePrivateRelayDirectory(config.modelRelayDirectory);
  const server = createNetServer({ allowHalfOpen: true }, (socket) => void handleSocket(socket, config));
  await new Promise<void>((resolvePromise, reject) => { server.once("error", reject); server.listen(config.socketPath, () => { server.off("error", reject); resolvePromise(); }); });
  chmodSync(config.socketPath, 0o660);
  chownSync(config.socketPath, 0, config.runnerGid);
  process.once("SIGTERM", () => server.close());
  process.once("SIGINT", () => server.close());
}

async function handleSocket(socket: Socket, config: SandboxdConfig): Promise<void> {
  let input = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    input += chunk;
    if (Buffer.byteLength(input) > 1_048_576) socket.destroy(new Error("Request too large"));
  });
  socket.once("end", async () => {
    try {
      const response = await runSandboxJob(config, JSON.parse(input) as SandboxRequest);
      socket.end(JSON.stringify(response));
    } catch (caught) {
      // Validation errors are deterministic and contain no request body or
      // credential material. Keep the client response generic, but retain a
      // bounded operator diagnostic so a fail-closed rejection is actionable.
      const detail = caught instanceof Error ? caught.message : "unknown rejection";
      process.stderr.write(`[sandboxd] request rejected: ${detail.slice(0, 512).replace(/[\r\n]/g, " ")}\n`);
      socket.end(JSON.stringify({ ok: false, error: "Sandbox request was rejected" } satisfies SandboxResponse));
    }
  });
}

function verifyAssignment(spec: JobSpecV2, publicKeyPem: string): void {
  if (spec.protocolVersion !== JOB_PROTOCOL_VERSION || spec.network.mode !== "none" || spec.network.allowedHosts.length !== 0 || Date.parse(spec.expiresAt) <= Date.now() || Date.parse(spec.leaseExpiresAt) <= Date.now()) throw new Error("Job manifest is invalid or expired");
  const projection = jobManifestProjectionV2(spec);
  if (createHash("sha256").update(canonicalJsonV2(projection)).digest("hex") !== spec.manifestSha256) throw new Error("Job manifest digest is invalid");
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(canonicalJsonV2(projection), "utf8"), key, Buffer.from(spec.hubSignature, "base64url"))) throw new Error("Job manifest signature is invalid");
}
function readAdapterImage(env: NodeJS.ProcessEnv, name: "CODEX" | "PI" | "CLAUDE"): SandboxImage | undefined { const image = env[`FRIDAY_SANDBOX_${name}_IMAGE`]; const imageId = env[`FRIDAY_SANDBOX_${name}_IMAGE_ID`]; if ((image === undefined || image === "") && (imageId === undefined || imageId === "")) return undefined; if (typeof image !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,255}(?::[A-Za-z0-9._-]{1,128})?$/.test(image) || typeof imageId !== "string" || !IMAGE_ID.test(imageId)) throw new Error(`FRIDAY_SANDBOX_${name}_IMAGE and FRIDAY_SANDBOX_${name}_IMAGE_ID must be an immutable pair`); return { image, imageId }; }
function imageFor(config: SandboxdConfig, tool: JobSpecV2["tool"]): SandboxImage { if (tool === "diagnostic") return { image: config.image, imageId: config.imageId }; if (tool === "codex") { if (config.codexImage === undefined) throw new Error("Codex sandbox adapter is not configured"); return config.codexImage; } if (tool === "pi") { if (config.piImage === undefined) throw new Error("Pi sandbox adapter is not configured"); return config.piImage; } if (tool === "claude") { if (config.claudeImage === undefined) throw new Error("Claude sandbox adapter is not configured"); return config.claudeImage; } throw new Error("Sandbox tool is unsupported"); }
// Both managed images define a fixed ENTRYPOINT. Docker appends this array to
// that entrypoint, so repeating the executable here would shift the Agent tool
// argument and silently turn a real canary into an invalid launch.
function commandFor(tool: JobSpecV2["tool"]): readonly string[] { return tool === "diagnostic" ? [] : [tool]; }

function validateModelAccess(config: SandboxdConfig, spec: JobSpecV2, grant: RunnerModelAccessGrantV2 | undefined): void {
  if (spec.tool === "diagnostic") { if (grant !== undefined) throw new Error("Diagnostic Job must not receive model access"); return; }
  if (config.hubUrl === undefined || config.modelRelayDirectory === undefined) throw new Error("Agent model relay is not configured");
  if (grant === undefined || Object.keys(grant).length !== 9 || grant.protocolVersion !== JOB_PROTOCOL_VERSION || grant.jobId !== spec.jobId || grant.runnerId !== spec.runnerId || grant.leaseId !== spec.leaseId || grant.tool !== spec.tool || !/^[A-Za-z0-9_-]{43}$/.test(grant.accessToken) || !/^[A-Za-z0-9._:/-]{1,256}$/.test(grant.model)) throw new Error("Job model access grant does not match the signed assignment");
  if ((spec.tool === "claude" && grant.provider !== "anthropic") || ((spec.tool === "codex" || spec.tool === "pi") && grant.provider !== "openai")) throw new Error("Job model provider does not match the sandbox adapter");
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.parse(spec.leaseExpiresAt)) throw new Error("Job model access grant is expired or exceeds the signed lease");
}

function modelRelaySocketPath(config: SandboxdConfig, spec: JobSpecV2): string {
  if (config.modelRelayDirectory === undefined) throw new Error("Agent model relay directory is not configured");
  const path = join(config.modelRelayDirectory, `${spec.jobId}.sock`);
  if (Buffer.byteLength(path, "utf8") > 100) throw new Error("Agent model relay socket path is too long");
  return path;
}

function ensurePrivateRelayDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) throw new Error("Agent model relay directory must be a private real directory");
}

async function startModelRelay(config: SandboxdConfig, request: SandboxRequest): Promise<{ close(): Promise<void> }> {
  const grant = request.modelAccess;
  if (grant === undefined || config.hubUrl === undefined || config.modelRelayDirectory === undefined) throw new Error("Agent model relay is not configured");
  if (process.getuid?.() !== 0) throw new Error("Agent model relay requires the root-owned sandbox supervisor");
  ensurePrivateRelayDirectory(config.modelRelayDirectory);
  const socketPath = modelRelaySocketPath(config, request.spec);
  try { const stats = lstatSync(socketPath); if (stats.isSocket()) unlinkSync(socketPath); else throw new Error("Agent model relay path exists and is not a socket"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const server = createHttpServer((incoming, outgoing) => void handleModelRelayRequest(config, request, incoming, outgoing));
  await new Promise<void>((resolvePromise, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); resolvePromise(); }); });
  try {
    chmodSync(socketPath, 0o600);
    // The systemd unit deliberately omits CAP_FOWNER. Set the mode while root
    // still owns the socket, then hand ownership to the fixed container UID.
    chownSync(socketPath, config.runnerUid, config.runnerGid);
  } catch (caught) {
    // A setup failure must not leak a listening relay and make systemd wait
    // until TimeoutStopSec on the next restart.
    await closeHttpServer(server).catch(() => undefined);
    try { unlinkSync(socketPath); } catch {}
    throw caught;
  }
  return {
    close: async () => {
      await closeHttpServer(server);
      try { const stats = lstatSync(socketPath); if (stats.isSocket()) unlinkSync(socketPath); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    },
  };
}

async function handleModelRelayRequest(config: SandboxdConfig, request: SandboxRequest, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  try {
    const grant = request.modelAccess;
    if (grant === undefined || config.hubUrl === undefined || Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Model relay grant expired");
    const route = modelRelayRoute(incoming.method, incoming.url);
    if (route.provider !== grant.provider || singleStringHeader(incoming.headers["content-type"])?.split(";", 1)[0]?.toLowerCase() !== "application/json") throw new Error("Model relay provider or content type is invalid");
    const endpoint = new URL(`/v2/model-proxy${route.path}`, config.hubUrl);
    const body = await readHttpBody(incoming, config.modelRelayMaxRequestBytes ?? 16 * 1_048_576);
    const upstream = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${grant.accessToken}`,
        accept: singleStringHeader(incoming.headers.accept) ?? "application/json",
        "content-type": "application/json",
        ...(singleStringHeader(incoming.headers["openai-beta"]) === undefined ? {} : { "openai-beta": singleStringHeader(incoming.headers["openai-beta"]) as string }),
        ...(singleStringHeader(incoming.headers["anthropic-version"]) === undefined ? {} : { "anthropic-version": singleStringHeader(incoming.headers["anthropic-version"]) as string }),
        ...(singleStringHeader(incoming.headers["anthropic-beta"]) === undefined ? {} : { "anthropic-beta": singleStringHeader(incoming.headers["anthropic-beta"]) as string }),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(Math.min(request.spec.limits.timeoutSeconds * 1_000, 30 * 60_000)),
    });
    const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    for (const name of ["content-type", "request-id", "x-request-id", "retry-after"]) { const value = upstream.headers.get(name); if (value !== null) headers[name] = value; }
    outgoing.writeHead(upstream.status, headers);
    if (upstream.body === null) { outgoing.end(); return; }
    const reader = upstream.body.getReader();
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; if (!outgoing.write(Buffer.from(chunk.value))) await new Promise<void>((resolvePromise) => outgoing.once("drain", resolvePromise)); } outgoing.end(); } finally { reader.releaseLock(); }
  } catch (caught) {
    let route = "invalid-url";
    try { route = new URL(incoming.url ?? "/", "http://model-relay.invalid").pathname; } catch {}
    const detail = caught instanceof Error ? caught.message : "unknown rejection";
    process.stderr.write(`[sandboxd] model relay rejected: method=${incoming.method ?? "unknown"} path=${route.slice(0, 256)} reason=${detail.slice(0, 512).replace(/[\r\n]/g, " ")}\n`);
    if (!outgoing.headersSent) { const encoded = JSON.stringify({ error: { code: "MODEL_RELAY_REJECTED", message: "The Job model relay rejected the request" } }); outgoing.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store" }); outgoing.end(encoded); }
    else outgoing.destroy();
  }
}

/**
 * Normalizes the exact CLI wire routes before forwarding them to the Hub.
 * Claude Code 2.1.227 appends a fixed compatibility query; no arbitrary query
 * parameter is accepted or forwarded.
 */
export function modelRelayRoute(method: string | undefined, rawUrl: string | undefined): { readonly provider: "openai" | "anthropic"; readonly path: string } {
  const url = new URL(rawUrl ?? "/", "http://model-relay.invalid");
  const match = /^\/(openai|anthropic)(\/v1\/(?:responses(?:\/compact)?|chat\/completions|messages(?:\/count_tokens)?))$/.exec(url.pathname);
  if (method !== "POST" || match?.[1] === undefined || match[2] === undefined) throw new Error("Model relay route is not allowed");
  const provider = match[1] as "openai" | "anthropic";
  if (url.search !== "" && !(provider === "anthropic" && url.search === "?beta=true")) throw new Error("Model relay route is not allowed");
  return { provider, path: url.pathname };
}

async function readHttpBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength; if (size > maxBytes) throw new Error("Model relay request is too large"); chunks.push(bytes); } if (size === 0) throw new Error("Model relay request is empty"); return Buffer.concat(chunks); }
async function closeHttpServer(server: HttpServer): Promise<void> { if (!server.listening) return; await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error))); }
function singleStringHeader(value: string | string[] | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
function parseHubUrl(value: string): URL { let url: URL; try { url = new URL(value); } catch { throw new Error("FRIDAY_SANDBOX_HUB_URL must be an absolute URL"); } const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]"; if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new Error("FRIDAY_SANDBOX_HUB_URL must be an HTTPS origin without credentials"); return url; }
function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number { if (value === undefined) return fallback; if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`); const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32 * 1_048_576) throw new Error(`${name} is outside the supported range`); return parsed; }
function parseUnixId(value: string | undefined, name: string): number { if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${name} must be a numeric non-root id`); const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) throw new Error(`${name} must be a numeric non-root id`); return parsed; }
async function assertImageId(image: string, imageId: string): Promise<void> { const { stdout } = await execFile("docker", ["image", "inspect", "--format", "{{.Id}}", image], { env: { PATH: process.env.PATH ?? "" }, maxBuffer: 65_536 }); if (stdout.trim() !== imageId) throw new Error("Sandbox image id does not match the verified configuration"); }
function canonicalDirectory(value: string, name: string): string { const path = resolve(value); const stats = lstatSync(path); if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${name} must be a real directory`); return realpathSync.native(path); }
function requireAbsolute(value: string, name: string): string { if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`); return value; }
function isDescendant(parent: string, child: string): boolean { const path = relative(parent, child); return path !== "" && !path.startsWith("..") && !isAbsolute(path); }
function truncate(value: string, max: number): string { return Buffer.byteLength(value) <= max ? value : Buffer.from(value).subarray(0, max).toString("utf8"); }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) startSandboxd(loadSandboxdConfig()).catch((error: unknown) => { process.stderr.write(`[sandboxd] ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
