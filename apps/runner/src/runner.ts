import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  JOB_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SELF_IMPROVEMENT_TEST_EVIDENCE_VERSION,
  runnerRequestSignaturePayload,
  runnerRequestSignaturePayloadV2,
  type JobSpecV2,
  type RunnerEnvelopeV1,
  type RunnerJobEventV2,
  type RunnerModelAccessGrantV2,
  type RunnerModelAccessRequestV2,
  type SelfImprovementTestEvidenceV1,
} from "@friday/protocol";
import { verifyHubAssignment, pinHubIdentity } from "./job-client.js";
import { GitWorktreeManager } from "./worktree-manager.js";
import { RunnerWorkspaceRegistry } from "./workspace-registry.js";
import { requestSandboxExecution } from "./sandbox-client.js";

const execFile = promisify(execFileCallback);

export const RUNNER_VERSION = "0.1.0";
export const DEFAULT_HUB_URL = "http://127.0.0.1:4310";
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_STATE_DIRECTORY = join(homedir(), ".friday", "runner");
export const RUNNER_DEVICE_STATE_FILE = "runner-device.json";
export const MAX_REGISTERED_WORKSPACES = 256;

interface RunnerDevice {
  readonly runnerId: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
  readonly enrolledAt?: string;
}

export interface RunnerConfig {
  readonly hubUrl: URL;
  readonly runnerId: string;
  readonly displayName: string;
  readonly stateDir: string;
  readonly device: RunnerDevice;
  /** A one-time bootstrap secret. It is never written to the Runner state directory. */
  readonly enrollmentToken?: string;
  /** Optional 0600 handoff file, removed immediately after successful enrollment. */
  readonly enrollmentTokenFile?: string;
  readonly workspaces: readonly string[];
  readonly heartbeatIntervalMs: number;
  readonly requestTimeoutMs: number;
  /** Absent is an intentional fail-closed execution configuration. */
  readonly sandboxSocket?: string;
}

export interface RunnerCapabilities {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly runnerVersion: typeof RUNNER_VERSION;
  readonly capabilities: readonly string[];
  readonly workspaces: readonly string[];
  readonly shellExecution: false;
}

export function describeRunnerCapabilities(
  workspaces: readonly string[] = [],
  sandboxConfigured = false,
): RunnerCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    runnerVersion: RUNNER_VERSION,
    capabilities: sandboxConfigured ? ["orchestration", "sandbox"] : ["orchestration"],
    workspaces,
    shellExecution: false,
  };
}

export class FridayRunner {
  readonly #config: RunnerConfig;
  #enrolled: boolean;
  #activeJobs = 0;

  constructor(config: RunnerConfig) {
    this.#config = config;
    this.#enrolled = config.device.enrolledAt !== undefined;
  }

