import { isAbsolute, resolve } from "node:path";
import { createPublicKey } from "node:crypto";
import { loadVoiceProviderConfig, type VoiceProviderConfig, validateVoiceProviderConfig } from "./m2-registry.js";

export interface FridayConfig {
  host: string;
  port: number;
  stateDir: string;
  ownerId: string;
  ownerToken: string;
  publicOrigin?: string;
  webauthnRpId?: string;
  /** Simple single-Owner Web login secret, stored only in the root-owned Hub env file. */
  webPassword?: string;
  /** Enables the fixed-origin, no-secret web search tool available to Pi. */
  webSearchEnabled?: boolean;
  /** Optional M3 Owner signing key. Procedures stay unavailable when absent. */
  procedureOwnerPublicKeyPem?: string;
  /** Optional M3 Owner signing key. Skills stay inert and unavailable when absent. */
  skillOwnerPublicKeyPem?: string;
  voiceProvider?: VoiceProviderConfig;
  /** Explicitly permits the no-secret Streamable HTTP MCP transport. */
  mcpBrokerEnabled?: boolean;
  /** Private Unix socket owned by the separately deployed M3 Broker. */
  mcpBrokerSocketPath?: string;
  /** Complete, explicit configuration for the inference-only Pi Worker. */
  conversationAgent?: ConversationAgentConfig;
  /** Optional credential-isolating proxy used only by enrolled remote Runners. */
  runnerModelProxy?: RunnerModelProxyConfig;
  /** The only registered Workspace from which Friday may derive its own patch. */
  selfImprovementWorkspaceId?: string;
  /** Optional loopback-only control plane for the isolated Channel Gateway. */
  channelGateway?: ChannelGatewayControlConfig;
  /** Allows an explicitly paired private channel to confirm R1/R2 node calls. */
  channelApprovalEnabled?: boolean;
  maxBodyBytes: number;
}

export interface ChannelGatewayControlConfig {
  readonly controlUrl: URL;
  readonly controlToken: string;
}

export interface ConversationAgentConfig {
  readonly nodeExecutable: string;
  readonly workerScriptPath: string;
  readonly piBin: string;
  readonly baseUrl: URL;
  readonly model: string;
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
  readonly turnTimeoutMs: number;
}

export interface RunnerOpenAiModelConfig {
  readonly baseUrl: URL;
  readonly apiKey: string;
  readonly codexModel: string;
  readonly piModel: string;
}

export interface RunnerAnthropicModelConfig {
  readonly baseUrl: URL;
  readonly apiKey: string;
  readonly claudeModel: string;
}

export interface RunnerModelProxyConfig {
  readonly openai?: RunnerOpenAiModelConfig;
  readonly anthropic?: RunnerAnthropicModelConfig;
  readonly tokenTtlSeconds: number;
  readonly requestTimeoutMs: number;
  readonly maxRequestBytes: number;
}

