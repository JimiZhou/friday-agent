import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import * as Lark from "@larksuiteoapi/node-sdk";
import { WSClient as WecomClient } from "@wecom/aibot-node-sdk";
import type { Inbound } from "./index.js";

export const CONFIGURABLE_CHANNELS = ["telegram", "feishu", "wecom", "qq", "cmcc"] as const;
export type ConfigurableChannel = typeof CONFIGURABLE_CHANNELS[number];
export type ChannelCredentials = Readonly<Record<string, string>>;
export interface TextAdapter {
  send(senderId: string, text: string, messageId: string): Promise<void>;
  stop(): void;
}
export interface AdapterCallbacks {
  readonly accepts: (senderId: string) => boolean;
  readonly inbound: (message: Inbound) => Promise<string | undefined>;
  readonly connected: (connected: boolean) => void;
  readonly failure: () => void;
}
const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };

export function configurableChannel(value: string): value is ConfigurableChannel {
  return (CONFIGURABLE_CHANNELS as readonly string[]).includes(value);
}

export function validateChannelCredentials(channel: ConfigurableChannel, value: unknown): ChannelCredentials {
  const fields: Record<ConfigurableChannel, readonly string[]> = {
    telegram: ["botToken"], feishu: ["appId", "appSecret"], wecom: ["botId", "secret"], qq: ["appId", "appSecret"], cmcc: ["apiKey"],
  };
  const input = object(value);
  if (input === undefined || Object.keys(input).some((key) => !fields[channel].includes(key))) throw new Error("INVALID_CHANNEL_CREDENTIALS");
  const result: Record<string, string> = {};
  for (const field of fields[channel]) {
    const entry = input[field];
    if (typeof entry !== "string" || entry.trim() !== entry || entry.length < 1 || entry.length > 4096 || /[\x00-\x20\x7f]/.test(entry)) throw new Error("INVALID_CHANNEL_CREDENTIALS");
    result[field] = entry;
  }
  if (channel === "telegram" && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(result.botToken as string)) throw new Error("INVALID_CHANNEL_CREDENTIALS");
  if (channel === "cmcc" && !/^(?:ak|app)_[A-Za-z0-9_-]{8,}$/.test(result.apiKey as string)) throw new Error("INVALID_CHANNEL_CREDENTIALS");
  return result;
}

export function channelInbound(channel: ConfigurableChannel, event: unknown): Inbound | undefined {
  const value = object(event);
  if (value === undefined) return undefined;
  let id: unknown, sender: unknown, text: unknown;
  if (channel === "feishu") {
    const message = object(value.message), author = object(object(value.sender)?.sender_id);
    if (message?.chat_type !== "p2p" || message.message_type !== "text") return undefined;
    id = message.message_id; sender = author?.open_id;
    try { text = object(JSON.parse(String(message.content)))?.text; } catch { return undefined; }
  } else if (channel === "wecom") {
    const body = object(value.body);
    if (body?.chattype !== "single" || body.msgtype !== "text") return undefined;
    id = body.msgid; sender = object(body.from)?.userid; text = object(body.text)?.content;
  } else if (channel === "qq") {
    if (value.t !== "C2C_MESSAGE_CREATE") return undefined;
    const body = object(value.d);
    id = body?.id; sender = object(body?.author)?.user_openid; text = body?.content;
  } else if (channel === "cmcc") {
    if (!["message", "text_message"].includes(String(value.type)) || value.group === true || value.groupId || value.group_id) return undefined;
    id = value.messageId ?? value.id; sender = value.from ?? value.phone; text = value.content;
  } else return undefined;
  if ((typeof id !== "string" && typeof id !== "number") || typeof sender !== "string" || !sender || sender.length > 256 || typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 16 * 1024) return undefined;
  const hash = createHash("sha256").update(`${channel}:${id}`).digest("hex");
  const messageId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return { channel, messageId, senderId: sender, group: false, text: text.trim() };
}