  capabilities(): RunnerCapabilities {
    return describeRunnerCapabilities(this.#config.workspaces, this.#config.sandboxSocket !== undefined);
  }

  async register(): Promise<unknown> {
    await this.#ensureEnrolled();
    const capabilities = this.capabilities();
    const envelope = {
      ...baseEnvelope(this.#config.runnerId),
      kind: "register",
      payload: {
        displayName: this.#config.displayName,
        version: RUNNER_VERSION,
        capabilities: [...capabilities.capabilities],
        workspaces: [...capabilities.workspaces],
        shellExecution: false,
      },
    } as RunnerEnvelopeV1;

    return this.#post("/v1/runners/register", envelope);
  }

  async heartbeat(): Promise<unknown> {
    await this.#ensureEnrolled();
    const envelope = {
      ...baseEnvelope(this.#config.runnerId),
      kind: "heartbeat",
      payload: {
        status: "online",
        activeJobs: this.#activeJobs,
      },
    } as RunnerEnvelopeV1;

    const runnerId = encodeURIComponent(this.#config.runnerId);
    return this.#post(`/v1/runners/${runnerId}/heartbeat`, envelope);
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.register();
    await this.heartbeat();

    while (!signal.aborted) {
      await wait(this.#config.heartbeatIntervalMs, signal);
      if (signal.aborted) {
        break;
      }

      try {
        await this.heartbeat();
        await this.#pullAndExecute();
      } catch (error) {
        writeDiagnostic(`heartbeat failed: ${errorMessage(error)}`);
      }
    }
  }

  async #pullAndExecute(): Promise<void> {
    const hubKey = await this.#hubKey();
    const pinned = pinHubIdentity(this.#config.stateDir, hubKey);
    const path = `/v2/runners/${encodeURIComponent(this.#config.runnerId)}/pull`;
    const pull = { protocolVersion: JOB_PROTOCOL_VERSION, requestId: randomUUID(), runnerId: this.#config.runnerId, sentAt: new Date().toISOString() };
    const assignment = await this.#signedV2Post(path, pull) as { assignment?: unknown };
    if (assignment === null || assignment.assignment === null || assignment.assignment === undefined) return;
    const spec = assignment.assignment as JobSpecV2;
    verifyHubAssignment(spec, pinned.publicKeyPem);
    if (spec.runnerId !== this.#config.runnerId || !this.#config.workspaces.includes(spec.workspaceId)) throw new Error("Hub assignment does not match this Runner's allow-list");
    const worktrees = new GitWorktreeManager(this.#config.stateDir);
    let prepared;
    try {
      prepared = await worktrees.prepare(spec.workspaceId, spec.jobId);
    } catch (error) {
      await this.#reconcile(spec, "UNKNOWN", -1);
      throw new Error(`Refusing to replay an interrupted or invalid job: ${errorMessage(error)}`);
    }
    this.#activeJobs += 1;
    let sequence = 0;
    try {
      await this.#jobEvent(spec, sequence++, { type: "state", state: "RUNNING" });
      if (this.#config.sandboxSocket === undefined) throw new Error("SANDBOX_UNAVAILABLE: FRIDAY_SANDBOX_SOCKET is not configured");
      const modelAccess = spec.tool === "diagnostic" ? undefined : await this.#requestModelAccess(spec);
      const result = await requestSandboxExecution(this.#config.sandboxSocket, spec, prepared.path, Math.min(this.#config.requestTimeoutMs + spec.limits.timeoutSeconds * 1000, 3_700_000), modelAccess);
      if (result.stdout !== undefined && result.stdout !== "") await this.#jobEvent(spec, sequence++, { type: "output", stream: "stdout", chunk: result.stdout });
      if (result.stderr !== undefined && result.stderr !== "") await this.#jobEvent(spec, sequence++, { type: "output", stream: "stderr", chunk: result.stderr });
      if (!result.ok) throw new Error(result.error ?? `Sandbox exited ${result.exitCode ?? 1}`);
      const diff = await collectWorktreeDiff(prepared.path);
      if (diff !== undefined) {
        const artifact = await this.#uploadArtifact(spec, diff);
        await this.#jobEvent(spec, sequence++, { type: "artifact", artifact });
        if ((spec.operation === "develop" || spec.operation === "test") && result.executorImageId !== undefined) {
          const evidence = createTestEvidence(spec, result.executorImageId, result.stdout ?? "", result.stderr ?? "", diff.bytes);
          const evidenceArtifact = await this.#uploadArtifact(spec, { name: "test-evidence.json", mediaType: "application/json", bytes: Buffer.from(JSON.stringify(evidence), "utf8") });
          await this.#jobEvent(spec, sequence++, { type: "artifact", artifact: evidenceArtifact });
        }
      }
      await this.#jobEvent(spec, sequence++, { type: "state", state: "SUCCEEDED" });
    } catch (error) {
      try { await this.#jobEvent(spec, sequence++, { type: "error", error: { code: "SANDBOX_EXECUTION_FAILED", message: errorMessage(error), retryable: false } }); await this.#jobEvent(spec, sequence++, { type: "state", state: "FAILED" }); } catch (reportError) { writeDiagnostic(`job ${spec.jobId} reporting failed: ${errorMessage(reportError)}`); }
    } finally { this.#activeJobs -= 1; }
  }

  async #hubKey(): Promise<string> {
    const endpoint = new URL("/v2/hub-key", this.#config.hubUrl);
    const response = await fetch(endpoint, { method: "GET", redirect: "error", signal: AbortSignal.timeout(this.#config.requestTimeoutMs) });
    if (!response.ok) throw new Error(`Hub key endpoint returned ${response.status}`);
    const body = await response.json() as { protocolVersion?: unknown; algorithm?: unknown; publicKeyPem?: unknown };
    if (body.protocolVersion !== JOB_PROTOCOL_VERSION || body.algorithm !== "ed25519" || typeof body.publicKeyPem !== "string") throw new Error("Hub key response is invalid");
    return body.publicKeyPem;
  }

  async #requestModelAccess(spec: JobSpecV2): Promise<RunnerModelAccessGrantV2> {
    if (spec.tool === "diagnostic") throw new Error("Diagnostic Jobs do not use model access");
    const request: RunnerModelAccessRequestV2 = {
      protocolVersion: JOB_PROTOCOL_VERSION,
      requestId: randomUUID(),
      jobId: spec.jobId,
      runnerId: this.#config.runnerId,
      leaseId: spec.leaseId,
      tool: spec.tool,
      sentAt: new Date().toISOString(),
    };
    const path = `/v2/runners/${encodeURIComponent(this.#config.runnerId)}/jobs/${encodeURIComponent(spec.jobId)}/model-access`;
    const response = await this.#signedV2Post(path, request, [201]) as { grant?: unknown };
    const grant = response?.grant;
    if (!isRunnerModelAccessGrant(grant, request) || Date.parse(grant.expiresAt) > Date.parse(spec.leaseExpiresAt)) {
      throw new Error("Hub returned an invalid or over-broad model access grant");
    }
    return grant;
  }

  async #signedV2Post(path: string, value: unknown, acceptedStatuses: readonly number[] = [200, 202]): Promise<unknown> {
    const body = JSON.stringify(value);
    const signature = sign(null, Buffer.from(runnerRequestSignaturePayloadV2("POST", path, body), "utf8"), this.#config.device.privateKeyPem).toString("base64url");
    return this.#request(path, body, { "x-friday-runner-signature": signature }, acceptedStatuses);
  }

  async #jobEvent(spec: JobSpecV2, sequence: number, partial: Pick<RunnerJobEventV2, "type"> & Partial<RunnerJobEventV2>): Promise<void> {
    const event = { protocolVersion: JOB_PROTOCOL_VERSION, eventId: randomUUID(), jobId: spec.jobId, runnerId: this.#config.runnerId, leaseId: spec.leaseId, sequence, sentAt: new Date().toISOString(), ...partial } as RunnerJobEventV2;
    await this.#signedV2Post(`/v2/runners/${encodeURIComponent(this.#config.runnerId)}/jobs/${encodeURIComponent(spec.jobId)}/events`, event);
  }

  async #uploadArtifact(spec: JobSpecV2, draft: { readonly name: string; readonly mediaType: string; readonly bytes: Buffer }): Promise<{ readonly artifactId: string; readonly name: string; readonly mediaType: string; readonly uri: string; readonly sha256: string; readonly sizeBytes: number }> {
    const artifactId = randomUUID();
    const sha256 = createHash("sha256").update(draft.bytes).digest("hex");
    const path = `/v2/runners/${encodeURIComponent(this.#config.runnerId)}/jobs/${encodeURIComponent(spec.jobId)}/artifacts/${encodeURIComponent(artifactId)}`;
    const response = await this.#signedV2Post(path, { protocolVersion: JOB_PROTOCOL_VERSION, runnerId: this.#config.runnerId, jobId: spec.jobId, leaseId: spec.leaseId, artifactId, name: draft.name, mediaType: draft.mediaType, sha256, sizeBytes: draft.bytes.byteLength, contentBase64: draft.bytes.toString("base64") }, [201]) as { artifact?: unknown };
    if (typeof response !== "object" || response === null || !Object.hasOwn(response, "artifact")) throw new Error("Hub returned an invalid artifact upload response");
    const artifact = (response as { artifact: unknown }).artifact;
    if (typeof artifact !== "object" || artifact === null || typeof (artifact as Record<string, unknown>).uri !== "string") throw new Error("Hub returned an invalid artifact reference");
    return artifact as { readonly artifactId: string; readonly name: string; readonly mediaType: string; readonly uri: string; readonly sha256: string; readonly sizeBytes: number };
  }

  async #reconcile(spec: JobSpecV2, state: "UNKNOWN", lastSequence: number): Promise<void> {
    await this.#signedV2Post(`/v2/runners/${encodeURIComponent(this.#config.runnerId)}/jobs/${encodeURIComponent(spec.jobId)}/reconcile`, { protocolVersion: JOB_PROTOCOL_VERSION, jobId: spec.jobId, runnerId: this.#config.runnerId, leaseId: spec.leaseId, sentAt: new Date().toISOString(), state, lastSequence });
  }

  async #post(path: string, envelope: RunnerEnvelopeV1): Promise<unknown> {
    const encodedEnvelope = JSON.stringify(envelope);
    const signature = sign(
      null,
      Buffer.from(runnerRequestSignaturePayload("POST", path, encodedEnvelope), "utf8"),
      this.#config.device.privateKeyPem,
    ).toString("base64url");
    return this.#request(path, encodedEnvelope, { "x-friday-runner-signature": signature }, [200, 202]);
  }

  async #ensureEnrolled(): Promise<void> {
    if (this.#enrolled) return;
    const enrollmentToken = this.#config.enrollmentToken;
    if (enrollmentToken === undefined) {
      throw new Error(
        "Runner has no enrolled device credential; set FRIDAY_RUNNER_ENROLLMENT_TOKEN for the first registration",
      );
    }

    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      runnerId: this.#config.runnerId,
      enrollmentToken,
      publicKeyPem: this.#config.device.publicKeyPem,
    });
    await this.#request("/v1/runners/enroll", body, {}, [200, 201]);
    persistRunnerDevice(this.#config.stateDir, {
      ...this.#config.device,
      enrolledAt: new Date().toISOString(),
    });
    if (this.#config.enrollmentTokenFile !== undefined) {
      removeEnrollmentTokenFile(this.#config.enrollmentTokenFile);
    }
    this.#enrolled = true;
  }

  async #request(
    path: string,
    body: string,
    extraHeaders: Readonly<Record<string, string>>,
    acceptedStatuses: readonly number[],
  ): Promise<unknown> {
    const endpoint = new URL(path, this.#config.hubUrl);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      let responseText: string;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            ...extraHeaders,
          },
          body,
          signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
        });
        responseText = await response.text();
      } catch (error) {
        if (attempt === 0) continue;
        throw error;
      }

      if (!acceptedStatuses.includes(response.status)) {
        const failure = new Error(
          `Hub ${endpoint.pathname} returned ${response.status}${responseText === "" ? "" : `: ${responseText}`}`,
        );
        if (response.status >= 500 && attempt === 0) continue;
        throw failure;
      }

      if (responseText === "") return undefined;
      try {
        return JSON.parse(responseText) as unknown;
      } catch {
        if (attempt === 0) continue;
        throw new Error(`Hub ${endpoint.pathname} returned invalid JSON`);
      }
    }

    throw new Error(`Hub ${endpoint.pathname} did not return a usable response`);
  }
}

export function loadRunnerConfig(environment: NodeJS.ProcessEnv = process.env): RunnerConfig {
  if (environment.FRIDAY_RUNNER_TOKEN !== undefined) {
    throw new Error(
      "FRIDAY_RUNNER_TOKEN is no longer supported; use FRIDAY_RUNNER_ENROLLMENT_TOKEN only for first enrollment",
    );
  }
  const hubUrl = parseHubUrl(environment.FRIDAY_HUB_URL ?? DEFAULT_HUB_URL);
  const stateDir = resolveStateDirectory(environment);
  const requestedRunnerId = environment.FRIDAY_RUNNER_ID === undefined
    ? undefined
    : requireUuid(environment.FRIDAY_RUNNER_ID, "FRIDAY_RUNNER_ID");
  const device = resolveRunnerDevice(stateDir, requestedRunnerId);
  const runnerId = device.runnerId;
  const displayName = requireText(environment.FRIDAY_RUNNER_NAME ?? hostname(), "FRIDAY_RUNNER_NAME");
  const enrollment = loadEnrollmentToken(environment);
  const workspaces = loadRegisteredWorkspaces(stateDir, environment.FRIDAY_WORKSPACES);
  const heartbeatIntervalMs = parsePositiveInteger(
    environment.FRIDAY_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    "FRIDAY_HEARTBEAT_INTERVAL_MS",
  );
  const requestTimeoutMs = parsePositiveInteger(
    environment.FRIDAY_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    "FRIDAY_REQUEST_TIMEOUT_MS",
  );
  const sandboxSocket = environment.FRIDAY_SANDBOX_SOCKET;
  if (sandboxSocket !== undefined && (!sandboxSocket.startsWith("/") || sandboxSocket.length > 512)) throw new Error("FRIDAY_SANDBOX_SOCKET must be an absolute Unix socket path");

  return {
    hubUrl,
    runnerId,
    displayName,
    stateDir,
    device,
    ...(enrollment === undefined ? {} : {
      enrollmentToken: enrollment.token,
      ...(enrollment.file === undefined ? {} : { enrollmentTokenFile: enrollment.file }),
    }),
    workspaces,
    heartbeatIntervalMs,
    requestTimeoutMs,
    ...(sandboxSocket === undefined ? {} : { sandboxSocket }),
  };
}

export function loadRunnerCapabilities(
  environment: NodeJS.ProcessEnv = process.env,
): RunnerCapabilities {
  return describeRunnerCapabilities(
    loadRegisteredWorkspaces(resolveStateDirectory(environment), environment.FRIDAY_WORKSPACES),
    environment.FRIDAY_SANDBOX_SOCKET !== undefined,
  );
}

function baseEnvelope(runnerId: string): Pick<
  RunnerEnvelopeV1,
  "protocolVersion" | "envelopeId" | "runnerId" | "sentAt"
> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    envelopeId: randomUUID(),
    runnerId,
    sentAt: new Date().toISOString(),
  };
}

function parseHubUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FRIDAY_HUB_URL must be a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("FRIDAY_HUB_URL must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("FRIDAY_HUB_URL must not contain credentials");
  }
  if (url.protocol === "http:" && !isExplicitLoopbackHostname(url.hostname)) {
    throw new Error("FRIDAY_HUB_URL may use plain HTTP only with 127.0.0.1 or ::1");
  }
  return url;
}

function isExplicitLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseWorkspaces(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  const unique = new Set<string>();
  for (const raw of value.split(",")) {
    const workspace = requireIdentifier(raw.trim(), "FRIDAY_WORKSPACES");
    unique.add(workspace);
    if (unique.size > MAX_REGISTERED_WORKSPACES) {
      throw new Error(`FRIDAY_WORKSPACES must contain at most ${MAX_REGISTERED_WORKSPACES} unique identifiers`);
    }
  }
  return [...unique];
}

function loadRegisteredWorkspaces(stateDir: string, requestedWorkspaces: string | undefined): string[] {
  const registered = new RunnerWorkspaceRegistry(stateDir).list().map((workspace) => workspace.workspaceId);
  if (requestedWorkspaces === undefined) return registered;
  const requested = parseWorkspaces(requestedWorkspaces);
  if (requested.length !== registered.length || requested.some((workspace, index) => workspace !== registered[index])) {
    throw new Error(
      "FRIDAY_WORKSPACES must exactly match the local workspace registry; use friday-runner workspace register",
    );
  }
  return registered;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function requireIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, dots, underscores, and dashes`);
  }
  return value;
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new Error(`${name} must contain between 1 and 128 characters`);
  }
  return normalized;
}

function parseEnrollmentToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("FRIDAY_RUNNER_ENROLLMENT_TOKEN must be a 32-byte base64url token");
  }
  return value;
}

function loadEnrollmentToken(environment: NodeJS.ProcessEnv): { readonly token: string; readonly file?: string } | undefined {
  const direct = parseEnrollmentToken(environment.FRIDAY_RUNNER_ENROLLMENT_TOKEN);
  const configuredFile = environment.FRIDAY_RUNNER_ENROLLMENT_FILE;
  if (direct !== undefined && configuredFile !== undefined) {
    throw new Error("Use only one of FRIDAY_RUNNER_ENROLLMENT_TOKEN or FRIDAY_RUNNER_ENROLLMENT_FILE");
  }
  if (configuredFile === undefined) return direct === undefined ? undefined : { token: direct };
  if (!configuredFile.startsWith("/") || configuredFile.length > 512) {
    throw new Error("FRIDAY_RUNNER_ENROLLMENT_FILE must be an absolute path");
  }
  const stats = lstatSync(configuredFile);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600 || (process.getuid !== undefined && stats.uid !== process.getuid())) {
    throw new Error("FRIDAY_RUNNER_ENROLLMENT_FILE must be an owned regular 0600 file");
  }
  const token = parseEnrollmentToken(readFileSync(configuredFile, "utf8").trim());
  if (token === undefined) throw new Error("FRIDAY_RUNNER_ENROLLMENT_FILE is empty");
  return { token, file: configuredFile };
}

function removeEnrollmentTokenFile(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600 || (process.getuid !== undefined && stats.uid !== process.getuid())) {
    throw new Error("Refusing to remove an unsafe enrollment token file");
  }
  unlinkSync(path);
}

export function resolveStateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_RUNNER_STATE_DIR ?? DEFAULT_STATE_DIRECTORY;
  if (configured.trim() === "") {
    throw new Error("FRIDAY_RUNNER_STATE_DIR must not be empty");
  }
  const stateDirectory = resolve(configured);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(stateDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error("FRIDAY_RUNNER_STATE_DIR must be a non-symlink directory with mode 0700");
  }
  return stateDirectory;
}

function resolveRunnerDevice(stateDirectory: string, requestedRunnerId: string | undefined): RunnerDevice {
  const stateFile = join(stateDirectory, RUNNER_DEVICE_STATE_FILE);
  try {
    const device = parseRunnerDevice(readPrivateStateFile(stateFile), stateFile);
    if (requestedRunnerId !== undefined && requestedRunnerId !== device.runnerId) {
      throw new Error("FRIDAY_RUNNER_ID does not match the persisted Runner device identity");
    }
    return device;
  } catch (error) {
    if (!isFileMissing(error)) {
      throw error;
    }
  }

  const runnerId = requestedRunnerId ?? resolveLegacyRunnerId(stateDirectory);
  const keys = generateKeyPairSync("ed25519");
  const device: RunnerDevice = {
    runnerId,
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  try {
    persistRunnerDevice(stateDirectory, device, true);
    return device;
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    const existing = parseRunnerDevice(readPrivateStateFile(stateFile), stateFile);
    if (requestedRunnerId !== undefined && requestedRunnerId !== existing.runnerId) {
      throw new Error("FRIDAY_RUNNER_ID does not match the persisted Runner device identity");
    }
    return existing;
  }
}

function resolveLegacyRunnerId(stateDirectory: string): string {
  const stateFile = join(stateDirectory, "runner-id");
  try {
    return requireUuid(readFileSync(stateFile, "utf8").trim(), stateFile);
  } catch (error) {
    if (!isFileMissing(error)) {
      throw error;
    }
  }

  const runnerId = randomUUID();
  try {
    writeFileSync(stateFile, `${runnerId}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return runnerId;
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    return requireUuid(readFileSync(stateFile, "utf8").trim(), stateFile);
  }
}