function readPort(value: string | undefined): number {
  if (value === undefined) return 4310;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid FRIDAY_PORT: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid FRIDAY_PORT: ${value}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FridayConfig {
  if (env.FRIDAY_RUNNER_TOKEN !== undefined) {
    throw new Error(
      "FRIDAY_RUNNER_TOKEN is no longer supported; enroll each Runner with FRIDAY_RUNNER_ENROLLMENT_TOKEN",
    );
  }
  const voiceProvider = loadVoiceProviderConfig(env);
  const mcpBrokerEnabled = readOptionalBoolean(env.FRIDAY_MCP_BROKER_ENABLE, "FRIDAY_MCP_BROKER_ENABLE");
  const mcpBrokerSocketPath = env.FRIDAY_MCP_BROKER_SOCKET;
  const conversationEnabled = readOptionalBoolean(env.FRIDAY_CONVERSATION_ENABLE, "FRIDAY_CONVERSATION_ENABLE");
  const webSearchEnabled = readOptionalBoolean(env.FRIDAY_WEB_SEARCH_ENABLE, "FRIDAY_WEB_SEARCH_ENABLE");
  const channelApprovalEnabled = readOptionalBoolean(env.FRIDAY_CHANNEL_APPROVAL_ENABLE, "FRIDAY_CHANNEL_APPROVAL_ENABLE");
  const conversationAgent = conversationEnabled === true ? loadConversationAgentConfig(env) : undefined;
  const runnerModelProxy = loadRunnerModelProxyConfig(env);
  const channelGateway = loadChannelGatewayControlConfig(env);
  const config: FridayConfig = {
    host: env.FRIDAY_HOST ?? "127.0.0.1",
    port: readPort(env.FRIDAY_PORT),
    stateDir: resolve(env.FRIDAY_STATE_DIR ?? ".friday/state"),
    ownerId: env.FRIDAY_OWNER_ID ?? "owner",
    ownerToken: env.FRIDAY_OWNER_TOKEN ?? "local-owner-token",
    ...(env.FRIDAY_PUBLIC_ORIGIN === undefined ? {} : { publicOrigin: env.FRIDAY_PUBLIC_ORIGIN }),
    ...(env.FRIDAY_WEBAUTHN_RP_ID === undefined ? {} : { webauthnRpId: env.FRIDAY_WEBAUTHN_RP_ID }),
    ...(env.FRIDAY_WEB_PASSWORD === undefined ? {} : { webPassword: env.FRIDAY_WEB_PASSWORD }),
    ...(webSearchEnabled === undefined ? {} : { webSearchEnabled }),
    ...(env.FRIDAY_PROCEDURE_OWNER_PUBLIC_KEY === undefined ? {} : { procedureOwnerPublicKeyPem: env.FRIDAY_PROCEDURE_OWNER_PUBLIC_KEY }),
    ...(env.FRIDAY_SKILL_OWNER_PUBLIC_KEY === undefined ? {} : { skillOwnerPublicKeyPem: env.FRIDAY_SKILL_OWNER_PUBLIC_KEY }),
    ...(voiceProvider === undefined ? {} : { voiceProvider }),
    ...(mcpBrokerEnabled === undefined ? {} : { mcpBrokerEnabled }),
    ...(mcpBrokerSocketPath === undefined || mcpBrokerSocketPath === "" ? {} : { mcpBrokerSocketPath }),
    ...(conversationAgent === undefined ? {} : { conversationAgent }),
    ...(runnerModelProxy === undefined ? {} : { runnerModelProxy }),
    selfImprovementWorkspaceId: env.FRIDAY_SELF_WORKSPACE_ID ?? "friday-agent",
    ...(channelGateway === undefined ? {} : { channelGateway }),
    ...(channelApprovalEnabled === undefined ? {} : { channelApprovalEnabled }),
    maxBodyBytes: 1_048_576,
  };
  validateConfig(config);
  return config;
}

/** Enforce the current loopback-only safety boundary even for programmatic construction. */
export function validateConfig(config: FridayConfig): void {
  readToken(config.ownerToken, "FRIDAY_OWNER_TOKEN");
  if (!isLoopbackHost(config.host)) {
    throw new Error("fridayd only supports loopback until Tailnet transport and Hub identity are enabled");
  }
  if (typeof config.ownerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(config.ownerId)) {
    throw new Error("FRIDAY_OWNER_ID must be a non-empty identifier");
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw new Error(`Invalid FRIDAY_PORT: ${config.port}`);
  }
  if (!Number.isSafeInteger(config.maxBodyBytes) || config.maxBodyBytes < 1 || config.maxBodyBytes > 16 * 1_048_576) {
    throw new Error("maxBodyBytes must be a positive safe integer no greater than 16 MiB");
  }
  if (typeof config.stateDir !== "string" || config.stateDir.trim() === "") {
    throw new Error("stateDir must not be empty");
  }
  if (config.publicOrigin !== undefined) {
    let origin: URL;
    try { origin = new URL(config.publicOrigin); } catch { throw new Error("FRIDAY_PUBLIC_ORIGIN must be an absolute HTTPS URL"); }
    if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
      throw new Error("FRIDAY_PUBLIC_ORIGIN must be an origin-only HTTPS URL");
    }
    if (config.webauthnRpId !== undefined && config.webauthnRpId !== origin.hostname) {
      throw new Error("FRIDAY_WEBAUTHN_RP_ID must equal the FRIDAY_PUBLIC_ORIGIN hostname");
    }
  } else if (config.webauthnRpId !== undefined) {
    throw new Error("FRIDAY_WEBAUTHN_RP_ID requires FRIDAY_PUBLIC_ORIGIN");
  }
  if (
    config.webPassword !== undefined &&
    (
      config.publicOrigin === undefined ||
      config.webPassword.length < 12 ||
      config.webPassword.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(config.webPassword)
    )
  ) {
    throw new Error("FRIDAY_WEB_PASSWORD requires FRIDAY_PUBLIC_ORIGIN and 12-256 characters without control bytes");
  }
  if (config.webSearchEnabled !== undefined && typeof config.webSearchEnabled !== "boolean") {
    throw new Error("FRIDAY_WEB_SEARCH_ENABLE must be boolean");
  }
  if (config.channelApprovalEnabled !== undefined && typeof config.channelApprovalEnabled !== "boolean") {
    throw new Error("FRIDAY_CHANNEL_APPROVAL_ENABLE must be boolean");
  }
  if (config.procedureOwnerPublicKeyPem !== undefined) {
    try {
      if (createPublicKey(config.procedureOwnerPublicKeyPem).asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    } catch {
      throw new Error("FRIDAY_PROCEDURE_OWNER_PUBLIC_KEY must contain an Ed25519 public key");
    }
  }
  if (config.skillOwnerPublicKeyPem !== undefined) {
    try {
      if (createPublicKey(config.skillOwnerPublicKeyPem).asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    } catch {
      throw new Error("FRIDAY_SKILL_OWNER_PUBLIC_KEY must contain an Ed25519 public key");
    }
  }
  if (config.mcpBrokerSocketPath !== undefined && (!config.mcpBrokerSocketPath.startsWith("/") || config.mcpBrokerSocketPath.includes("\0"))) {
    throw new Error("FRIDAY_MCP_BROKER_SOCKET must be an absolute Unix socket path");
  }
  if (config.mcpBrokerEnabled === true && config.mcpBrokerSocketPath === undefined) {
    throw new Error("FRIDAY_MCP_BROKER_ENABLE=1 requires FRIDAY_MCP_BROKER_SOCKET for the isolated Broker");
  }
  if (config.conversationAgent !== undefined) validateConversationAgentConfig(config.conversationAgent);
  if (config.runnerModelProxy !== undefined) validateRunnerModelProxyConfig(config.runnerModelProxy);
  if (config.channelGateway !== undefined) validateChannelGatewayControlConfig(config.channelGateway);
  if (config.selfImprovementWorkspaceId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.selfImprovementWorkspaceId)) {
    throw new Error("FRIDAY_SELF_WORKSPACE_ID must be a valid registered Workspace id");
  }
  if (config.voiceProvider !== undefined) validateVoiceProviderConfig(config.voiceProvider);
}

function loadRunnerModelProxyConfig(env: NodeJS.ProcessEnv): RunnerModelProxyConfig | undefined {
  const openaiValues = [
    env.FRIDAY_RUNNER_OPENAI_BASE_URL,
    env.FRIDAY_RUNNER_OPENAI_API_KEY,
    env.FRIDAY_RUNNER_CODEX_MODEL,
    env.FRIDAY_RUNNER_PI_MODEL,
  ];
  const anthropicValues = [
    env.FRIDAY_RUNNER_ANTHROPIC_BASE_URL,
    env.FRIDAY_RUNNER_ANTHROPIC_API_KEY,
    env.FRIDAY_RUNNER_CLAUDE_MODEL,
  ];
  const hasOpenAi = openaiValues.some((value) => value !== undefined && value !== "");
  const hasAnthropic = anthropicValues.some((value) => value !== undefined && value !== "");
  if (!hasOpenAi && !hasAnthropic) return undefined;
  if (hasOpenAi && openaiValues.some((value) => value === undefined || value === "")) {
    throw new Error("Runner OpenAI proxy requires base URL, API key, Codex model, and Pi model together");
  }
  if (hasAnthropic && anthropicValues.some((value) => value === undefined || value === "")) {
    throw new Error("Runner Anthropic proxy requires base URL, API key, and Claude model together");
  }
  const openai = hasOpenAi ? {
    baseUrl: parseModelBaseUrl(env.FRIDAY_RUNNER_OPENAI_BASE_URL as string, "FRIDAY_RUNNER_OPENAI_BASE_URL"),
    apiKey: env.FRIDAY_RUNNER_OPENAI_API_KEY as string,
    codexModel: env.FRIDAY_RUNNER_CODEX_MODEL as string,
    piModel: env.FRIDAY_RUNNER_PI_MODEL as string,
  } : undefined;
  const anthropic = hasAnthropic ? {
    baseUrl: parseModelBaseUrl(env.FRIDAY_RUNNER_ANTHROPIC_BASE_URL as string, "FRIDAY_RUNNER_ANTHROPIC_BASE_URL"),
    apiKey: env.FRIDAY_RUNNER_ANTHROPIC_API_KEY as string,
    claudeModel: env.FRIDAY_RUNNER_CLAUDE_MODEL as string,
  } : undefined;
  return {
    ...(openai === undefined ? {} : { openai }),
    ...(anthropic === undefined ? {} : { anthropic }),
    tokenTtlSeconds: readPositiveInteger(env.FRIDAY_RUNNER_MODEL_TOKEN_TTL_SECONDS, 300, "FRIDAY_RUNNER_MODEL_TOKEN_TTL_SECONDS"),
    requestTimeoutMs: readPositiveInteger(env.FRIDAY_RUNNER_MODEL_REQUEST_TIMEOUT_MS, 15 * 60_000, "FRIDAY_RUNNER_MODEL_REQUEST_TIMEOUT_MS"),
    maxRequestBytes: readPositiveInteger(env.FRIDAY_RUNNER_MODEL_MAX_REQUEST_BYTES, 16 * 1_048_576, "FRIDAY_RUNNER_MODEL_MAX_REQUEST_BYTES"),
  };
}

function parseModelBaseUrl(value: string, name: string): URL {
  let baseUrl: URL;
  try { baseUrl = new URL(value); } catch { throw new Error(`${name} must be an absolute URL`); }
  const loopback = baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "[::1]";
  if ((baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && loopback)) || baseUrl.username !== "" || baseUrl.password !== "" || baseUrl.search !== "" || baseUrl.hash !== "" || !baseUrl.pathname.endsWith("/")) {
    throw new Error(`${name} must be an HTTPS base URL ending in / without credentials, query, or fragment`);
  }
  return baseUrl;
}

