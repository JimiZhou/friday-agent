import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { JsonValue, PiWorkerImageV1 } from "@friday/protocol";
import { loadPiModelConfig, PI_CODING_AGENT_VERSION, type PiModelConfig } from "./pi-rpc.js";

const MAX_LINE_BYTES = 1_048_576;
const execFile = promisify(execFileCallback);

export interface PiRpcProxyOptions {
  readonly piBin: string;
  readonly modelConfig?: PiModelConfig;
  readonly onEvent?: (event: JsonValue) => void;
  readonly onDiagnostic?: (message: string) => void;
}

/**
 * Narrow, stateful bridge to the upstream Pi RPC process. The outer worker
 * owns its protocol framing; Pi never receives the Hub, Runner, filesystem,
 * or long-lived application environment. A dedicated temporary HOME supplies
 * the one custom OpenAI-compatible provider and disappears on close.
 */
export class PiRpcProxy {
  readonly #piBin: string;
  readonly #modelConfig: PiModelConfig;
  readonly #onEvent: (event: JsonValue) => void;
  readonly #onDiagnostic: (message: string) => void;
  #child: ChildProcessWithoutNullStreams | undefined;
  #home: string | undefined;
  #buffer = "";
  #closed = false;
  #pending = new Map<string, { resolve(value: JsonValue): void; reject(reason: Error): void }>();

  constructor(options: PiRpcProxyOptions) {
    this.#piBin = requireExecutable(options.piBin);
    this.#modelConfig = options.modelConfig ?? requiredModelConfig();
    this.#onEvent = options.onEvent ?? (() => {});
    this.#onDiagnostic = options.onDiagnostic ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Pi RPC bridge is closed");
    if (this.#child !== undefined) return;
    const home = await mkdirTemporaryHome();
    this.#home = home;
    try {
      await assertPinnedPiVersion(this.#piBin, home);
      await writeProviderConfig(home, this.#modelConfig);
      const environment = Object.freeze({
        PATH: process.env.PATH ?? "",
        HOME: home,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        FRIDAY_PI_PROVIDER_API_KEY: this.#modelConfig.apiKey,
      });
      const child = spawn(this.#piBin, [
        "--mode", "rpc",
        "--no-session",
        "--no-approve",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--model", `friday/${this.#modelConfig.model}`,
      ], {
        cwd: process.cwd(), env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      this.#child = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.#consume(chunk));
      child.stderr.on("data", (chunk: string) => this.#onDiagnostic(truncate(`Pi: ${chunk.trim()}`, 512)));
      child.once("error", (error) => this.#failAll(new Error(`Pi RPC process failed: ${error.message}`)));
      child.once("close", (code, signal) => {
        this.#child = undefined;
        this.#failAll(new Error(`Pi RPC process exited (${code === null ? signal ?? "unknown" : code})`));
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async command(
    type: "prompt" | "steer" | "follow_up" | "abort" | "get_state" | "compact",
    message?: string,
    images?: readonly PiWorkerImageV1[],
  ): Promise<JsonValue> {
    await this.start();
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed) throw new Error("Pi RPC process is unavailable");
    const id = randomUUID();
    const command = message === undefined
      ? { id, type }
      : { id, type, message, ...(images === undefined || images.length === 0 ? {} : { images }) };
    return new Promise<JsonValue>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error !== undefined && error !== null) {
          this.#pending.delete(id);
          reject(new Error(`Pi RPC request could not be written: ${error.message}`));
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    this.#child = undefined;
    this.#failAll(new Error("Pi RPC bridge closed"));
    if (child !== undefined && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
    if (this.#home !== undefined) {
      const home = this.#home;
      this.#home = undefined;
      await rm(home, { recursive: true, force: true });
    }
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) break;
      let line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) { this.#failAll(new Error("Pi RPC emitted an oversized record")); return; }
      if (line === "") continue;
      let value: unknown;
      try { value = JSON.parse(line) as unknown; } catch { this.#failAll(new Error("Pi RPC emitted invalid JSON")); return; }
      if (!isRecord(value) || typeof value.type !== "string") { this.#failAll(new Error("Pi RPC emitted an invalid record")); return; }
      if (value.type === "response" && typeof value.id === "string") {
        const pending = this.#pending.get(value.id);
        if (pending !== undefined) {
          this.#pending.delete(value.id);
          if (value.success === true) pending.resolve(asJsonValue(value));
          else pending.reject(new Error("Pi RPC rejected the command"));
          continue;
        }
      }
      this.#onEvent(asJsonValue(value));
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES) this.#failAll(new Error("Pi RPC emitted an oversized unterminated record"));
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function requiredModelConfig(): PiModelConfig {
  const config = loadPiModelConfig();
  if (config === undefined) throw new Error("PI_MODEL_NOT_CONFIGURED: refusing to launch Pi without private model configuration");
  return config;
}

function requireExecutable(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) throw new Error("FRIDAY_PI_BIN must be a non-empty executable path or command");
  return value;
}

async function assertPinnedPiVersion(piBin: string, home: string): Promise<void> {
  let stdout: string;
  try { ({ stdout } = await execFile(piBin, ["--version"], { env: { PATH: process.env.PATH ?? "", HOME: home, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true })); } catch { throw new Error(`PI_VERSION_UNVERIFIED: ${PI_CODING_AGENT_VERSION} is required`); }
  if (!new RegExp(`(?:^|[^0-9])${PI_CODING_AGENT_VERSION.replace(/\./g, "\\.")}(?:$|[^0-9])`).test(stdout.trim())) throw new Error(`PI_VERSION_UNVERIFIED: ${PI_CODING_AGENT_VERSION} is required`);
}

async function mkdirTemporaryHome(): Promise<string> {
  const home = join(tmpdir(), `friday-pi-${randomUUID()}`);
  await mkdir(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  return home;
}

async function writeProviderConfig(home: string, config: PiModelConfig): Promise<void> {
  const contents = JSON.stringify({ providers: { friday: { baseUrl: config.baseUrl.toString().replace(/\/$/, ""), api: "openai-completions", apiKey: "$FRIDAY_PI_PROVIDER_API_KEY", models: [{ id: config.model, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }] } } });
  await writeFile(join(home, ".pi", "agent", "models.json"), contents, { mode: 0o600 });
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asJsonValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function truncate(value: string, maximum: number): string { return Buffer.byteLength(value, "utf8") <= maximum ? value : Buffer.from(value).subarray(0, maximum).toString("utf8"); }