function persistRunnerDevice(stateDirectory: string, device: RunnerDevice, exclusive = false): void {
  const stateFile = join(stateDirectory, RUNNER_DEVICE_STATE_FILE);
  const serialized = `${JSON.stringify({
    version: 1,
    runnerId: device.runnerId,
    publicKeyPem: device.publicKeyPem,
    privateKeyPem: device.privateKeyPem,
    ...(device.enrolledAt === undefined ? {} : { enrolledAt: device.enrolledAt }),
  })}\n`;
  if (exclusive) {
    writeFileSync(stateFile, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  }

  const temporary = join(stateDirectory, `.${RUNNER_DEVICE_STATE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, stateFile);
    chmodSync(stateFile, 0o600);
  } finally {
    try {
      if (lstatSync(temporary).isFile()) {
        // A failed rename must not leave a key-bearing temporary file behind.
        unlinkSync(temporary);
      }
    } catch {
      // The normal rename path has already removed the temporary name.
    }
  }
}

function readPrivateStateFile(path: string): string {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
    throw new Error(`${path} must be a regular file with mode 0600`);
  }
  return readFileSync(path, "utf8");
}

function parseRunnerDevice(value: string, name: string): RunnerDevice {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${name} is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} is not a Runner device record`);
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = record.enrolledAt === undefined
    ? ["privateKeyPem", "publicKeyPem", "runnerId", "version"]
    : ["enrolledAt", "privateKeyPem", "publicKeyPem", "runnerId", "version"];
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) {
    throw new Error(`${name} has unexpected Runner device fields`);
  }
  if (
    record.version !== 1 ||
    typeof record.runnerId !== "string" ||
    typeof record.publicKeyPem !== "string" ||
    typeof record.privateKeyPem !== "string" ||
    (record.enrolledAt !== undefined && (typeof record.enrolledAt !== "string" || Number.isNaN(Date.parse(record.enrolledAt))))
  ) {
    throw new Error(`${name} has an invalid Runner device record`);
  }
  const runnerId = requireUuid(record.runnerId, `${name}.runnerId`);
  try {
    const publicKey = createPublicKey(record.publicKeyPem);
    const privateKey = createPrivateKey(record.privateKeyPem);
    const derivedPublicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    if (publicKey.asymmetricKeyType !== "ed25519" || privateKey.asymmetricKeyType !== "ed25519" || derivedPublicKeyPem !== record.publicKeyPem) {
      throw new Error("key pair mismatch");
    }
  } catch (error) {
    throw new Error(`${name} does not contain a matching Ed25519 key pair`, { cause: error });
  }
  return {
    runnerId,
    publicKeyPem: record.publicKeyPem,
    privateKeyPem: record.privateKeyPem,
    ...(record.enrolledAt === undefined ? {} : { enrolledAt: record.enrolledAt }),
  };
}