function validateRunnerModelProxyConfig(config: RunnerModelProxyConfig): void {
  if (config.openai === undefined && config.anthropic === undefined) throw new Error("Runner model proxy has no provider");
  if (config.openai !== undefined) {
    parseModelBaseUrl(config.openai.baseUrl.toString(), "Runner OpenAI base URL");
    validatePrivateModelApiKey(config.openai.apiKey, "Runner OpenAI API key");
    validateModelId(config.openai.codexModel, "Runner Codex model");
    validateModelId(config.openai.piModel, "Runner Pi model");
  }
  if (config.anthropic !== undefined) {
    parseModelBaseUrl(config.anthropic.baseUrl.toString(), "Runner Anthropic base URL");
    validatePrivateModelApiKey(config.anthropic.apiKey, "Runner Anthropic API key");
    validateModelId(config.anthropic.claudeModel, "Runner Claude model");
  }
  if (!Number.isSafeInteger(config.tokenTtlSeconds) || config.tokenTtlSeconds < 30 || config.tokenTtlSeconds > 900) throw new Error("Runner model token TTL must be between 30 and 900 seconds");
  if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1_000 || config.requestTimeoutMs > 30 * 60_000) throw new Error("Runner model request timeout must be between 1000 and 1800000 ms");
  if (!Number.isSafeInteger(config.maxRequestBytes) || config.maxRequestBytes < 1_024 || config.maxRequestBytes > 32 * 1_048_576) throw new Error("Runner model request limit must be between 1 KiB and 32 MiB");
}