export async function createTextAdapter(channel: Exclude<ConfigurableChannel, "telegram">, credentials: ChannelCredentials, callbacks: AdapterCallbacks, signal: AbortSignal): Promise<TextAdapter> {
  const adapter = await createProviderAdapter(channel, credentials, callbacks, signal);
  return { stop: () => adapter.stop(), async send(senderId, text, messageId) {
    for (const [index, chunk] of textChunks(text).entries()) await adapter.send(senderId, chunk, `${messageId}-${index}`);
  } };
}

export function textChunks(text: string, limit = 3500): readonly string[] {
  if (text.length === 0 || Buffer.byteLength(text) > 128 * 1024) throw new Error("INVALID_CHANNEL_TEXT");
  const chunks: string[] = []; let current = "", size = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > limit) { chunks.push(current); current = ""; size = 0; }
    current += character; size += bytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function createProviderAdapter(channel: Exclude<ConfigurableChannel, "telegram">, credentials: ChannelCredentials, callbacks: AdapterCallbacks, signal: AbortSignal): Promise<TextAdapter> {
  if (channel === "feishu") {
    const appId = credentials.appId as string, appSecret = credentials.appSecret as string;
    const client = new Lark.Client({ appId, appSecret, logger: silentLogger });
    const socket = new Lark.WSClient({ appId, appSecret, logger: silentLogger, handshakeTimeoutMs: 10_000, onReady: () => callbacks.connected(true), onReconnecting: () => callbacks.connected(false), onReconnected: () => callbacks.connected(true), onError: () => { callbacks.connected(false); callbacks.failure(); } });
    const adapter: TextAdapter = {
      async send(senderId, text, messageId) {
        const result = await client.im.message.create({ params: { receive_id_type: "open_id" }, data: { receive_id: senderId, msg_type: "text", content: JSON.stringify({ text }), uuid: createHash("sha256").update(messageId).digest("hex").slice(0, 32) } });
        if (result.code !== 0) throw new Error("CHANNEL_SEND_FAILED");
      },
      stop() { socket.close({ force: true }); callbacks.connected(false); },
    };
    const dispatcher = new Lark.EventDispatcher({}).register({ "im.message.receive_v1": async (event) => {
      const message = channelInbound("feishu", event);
      if (message === undefined || signal.aborted || !callbacks.accepts(message.senderId)) return;
      try { const reply = await callbacks.inbound(message); if (reply !== undefined && !signal.aborted) for (const [index, chunk] of textChunks(reply).entries()) await adapter.send(message.senderId, chunk, `${message.messageId}-${index}`); } catch { callbacks.failure(); }
    } });
    signal.addEventListener("abort", () => adapter.stop(), { once: true });
    void socket.start({ eventDispatcher: dispatcher }).catch(() => { callbacks.connected(false); callbacks.failure(); });
    return adapter;
  }
  if (channel === "wecom") {
    const client = new WecomClient({ botId: credentials.botId as string, secret: credentials.secret as string, logger: silentLogger, maxReconnectAttempts: -1 });
    const adapter: TextAdapter = {
      async send(senderId, text) { await client.sendMessage(senderId, { msgtype: "markdown", markdown: { content: text } }); },
      stop() { client.disconnect(); callbacks.connected(false); },
    };
    client.on("authenticated", () => callbacks.connected(true));
    client.on("disconnected", () => callbacks.connected(false));
    client.on("error", () => { callbacks.connected(false); callbacks.failure(); });
    client.on("message.text", (frame) => { void (async () => {
      const message = channelInbound("wecom", frame);
      if (message === undefined || signal.aborted || !callbacks.accepts(message.senderId)) return;
      const streamId = randomUUID();
      await client.replyStream(frame, streamId, "正在处理…", false);
      const reply = await callbacks.inbound(message);
      const chunks = textChunks(reply ?? "已收到。");
      await client.replyStream(frame, streamId, chunks[0] as string, true);
      for (const chunk of chunks.slice(1)) await adapter.send(message.senderId, chunk, randomUUID());
    })().catch(() => callbacks.failure()); });
    signal.addEventListener("abort", () => adapter.stop(), { once: true });
    client.connect();
    return adapter;
  }
  return createSocketAdapter(channel, credentials, callbacks, signal);
}