function isRunnerModelAccessGrant(value: unknown, request: RunnerModelAccessRequestV2): value is RunnerModelAccessGrantV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  if (Object.keys(grant).length !== 9 || grant.protocolVersion !== JOB_PROTOCOL_VERSION || grant.jobId !== request.jobId || grant.runnerId !== request.runnerId || grant.leaseId !== request.leaseId || grant.tool !== request.tool || typeof grant.accessToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant.accessToken) || typeof grant.model !== "string" || !/^[A-Za-z0-9._:/-]{1,256}$/.test(grant.model) || typeof grant.expiresAt !== "string" || Date.parse(grant.expiresAt) <= Date.now()) return false;
  return (request.tool === "claude" && grant.provider === "anthropic") || ((request.tool === "codex" || request.tool === "pi") && grant.provider === "openai");
}

function requireUuid(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error(`${name} must be a UUID`);
  }
  return normalized.toLowerCase();
}

function isFileMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function collectWorktreeDiff(worktreePath: string): Promise<{ readonly name: string; readonly mediaType: string; readonly bytes: Buffer } | undefined> {
  try {
    const { stdout } = await execFile("git", ["-C", worktreePath, "diff", "--binary", "--no-ext-diff", "--"], { env: { PATH: process.env.PATH ?? "" }, maxBuffer: 700 * 1024, windowsHide: true });
    const bytes = Buffer.from(stdout, "utf8");
    return bytes.byteLength === 0 ? undefined : { name: "changes.diff", mediaType: "text/x-diff", bytes };
  } catch (error) {
    throw new Error(`Could not collect isolated worktree diff: ${errorMessage(error)}`);
  }
}

export function createTestEvidence(
  spec: JobSpecV2,
  executorImageId: string,
  stdout: string,
  stderr: string,
  patch: Buffer,
  completedAt = new Date(),
): SelfImprovementTestEvidenceV1 {
  if ((spec.operation !== "develop" && spec.operation !== "test") || !/^sha256:[a-f0-9]{64}$/.test(executorImageId) || patch.byteLength === 0) {
    throw new Error("A successful develop/test job with a verified executor and patch is required for test evidence");
  }
  return {
    protocolVersion: SELF_IMPROVEMENT_TEST_EVIDENCE_VERSION,
    jobId: spec.jobId,
    runnerId: spec.runnerId,
    jobManifestSha256: spec.manifestSha256,
    executorImageId,
    operation: spec.operation,
    exitCode: 0,
    stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
    stderrSha256: createHash("sha256").update(stderr).digest("hex"),
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    completedAt: completedAt.toISOString(),
  };
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function writeDiagnostic(message: string): void {
  process.stderr.write(`[runner] ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