function validatePrivateModelApiKey(value: string, name: string): void {
  if (typeof value !== "string" || value.length < 16 || value.length > 2048 || /\s/.test(value)) throw new Error(`${name} is invalid`);
}

function validateModelId(value: string, name: string): void {
  if (!/^[A-Za-z0-9._:/-]{1,256}$/.test(value)) throw new Error(`${name} is invalid`);
}

function loadChannelGatewayControlConfig(env: NodeJS.ProcessEnv): ChannelGatewayControlConfig | undefined {
  const urlValue = env.FRIDAY_CHANNEL_GATEWAY_CONTROL_URL;
  const token = env.FRIDAY_CHANNEL_GATEWAY_CONTROL_TOKEN;
  if ((urlValue === undefined || urlValue === "") && (token === undefined || token === "")) return undefined;
  if (urlValue === undefined || urlValue === "" || token === undefined || token === "") {
    throw new Error("Friday Channel Gateway control URL and token must be configured together");
  }
  let controlUrl: URL;
  try { controlUrl = new URL(urlValue); } catch { throw new Error("FRIDAY_CHANNEL_GATEWAY_CONTROL_URL must be an absolute loopback URL"); }
  return { controlUrl, controlToken: token };
}

function validateChannelGatewayControlConfig(config: ChannelGatewayControlConfig): void {
  if ((config.controlUrl.protocol !== "http:" && config.controlUrl.protocol !== "https:") || !isLoopbackHost(config.controlUrl.hostname) || config.controlUrl.username !== "" || config.controlUrl.password !== "") {
    throw new Error("FRIDAY_CHANNEL_GATEWAY_CONTROL_URL must use loopback HTTP(S) without credentials");
  }
  if (!config.controlUrl.pathname.endsWith("/") || config.controlUrl.search !== "" || config.controlUrl.hash !== "") {
    throw new Error("FRIDAY_CHANNEL_GATEWAY_CONTROL_URL must end with a path slash and have no query or fragment");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(config.controlToken)) {
    throw new Error("FRIDAY_CHANNEL_GATEWAY_CONTROL_TOKEN must be a 32-byte base64url token");
  }
}

