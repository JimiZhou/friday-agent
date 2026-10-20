import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { abortDelay, configurableChannel, CONFIGURABLE_CHANNELS, createTextAdapter, object, validateChannelCredentials, type AdapterCallbacks, type ChannelCredentials, type ConfigurableChannel, type TextAdapter } from "./channel-adapters.js";
import { channelOutboxLoop, forwardInbound, sendTelegramText, telegramLongPoll, type GatewayConfig, type Inbound } from "./index.js";

interface StoredChannel {
  readonly senderId: string;
  readonly ingestToken: string;
  readonly credentials: ChannelCredentials;
}
interface RuntimeChannel {
  readonly controller: AbortController;
  connected: boolean;
  status: "connecting" | "connected" | "retrying";
  task: Promise<void>;
}
export type AdapterFactory = (channel: Exclude<ConfigurableChannel, "telegram">, credentials: ChannelCredentials, callbacks: AdapterCallbacks, signal: AbortSignal) => Promise<TextAdapter>;

export class ChannelRuntime {
  readonly #running = new Map<ConfigurableChannel, RuntimeChannel>();
  readonly #stored = new Map<ConfigurableChannel, StoredChannel>();
  #savedCmccCredentials: ChannelCredentials | undefined;
  #barrier: Promise<unknown> = Promise.resolve();
  constructor(readonly config: GatewayConfig, readonly directory: string, readonly signal: AbortSignal, readonly factory: AdapterFactory = createTextAdapter) {
    signal.addEventListener("abort", () => { for (const runtime of this.#running.values()) runtime.controller.abort(); }, { once: true });
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const path = join(this.directory, "cmcc-api-key.json"), stat = await lstat(path);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new Error("CHANNEL_CONFIG_NOT_PRIVATE");
      this.#savedCmccCredentials = validateChannelCredentials("cmcc", JSON.parse(await readFile(path, "utf8")));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid private CMCC key file"); }
    for (const channel of CONFIGURABLE_CHANNELS) {
      try {
        const path = this.#path(channel), stat = await lstat(path);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024) throw new Error("CHANNEL_CONFIG_NOT_PRIVATE");
        const raw = object(JSON.parse(await readFile(path, "utf8")));
        if (raw?.disabled === true) continue;
        const stored = this.#validate(channel, raw);
        this.#stored.set(channel, stored);
        this.#launch(channel, stored);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid private ${channel} configuration`); }
    }
  }

  status(): readonly Record<string, unknown>[] {
    return CONFIGURABLE_CHANNELS.map((channel) => {
      const runtime = this.#running.get(channel);
      return { channel, configured: this.#stored.has(channel), hasSavedCredentials: this.#stored.has(channel) || (channel === "cmcc" && this.#savedCmccCredentials !== undefined), connected: runtime?.connected === true, status: runtime?.status ?? "disabled", transport: channel === "telegram" ? "long-poll" : "websocket", textOnly: true };
    });
  }

  configure(channel: ConfigurableChannel, input: unknown): Promise<void> {
    const value = object(input);
    const credentials = object(value?.credentials);
    const saved = this.#stored.get(channel)?.credentials ?? (channel === "cmcc" ? this.#savedCmccCredentials : undefined);
    const reuse = credentials !== undefined && Object.keys(credentials).length === 0 && saved !== undefined;
    const stored = this.#validate(channel, reuse ? { ...value, credentials: saved } : input);
    return this.#serialize(async () => {
      await this.#persist(channel, stored);
      this.#running.get(channel)?.controller.abort();
      const previous = this.#running.get(channel)?.task;
      if (previous !== undefined) await previous;
      this.#stored.set(channel, stored);
      this.#launch(channel, stored);
    });
  }

  disable(channel: ConfigurableChannel): Promise<void> {
    return this.#serialize(async () => {
      await this.#persist(channel, { disabled: true });
      this.#running.get(channel)?.controller.abort();
      this.#running.delete(channel);
      this.#stored.delete(channel);
    });
  }

  async legacyTelegram(botToken: string): Promise<void> {
    if (this.#stored.has("telegram")) return;
    try { await lstat(this.#path("telegram")); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const ingestToken = this.config.tokens.telegram;
    if (ingestToken !== undefined) {
      const stored = { senderId: "", ingestToken, credentials: { botToken } };
      this.#stored.set("telegram", stored);
      this.#launch("telegram", stored);
    }
  }

  #validate(channel: ConfigurableChannel, input: unknown): StoredChannel {
    const value = object(input);
    if (value === undefined || Object.keys(value).some((key) => !["senderId", "ingestToken", "credentials"].includes(key)) || typeof value.senderId !== "string" || !value.senderId.trim() || value.senderId.length > 256 || /[\x00-\x20\x7f]/.test(value.senderId) || typeof value.ingestToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.ingestToken)) throw new Error("INVALID_CHANNEL_CONFIG");
    if (channel === "telegram" && !/^\d+$/.test(value.senderId)) throw new Error("INVALID_CHANNEL_CONFIG");
    return { senderId: value.senderId, ingestToken: value.ingestToken, credentials: validateChannelCredentials(channel, value.credentials) };
  }

  #launch(channel: ConfigurableChannel, stored: StoredChannel): void {
    if (this.signal.aborted) return;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    this.signal.addEventListener("abort", onAbort, { once: true });
    const runtime: RuntimeChannel = { controller, connected: false, status: "connecting", task: Promise.resolve() };
    this.#running.set(channel, runtime);
    const config: GatewayConfig = { hubUrl: this.config.hubUrl, tokens: { [channel]: stored.ingestToken } };
    const callbacks: AdapterCallbacks = {
      accepts: (senderId) => senderId === stored.senderId,
      inbound: async (message: Inbound) => {
        if (message.senderId !== stored.senderId || controller.signal.aborted) return undefined;
        return (await forwardInbound(config, message)).reply;
      },
      connected: (connected) => { runtime.connected = connected; runtime.status = connected ? "connected" : "retrying"; },
      failure: () => { runtime.status = "retrying"; },
    };
    runtime.task = (async () => {
      if (channel === "telegram") {
        const botToken = stored.credentials.botToken as string;
        await Promise.all([
          (async () => { while (!controller.signal.aborted) {
            try { callbacks.connected(true); await telegramLongPoll(config, botToken, controller.signal); }
            catch { callbacks.connected(false); if (!controller.signal.aborted) await abortDelay(5000, controller.signal); }
          } })(),
          channelOutboxLoop(config, channel, controller.signal, (notification) => sendTelegramText(botToken, { channel, senderId: notification.senderId, messageId: notification.notificationId, group: false, text: notification.text }, notification.text, controller.signal)),
        ]);
      } else {
        const adapter = await this.factory(channel, stored.credentials, callbacks, controller.signal);
        try {
          await channelOutboxLoop(config, channel, controller.signal, async (notification) => {
            if (notification.senderId !== stored.senderId) throw new Error("CHANNEL_RECIPIENT_MISMATCH");
            await adapter.send(notification.senderId, notification.text, notification.notificationId);
          });
        } finally { adapter.stop(); }
      }
    })().catch(() => { callbacks.connected(false); }).finally(() => this.signal.removeEventListener("abort", onAbort));
  }

  #path(channel: ConfigurableChannel): string { return join(this.directory, `${channel}-channel.json`); }
  async #persist(channel: ConfigurableChannel, value: unknown): Promise<void> {
    const temporary = `${this.#path(channel)}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path(channel));
    } finally { await rm(temporary, { force: true }); }
  }
  #serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.#barrier.then(operation);
    this.#barrier = result.catch(() => {});
    return result;
  }
}

export async function channelControl(runtime: ChannelRuntime, method: string, pathname: string, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown } | undefined> {
  if (method === "GET" && pathname === "/v1/channels/status") return { status: 200, body: { channels: runtime.status() } };
  const match = pathname.match(/^\/v1\/channels\/([a-z]+)\/(configure|disable)$/);
  if (method !== "POST" || match?.[1] === undefined || !configurableChannel(match[1])) return undefined;
  try {
    const body = await readBody();
    if (match[2] === "configure") await runtime.configure(match[1], body);
    else {
      if (object(body) === undefined || Object.keys(body as object).length > 0) throw new Error("INVALID_CHANNEL_CONFIG");
      await runtime.disable(match[1]);
    }
    return { status: 200, body: { configured: match[2] === "configure" } };
  } catch { return { status: 400, body: { error: { code: "INVALID_CHANNEL_CONFIG", message: "Check channel credentials, sender ID and private state directory" } } }; }
}