export async function providerJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(20_000) });
  const raw = await response.text();
  if (!response.ok || Buffer.byteLength(raw) > 1024 * 1024) throw new Error("CHANNEL_PROVIDER_FAILED");
  const value = object(JSON.parse(raw));
  if (value === undefined) throw new Error("CHANNEL_PROVIDER_FAILED");
  return value;
}

export function createSocketAdapter(channel: "qq" | "cmcc", credentials: ChannelCredentials, callbacks: AdapterCallbacks, signal: AbortSignal, cmccEndpoint = "wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg", dependencies: { readonly requestJson?: typeof providerJson; readonly socketFactory?: (endpoint: string, options: WebSocket.ClientOptions) => WebSocket } = {}): TextAdapter {
  const requestJson = dependencies.requestJson ?? providerJson;
  let socket: WebSocket | undefined, ready = false, accessToken = "", tokenExpires = 0;
  let sequence: number | null = null, sessionId: string | undefined;
  let lastMessageId: string | undefined, replySequence = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let awaitingHeartbeat = false;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
  const sendFrame = async (value: unknown): Promise<void> => {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error("CHANNEL_OFFLINE");
    await new Promise<void>((resolvePromise, reject) => socket?.send(JSON.stringify(value), (error) => error == null ? resolvePromise() : reject(new Error("CHANNEL_SEND_FAILED"))));
  };
  const qqToken = async (): Promise<string> => {
    if (accessToken && tokenExpires > Date.now() + 60_000) return accessToken;
    const token = await requestJson("https://bots.qq.com/app/getAppAccessToken", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: credentials.appId, clientSecret: credentials.appSecret }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (typeof token.access_token !== "string" || !Number.isFinite(Number(token.expires_in))) throw new Error("CHANNEL_AUTH_FAILED");
    accessToken = token.access_token; tokenExpires = Date.now() + Number(token.expires_in) * 1000;
    return accessToken;
  };
  const adapter: TextAdapter = {
    async send(senderId, text, messageId) {
      if (!ready) throw new Error("CHANNEL_OFFLINE");
      if (channel === "cmcc") { await sendFrame({ type: "send", apiKey: credentials.apiKey, to: senderId, content: text, messageId: `msg_${messageId}` }); return; }
      const token = await qqToken();
      replySequence += 1;
      const result = await requestJson(`https://api.sgroup.qq.com/v2/users/${encodeURIComponent(senderId)}/messages`, {
        method: "POST", headers: { authorization: `QQBot ${token}`, "content-type": "application/json", "X-Union-Appid": credentials.appId as string },
        body: JSON.stringify({ content: text, msg_type: 0, ...(lastMessageId === undefined ? {} : { msg_id: lastMessageId, msg_seq: replySequence }) }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (result.code !== undefined && result.code !== 0) throw new Error("CHANNEL_SEND_FAILED");
    },
    stop() { clearInterval(heartbeat); clearTimeout(deadline); clearTimeout(heartbeatTimeout); socket?.terminate(); ready = false; callbacks.connected(false); },
  };
  const receive = async (event: unknown): Promise<void> => {
    const message = channelInbound(channel, event);
    if (message === undefined || signal.aborted || !callbacks.accepts(message.senderId)) return;
    if (channel === "qq") { lastMessageId = String(object(object(event)?.d)?.id); replySequence = 0; }
    const reply = await callbacks.inbound(message);
    if (reply !== undefined && !signal.aborted) for (const [index, chunk] of textChunks(reply).entries()) await adapter.send(message.senderId, chunk, `${message.messageId}-${index}`);
  };
  const connect = async (): Promise<void> => {
    let endpoint = cmccEndpoint;
    if (channel === "qq") {
      const token = await qqToken();
      const gateway = await requestJson("https://api.sgroup.qq.com/gateway", { headers: { authorization: `QQBot ${token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      if (typeof gateway.url !== "string" || !gateway.url.startsWith("wss://")) throw new Error("CHANNEL_GATEWAY_INVALID");
      const parsed = new URL(gateway.url);
      if (!parsed.hostname.endsWith(".qq.com") || parsed.username || parsed.password) throw new Error("CHANNEL_GATEWAY_INVALID");
      endpoint = gateway.url;
    }
    if (signal.aborted) return;
    await new Promise<void>((resolvePromise) => {
      const options = { ...(channel === "cmcc" ? { headers: { "X-API-Key": credentials.apiKey as string } } : {}), maxPayload: 1024 * 1024, handshakeTimeout: 10_000 };
      const connection = dependencies.socketFactory?.(endpoint, options) ?? new WebSocket(endpoint, options);
      socket = connection;
      deadline = setTimeout(() => connection.terminate(), 10_000);
      connection.on("open", () => { if (channel === "cmcc") void sendFrame({ type: "auth", apiKey: credentials.apiKey, version: "2.0" }).catch(() => connection.terminate()); });
      let inboundQueue = Promise.resolve();
      const startHeartbeat = (interval: number) => {
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          if (awaitingHeartbeat) { connection.terminate(); return; }
          awaitingHeartbeat = true;
          void sendFrame(channel === "cmcc" ? { type: "ping" } : { op: 1, d: sequence }).catch(() => connection.terminate());
          if (channel === "cmcc") heartbeatTimeout = setTimeout(() => connection.terminate(), 10_000);
        }, interval);
      };
      connection.on("message", (data) => {
        try {
          const value = object(JSON.parse(data.toString()));
          if (value === undefined) return;
          if (channel === "cmcc") {
            if (value.type === "auth_failed") { connection.terminate(); return; }
            if (value.type === "auth_ok") { clearTimeout(deadline); ready = true; callbacks.connected(true); startHeartbeat(15_000); }
            if (value.type === "pong") { awaitingHeartbeat = false; clearTimeout(heartbeatTimeout); }
          } else {
            if (typeof value.s === "number") sequence = value.s;
            if (value.op === 10) {
              const interval = Number(object(value.d)?.heartbeat_interval);
              if (!Number.isFinite(interval) || interval < 1000 || interval > 120_000) { connection.terminate(); return; }
              void sendFrame(sessionId === undefined ? { op: 2, d: { token: `QQBot ${accessToken}`, intents: 1 << 25, shard: [0, 1], properties: { os: "linux", browser: "friday", device: "friday" } } } : { op: 6, d: { token: `QQBot ${accessToken}`, session_id: sessionId, seq: sequence } }).catch(() => connection.terminate());
              startHeartbeat(interval);
            }
            if (value.op === 11) awaitingHeartbeat = false;
            if (value.op === 7 || value.op === 9) { if (value.op === 9) { sessionId = undefined; sequence = null; } connection.terminate(); return; }
            if (value.t === "READY" || value.t === "RESUMED") { clearTimeout(deadline); const id = object(value.d)?.session_id; if (typeof id === "string") sessionId = id; ready = true; callbacks.connected(true); }
          }
          if (ready) inboundQueue = inboundQueue.then(() => receive(value)).catch(() => callbacks.failure());
        } catch { callbacks.failure(); }
      });
      connection.on("error", () => connection.terminate());
      connection.once("close", () => { clearInterval(heartbeat); clearTimeout(deadline); clearTimeout(heartbeatTimeout); awaitingHeartbeat = false; ready = false; callbacks.connected(false); resolvePromise(); });
    });
  };
  signal.addEventListener("abort", () => adapter.stop(), { once: true });
  void (async () => {
    let delay = 3000;
    while (!signal.aborted) {
      try { await connect(); } catch { callbacks.failure(); }
      if (signal.aborted) return;
      await abortDelay(delay, signal);
      delay = Math.min(60_000, delay * 2);
    }
  })();
  return adapter;
}

export async function abortDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolvePromise(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