function loadConversationAgentConfig(env: NodeJS.ProcessEnv): ConversationAgentConfig {
  const required = {
    workerScriptPath: env.FRIDAY_PI_WORKER_SCRIPT,
    piBin: env.FRIDAY_PI_BIN,
    baseUrl: env.FRIDAY_PI_BASE_URL,
    model: env.FRIDAY_PI_MODEL,
    apiKey: env.FRIDAY_PI_API_KEY,
  };
  if (Object.values(required).some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new Error("FRIDAY_CONVERSATION_ENABLE=1 requires Pi Worker script, binary, base URL, model, and API key");
  }
  let baseUrl: URL;
  try { baseUrl = new URL(required.baseUrl as string); } catch { throw new Error("FRIDAY_PI_BASE_URL must be an absolute URL"); }
  return {
    nodeExecutable: env.FRIDAY_PI_NODE_BIN ?? process.execPath,
    workerScriptPath: required.workerScriptPath as string,
    piBin: required.piBin as string,
    baseUrl,
    model: required.model as string,
    apiKey: required.apiKey as string,
    requestTimeoutMs: readPositiveInteger(env.FRIDAY_PI_WORKER_REQUEST_TIMEOUT_MS, 10_000, "FRIDAY_PI_WORKER_REQUEST_TIMEOUT_MS"),
    turnTimeoutMs: readPositiveInteger(env.FRIDAY_PI_TURN_TIMEOUT_MS, 180_000, "FRIDAY_PI_TURN_TIMEOUT_MS"),
  };
}

function validateConversationAgentConfig(config: ConversationAgentConfig): void {
  if (!isAbsolute(config.nodeExecutable) || config.nodeExecutable.includes("\0")) {
    throw new Error("FRIDAY_PI_NODE_BIN must be an absolute executable path");
  }
  if (!isAbsolute(config.workerScriptPath) || config.workerScriptPath.includes("\0")) {
    throw new Error("FRIDAY_PI_WORKER_SCRIPT must be an absolute path");
  }
  if (!isAbsolute(config.piBin) || config.piBin.length > 1024 || config.piBin.includes("\0")) {
    throw new Error("FRIDAY_PI_BIN must be an absolute executable path");
  }
  const loopback = config.baseUrl.hostname === "127.0.0.1" || config.baseUrl.hostname === "[::1]";
  if ((config.baseUrl.protocol !== "https:" && !loopback) || config.baseUrl.username !== "" || config.baseUrl.password !== "") {
    throw new Error("FRIDAY_PI_BASE_URL must be HTTPS or an explicit loopback endpoint without credentials");
  }
  if (config.baseUrl.pathname === "" || !config.baseUrl.pathname.endsWith("/")) {
    throw new Error("FRIDAY_PI_BASE_URL must end with a path slash");
  }
  if (!/^[A-Za-z0-9._:/-]{1,256}$/.test(config.model)) throw new Error("FRIDAY_PI_MODEL is invalid");
  if (config.apiKey.length < 16 || config.apiKey.length > 1024 || /\s/.test(config.apiKey)) throw new Error("FRIDAY_PI_API_KEY is invalid");
  if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 100 || config.requestTimeoutMs > 60_000) {
    throw new Error("FRIDAY_PI_WORKER_REQUEST_TIMEOUT_MS must be between 100 and 60000");
  }
  if (!Number.isSafeInteger(config.turnTimeoutMs) || config.turnTimeoutMs < 1_000 || config.turnTimeoutMs > 15 * 60_000) {
    throw new Error("FRIDAY_PI_TURN_TIMEOUT_MS must be between 1000 and 900000");
  }
}

function readToken(value: string, name: string): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 512 || /\s/.test(value)) {
    throw new Error(`${name} must contain 16-512 non-whitespace characters`);
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

function readOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be 0 or 1`);
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}
