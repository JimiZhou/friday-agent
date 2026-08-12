import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Channel = "telegram" | "wechat_ilink";

export interface GatewayConfig {
  readonly hubUrl: URL;
  readonly tokens: Readonly<Partial<Record<Channel, string>>>;
}

export interface Inbound {
  readonly channel: Channel;
  readonly messageId: string;
  readonly senderId: string;
  readonly group: boolean;
  readonly text: string;
  /** Provider-scoped reply context. It is never persisted by the Hub. */
  readonly contextToken?: string;
}

export interface HubInboundResponse {
  readonly accepted: true;
  readonly duplicate?: boolean;
  readonly reply?: string;
}

export interface HubChannelNotification {
  readonly notificationId: string;
  readonly channel: Channel;
  readonly senderId: string;
  readonly text: string;
  readonly leaseId: string;
}

/** Private iLink runtime settings. Credentials are kept in the gateway state directory. */
export interface IlinkConfig {
  readonly baseUrl: URL;
  readonly botToken?: string;
  readonly channelVersion: string;
  readonly appId: string;
  readonly appClientVersion: number;
  readonly cursorPath: string;
  readonly credentialsPath: string;
  readonly contextPath: string;
  readonly controlToken?: string;
  readonly controlPort: number;
}

interface IlinkCredentials {
  readonly botToken: string;
  readonly baseUrl: string;
  readonly accountId?: string;
  readonly userId?: string;
}

interface IlinkLogin {
  readonly loginId: string;
  qrcode: string;
  qrcodeUrl: string;
  status: IlinkQrStatus;
  readonly createdAt: number;
  currentBaseUrl: URL;
  verifyCode?: string;
  userId?: string;
  accountId?: string;
  error?: string;
}

type IlinkQrStatus = "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";

interface IlinkQrStatusResponse {
  readonly status?: IlinkQrStatus;
  readonly bot_token?: string;
  readonly ilink_bot_id?: string;
  readonly ilink_user_id?: string;
  readonly baseurl?: string;
  readonly redirect_host?: string;
}

const MAX_BODY_BYTES = 1_048_576;
const MAX_CURSOR_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const TELEGRAM_TEXT_LIMIT = 4_096;
const ILINK_LOGIN_TTL_MS = 5 * 60_000;
const ILINK_BOT_TYPE = "3";

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const url = parseTrustedUrl(env.FRIDAY_GATEWAY_HUB_URL, "FRIDAY_GATEWAY_HUB_URL");
  const token = (name: string): string | undefined => {
    const value = env[name];
    if (value === undefined) return undefined;
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error(`${name} must be a 32-byte base64url ingest token`);
    return value;
  };
  const telegram = token("FRIDAY_TELEGRAM_INGEST_TOKEN");
  const wechat = token("FRIDAY_WECHAT_ILINK_INGEST_TOKEN");
  return { hubUrl: url, tokens: { ...(telegram === undefined ? {} : { telegram }), ...(wechat === undefined ? {} : { wechat_ilink: wechat }) } };
}

/**
 * Loads iLink without requiring a pre-issued Bot Token. This permits the
 * loopback control API to complete QR pairing and atomically persist it.
 */
export function loadIlinkConfig(env: NodeJS.ProcessEnv = process.env): IlinkConfig | undefined {
  const base = env.FRIDAY_WECHAT_ILINK_BASE_URL;
  const stateDir = env.FRIDAY_GATEWAY_STATE_DIR;
  const botToken = emptyToUndefined(env.FRIDAY_WECHAT_ILINK_BOT_TOKEN);
  const controlToken = emptyToUndefined(env.FRIDAY_GATEWAY_CONTROL_TOKEN);
  if ([base, stateDir, botToken, controlToken].every((value) => value === undefined || value === "")) return undefined;
  if (base === undefined || base === "" || stateDir === undefined || stateDir === "") {
    throw new Error("WeChat iLink adapter requires base URL and gateway state directory");
  }
  const baseUrl = parseTrustedUrl(base, "FRIDAY_WECHAT_ILINK_BASE_URL");
  if (baseUrl.protocol !== "https:" && !isLoopback(baseUrl)) throw new Error("FRIDAY_WECHAT_ILINK_BASE_URL must be HTTPS or loopback");
  if (botToken !== undefined) requirePrivateToken(botToken, "FRIDAY_WECHAT_ILINK_BOT_TOKEN");
  if (controlToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(controlToken)) {
    throw new Error("FRIDAY_GATEWAY_CONTROL_TOKEN must be a 32-byte base64url token");
  }
  const channelVersion = env.FRIDAY_WECHAT_ILINK_CHANNEL_VERSION ?? "0.2.0";
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(channelVersion)) throw new Error("FRIDAY_WECHAT_ILINK_CHANNEL_VERSION is invalid");
  const appId = env.FRIDAY_WECHAT_ILINK_APP_ID ?? "bot";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(appId)) throw new Error("FRIDAY_WECHAT_ILINK_APP_ID is invalid");
  const appClientVersion = parsePositiveInteger(env.FRIDAY_WECHAT_ILINK_APP_CLIENT_VERSION, encodeClientVersion(channelVersion), "FRIDAY_WECHAT_ILINK_APP_CLIENT_VERSION", 0xffff_ffff);
  const controlPort = parsePositiveInteger(env.FRIDAY_GATEWAY_PORT, 4311, "FRIDAY_GATEWAY_PORT", 65_535);
  const directory = resolve(stateDir);
  return {
    baseUrl,
    ...(botToken === undefined ? {} : { botToken }),
    channelVersion,
    appId,
    appClientVersion,
    cursorPath: join(directory, "wechat-ilink-sync-buf"),
    credentialsPath: join(directory, "wechat-ilink-credentials.json"),
    contextPath: join(directory, "wechat-ilink-contexts.json"),
    ...(controlToken === undefined ? {} : { controlToken }),
    controlPort,
  };
}

export function telegramInbound(update: unknown): Inbound | undefined {
  const updateRecord = record(update), message = record(updateRecord?.message);
  if (!message || record(message.chat)?.type !== "private" || typeof message.text !== "string" || typeof record(message.from)?.id !== "number" || typeof message.message_id !== "number") return undefined;
  return { channel: "telegram", messageId: stableUuid(`telegram:${message.message_id}`), senderId: String(record(message.from)?.id), group: false, text: message.text };
}

/** Normalizes both the local fixture envelope and the official iLink payload. */
export function wechatIlinkInbound(event: unknown): Inbound | undefined {
  const value = record(event);
  if (value === undefined) return undefined;
  if (typeof value.message_id === "string" && typeof value.sender_id === "string" && typeof value.text === "string") {
    if (value.conversation_type !== "single") return undefined;
    return { channel: "wechat_ilink", messageId: stableUuid(`wechat:${value.message_id}`), senderId: value.sender_id, group: false, text: value.text };
  }
  if ((typeof value.message_id !== "number" && typeof value.message_id !== "string") || typeof value.from_user_id !== "string" || value.from_user_id.length === 0 || value.message_type !== 1) return undefined;
  if (typeof value.group_id === "string" && value.group_id.length > 0) return undefined;
  const items = value.item_list;
  if (!Array.isArray(items)) return undefined;
  const text = items.flatMap((item) => {
    const part = record(item), textItem = record(part?.text_item);
    return part?.type === 1 && typeof textItem?.text === "string" ? [textItem.text] : [];
  }).join("\n");
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > 64 * 1024) return undefined;
  const contextToken = typeof value.context_token === "string" && value.context_token.length <= 16 * 1024 && !value.context_token.includes("\0") ? value.context_token : undefined;
  return { channel: "wechat_ilink", messageId: stableUuid(`wechat:${value.message_id}`), senderId: value.from_user_id, group: false, text, ...(contextToken === undefined ? {} : { contextToken }) };
}

export async function forwardInbound(config: GatewayConfig, inbound: Inbound): Promise<HubInboundResponse> {
  const token = config.tokens[inbound.channel];
  if (token === undefined) throw new Error(`${inbound.channel} adapter is disabled: no ingest credential`);
  const response = await fetch(new URL("/v2/inbound", config.hubUrl), {
    method: "POST", redirect: "error", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...inbound, token }), signal: AbortSignal.timeout(210_000),
  });
  const value = await boundedJson(response, "Hub inbound");
  if (!response.ok) throw new Error(`Hub rejected ${inbound.channel} inbound (${response.status})`);
  const body = record(value);
  if (body?.accepted !== true || (body.reply !== undefined && typeof body.reply !== "string")) throw new Error("Hub inbound response is invalid");
  return { accepted: true, ...(body.duplicate === true ? { duplicate: true } : {}), ...(typeof body.reply === "string" ? { reply: body.reply } : {}) };
}

export async function pullChannelNotification(config: GatewayConfig, channel: Channel): Promise<HubChannelNotification | undefined> {
  const token = config.tokens[channel];
  if (token === undefined) throw new Error(`${channel} adapter is disabled: no ingest credential`);
  const response = await fetch(new URL(`/v2/channels/${channel}/outbox`, config.hubUrl), {
    method: "GET", redirect: "error", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
  });
  const value = record(await boundedJson(response, "Hub channel outbox"));
  if (!response.ok) throw new Error(`Hub rejected ${channel} outbox pull (${response.status})`);
  if (value?.notification === null) return undefined;
  const notification = record(value?.notification);
  if (
    typeof notification?.notificationId !== "string" || typeof notification.leaseId !== "string" ||
    notification.channel !== channel || typeof notification.senderId !== "string" || typeof notification.text !== "string"
  ) throw new Error("Hub channel outbox response is invalid");
  return notification as unknown as HubChannelNotification;
}

export async function acknowledgeChannelNotification(config: GatewayConfig, notification: HubChannelNotification): Promise<void> {
  const token = config.tokens[notification.channel];
  if (token === undefined) throw new Error(`${notification.channel} adapter is disabled: no ingest credential`);
  const endpoint = new URL(`/v2/channels/${notification.channel}/outbox/${notification.notificationId}/ack`, config.hubUrl);
  const response = await fetch(endpoint, {
    method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ leaseId: notification.leaseId }), signal: AbortSignal.timeout(20_000),
  });
  const value = record(await boundedJson(response, "Hub channel outbox acknowledgement"));
  if (!response.ok || value?.delivered !== true) throw new Error(`Hub rejected ${notification.channel} outbox acknowledgement (${response.status})`);
}

/** Starts only when both a Telegram bot token and Hub-scoped ingest token are configured. */
export async function telegramLongPoll(config: GatewayConfig, botToken: string, signal: AbortSignal): Promise<void> {
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(botToken) || config.tokens.telegram === undefined) throw new Error("Telegram adapter is disabled or invalid");
  let offset = 0;
  while (!signal.aborted) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?timeout=25&offset=${offset}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: "error" });
    if (!response.ok) throw new Error(`Telegram polling failed (${response.status})`);
    const body = record(await response.json()), updates = body?.result;
    if (!Array.isArray(updates)) throw new Error("Telegram response is invalid");
    for (const update of updates) {
      const recordUpdate = record(update);
      if (typeof recordUpdate?.update_id !== "number") continue;
      offset = Math.max(offset, recordUpdate.update_id + 1);
      const inbound = telegramInbound(recordUpdate);
      if (inbound !== undefined) {
        const accepted = await forwardInbound(config, inbound);
        if (accepted.reply !== undefined) await sendTelegramText(botToken, inbound, accepted.reply, signal);
      }
    }
  }
}

/** Sends a plain-text Friday reply to the same private Telegram chat. */
export async function sendTelegramText(botToken: string, inbound: Inbound, text: string, signal: AbortSignal, apiBase = new URL("https://api.telegram.org/")): Promise<void> {
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(botToken) || inbound.channel !== "telegram" || !/^\d+$/.test(inbound.senderId)) throw new Error("Telegram reply context is invalid");
  const chunks = telegramTextChunks(text);
  for (const chunk of chunks) {
    const endpoint = new URL(`./bot${botToken}/sendMessage`, ensureTrailingSlash(apiBase));
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: inbound.senderId, text: chunk }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const value = record(await boundedJson(response, "Telegram sendMessage"));
    if (!response.ok || value?.ok !== true) throw new Error(`Telegram sendMessage failed (${response.status})`);
  }
}

function telegramTextChunks(text: string): readonly string[] {
  const characters = Array.from(text.trim());
  if (characters.length === 0 || Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("Telegram reply text is invalid");
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += TELEGRAM_TEXT_LIMIT) chunks.push(characters.slice(index, index + TELEGRAM_TEXT_LIMIT).join(""));
  return chunks;
}

export interface IlinkPollResult { readonly nextCursor: string; readonly messages: readonly Inbound[]; }

/** One official iLink getupdates request, exported for deterministic contract tests. */
export async function pollIlinkOnce(config: IlinkConfig, cursor: string, signal: AbortSignal, credentials?: IlinkCredentials): Promise<IlinkPollResult> {
  if (Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) throw new Error("iLink cursor is too large");
  const auth = credentials ?? await readIlinkCredentials(config);
  if (auth === undefined) throw new Error("iLink is not paired");
  const body = JSON.stringify({ get_updates_buf: cursor, base_info: baseInfo(config) });
  const endpoint = new URL("ilink/bot/getupdates", ensureTrailingSlash(new URL(auth.baseUrl)));
  const response = await fetch(endpoint, {
    method: "POST", redirect: "error", headers: ilinkHeaders(config, auth.botToken), body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
  });
  if (!response.ok) throw new Error(`iLink polling failed (${response.status})`);
  const result = record(await boundedJson(response, "iLink polling"));
  if (result === undefined || (result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) throw new Error("iLink polling was rejected");
  const nextCursor = typeof result.get_updates_buf === "string" ? result.get_updates_buf : cursor;
  if (Buffer.byteLength(nextCursor, "utf8") > MAX_CURSOR_BYTES) throw new Error("iLink cursor is too large");
  const messages = Array.isArray(result.msgs) ? result.msgs.flatMap((message) => {
    const inbound = wechatIlinkInbound(message); return inbound === undefined ? [] : [inbound];
  }) : [];
  return { nextCursor, messages };
}

/** Sends the Friday reply through the official iLink sendmessage contract. */
export async function sendIlinkText(config: IlinkConfig, credentials: IlinkCredentials, inbound: Inbound, text: string, signal: AbortSignal, clientId = `friday-${inbound.messageId}`): Promise<void> {
  if (text.trim() === "" || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error("iLink reply is invalid");
  const endpoint = new URL("ilink/bot/sendmessage", ensureTrailingSlash(new URL(credentials.baseUrl)));
  const body = JSON.stringify({
    msg: {
      from_user_id: "", to_user_id: inbound.senderId, client_id: clientId,
      message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      ...(inbound.contextToken === undefined ? {} : { context_token: inbound.contextToken }),
    },
    base_info: baseInfo(config),
  });
  const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: ilinkHeaders(config, credentials.botToken), body, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  const value = record(await boundedJson(response, "iLink sendmessage"));
  if (value === undefined) throw new Error(`iLink sendmessage returned an invalid response (http=${response.status})`);
  const ret = value.ret === undefined ? 0 : typeof value.ret === "number" ? value.ret : Number.NaN;
  const errcode = value.errcode === undefined ? 0 : typeof value.errcode === "number" ? value.errcode : Number.NaN;
  if (!response.ok || ret !== 0 || errcode !== 0) throw new Error(`iLink sendmessage failed (http=${response.status}, ret=${ret}, errcode=${errcode})`);
}

/** Long-polls iLink, invokes Friday Conversation, sends the reply, then advances the cursor. */
export async function wechatIlinkLongPoll(config: GatewayConfig, ilink: IlinkConfig, signal: AbortSignal): Promise<void> {
  if (config.tokens.wechat_ilink === undefined) throw new Error("wechat_ilink adapter is disabled: no ingest credential");
  let cursor = await readIlinkCursor(ilink.cursorPath);
  while (!signal.aborted) {
    const credentials = await readIlinkCredentials(ilink);
    if (credentials === undefined) { await abortableDelay(2_000, signal); continue; }
    try {
      const result = await pollIlinkOnce(ilink, cursor, signal, credentials);
      for (const message of result.messages) {
        const accepted = await forwardInbound(config, message);
        // Hub acceptance proves this is the paired Owner, so an unpaired sender
        // can never replace the private context used for later notifications.
        if (message.contextToken !== undefined) await writeIlinkContext(ilink.contextPath, message.senderId, message.contextToken);
        if (accepted.reply !== undefined) await sendIlinkText(ilink, credentials, message, accepted.reply, signal);
      }
      if (result.nextCursor !== cursor) await writeIlinkCursor(ilink.cursorPath, result.nextCursor);
      cursor = result.nextCursor;
    } catch (caught) {
      if (signal.aborted) return;
      process.stderr.write(`[gateway] iLink cycle failed: ${safeError(caught)}\n`);
      await abortableDelay(5_000, signal);
    }
  }
}

export async function channelOutboxLoop(config: GatewayConfig, channel: Channel, signal: AbortSignal, deliver: (notification: HubChannelNotification) => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    try {
      const notification = await pullChannelNotification(config, channel);
      if (notification === undefined) { await abortableDelay(2_000, signal); continue; }
      await deliver(notification);
      await acknowledgeChannelNotification(config, notification);
    } catch (caught) {
      if (signal.aborted) return;
      process.stderr.write(`[gateway] ${channel} outbox delivery failed: ${safeError(caught)}\n`);
      await abortableDelay(5_000, signal);
    }
  }
}

export async function deliverIlinkNotification(config: IlinkConfig, notification: HubChannelNotification, signal: AbortSignal): Promise<void> {
  const credentials = await readIlinkCredentials(config);
  if (credentials === undefined) throw new Error("iLink is not paired");
  const contextToken = await readIlinkContext(config.contextPath, notification.senderId);
  await sendIlinkText(config, credentials, {
    channel: "wechat_ilink", messageId: notification.notificationId, senderId: notification.senderId,
    group: false, text: notification.text,
    // The official provider accepts notifications to the paired Owner without
    // context. Prefer a fresh reply context when one has been observed, but do
    // not strand durable results after an upgrade from a version that did not
    // persist it.
    ...(contextToken === undefined ? {} : { contextToken }),
  }, notification.text, signal, `friday-${notification.notificationId}`);
}

/** Loopback-only QR control server. The Hub proxies this behind Owner authentication. */
export async function startIlinkControlServer(config: IlinkConfig, signal: AbortSignal): Promise<{ readonly port: number; stop(): Promise<void> }> {
  if (config.controlToken === undefined) throw new Error("FRIDAY_GATEWAY_CONTROL_TOKEN is required for the iLink control server");
  const logins = new Map<string, IlinkLogin>();
  const loginControllers = new Map<string, AbortController>();
  const server = createServer((request, response) => void handleIlinkControlRequest(config, logins, loginControllers, request, response).catch((caught) => {
    process.stderr.write(`[gateway] iLink control request failed: ${safeError(caught)}\n`);
    if (!response.headersSent) controlJson(response, 500, { error: { code: "ILINK_CONTROL_FAILED", message: "iLink control operation failed" } });
    else response.end();
  }));
  signal.addEventListener("abort", () => {
    for (const controller of loginControllers.values()) controller.abort();
    server.close();
  }, { once: true });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(config.controlPort, "127.0.0.1", resolvePromise);
  });
  return {
    port: config.controlPort,
    stop: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error))),
  };
}

async function handleIlinkControlRequest(config: IlinkConfig, logins: Map<string, IlinkLogin>, controllers: Map<string, AbortController>, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!bearerMatches(config.controlToken as string, request.headers.authorization)) { controlJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Gateway control token required" } }); return; }
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (method === "GET" && url.pathname === "/v1/wechat-ilink/status") {
    const credentials = await readIlinkCredentials(config);
    controlJson(response, 200, credentials === undefined ? { connected: false } : { connected: true, accountId: credentials.accountId, userId: credentials.userId, baseUrl: credentials.baseUrl });
    return;
  }
  if (method === "POST" && url.pathname === "/v1/wechat-ilink/login") {
    await requireEmptyJson(request);
    for (const controller of controllers.values()) controller.abort();
    logins.clear(); controllers.clear();
    const qr = await fetchIlinkQr(config);
    const login: IlinkLogin = { loginId: randomUUID(), qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl, status: "wait", createdAt: Date.now(), currentBaseUrl: config.baseUrl };
    const controller = new AbortController();
    logins.set(login.loginId, login); controllers.set(login.loginId, controller);
    void driveIlinkLogin(config, login, controller.signal).finally(() => controllers.delete(login.loginId));
    controlJson(response, 201, publicLogin(login));
    return;
  }
  const statusMatch = url.pathname.match(/^\/v1\/wechat-ilink\/login\/([0-9a-f-]+)$/i);
  if (method === "GET" && statusMatch?.[1] !== undefined) {
    const login = logins.get(statusMatch[1]);
    if (login === undefined) { controlJson(response, 404, { error: { code: "LOGIN_NOT_FOUND", message: "iLink login is unavailable" } }); return; }
    controlJson(response, 200, publicLogin(login));
    return;
  }
  const verifyMatch = url.pathname.match(/^\/v1\/wechat-ilink\/login\/([0-9a-f-]+)\/verify$/i);
  if (method === "POST" && verifyMatch?.[1] !== undefined) {
    const login = logins.get(verifyMatch[1]);
    if (login === undefined) { controlJson(response, 404, { error: { code: "LOGIN_NOT_FOUND", message: "iLink login is unavailable" } }); return; }
    const body = record(await readSmallJson(request));
    if (typeof body?.code !== "string" || !/^\d{1,12}$/.test(body.code)) { controlJson(response, 400, { error: { code: "INVALID_VERIFY_CODE", message: "A numeric verification code is required" } }); return; }
    login.verifyCode = body.code;
    controlJson(response, 202, publicLogin(login));
    return;
  }
  controlJson(response, 404, { error: { code: "NOT_FOUND", message: "No gateway control route matches" } });
}

async function fetchIlinkQr(config: IlinkConfig): Promise<{ readonly qrcode: string; readonly qrcodeUrl: string }> {
  const credentials = await readIlinkCredentials(config);
  const endpoint = new URL(`ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`, ensureTrailingSlash(config.baseUrl));
  const response = await fetch(endpoint, {
    method: "POST", redirect: "error", headers: ilinkHeaders(config),
    body: JSON.stringify({ local_token_list: credentials === undefined ? [] : [credentials.botToken] }),
    signal: AbortSignal.timeout(20_000),
  });
  const value = record(await boundedJson(response, "iLink QR"));
  if (!response.ok || typeof value?.qrcode !== "string" || typeof value.qrcode_img_content !== "string" || value.qrcode.length > 16 * 1024 || value.qrcode_img_content.length > 16 * 1024) throw new Error(`iLink QR request failed (${response.status})`);
  return { qrcode: value.qrcode, qrcodeUrl: value.qrcode_img_content };
}

async function driveIlinkLogin(config: IlinkConfig, login: IlinkLogin, signal: AbortSignal): Promise<void> {
  while (!signal.aborted && Date.now() - login.createdAt < ILINK_LOGIN_TTL_MS) {
    try {
      const endpoint = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}${login.verifyCode === undefined ? "" : `&verify_code=${encodeURIComponent(login.verifyCode)}`}`, ensureTrailingSlash(login.currentBaseUrl));
      const response = await fetch(endpoint, { method: "GET", redirect: "error", headers: ilinkCommonHeaders(config), signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]) });
      const value = record(await boundedJson(response, "iLink QR status")) as IlinkQrStatusResponse | undefined;
      if (!response.ok || value === undefined || typeof value.status !== "string") throw new Error(`iLink QR status failed (${response.status})`);
      if (value.status === "scaned" && login.verifyCode !== undefined) delete login.verifyCode;
      if (value.status === "scaned_but_redirect" && value.redirect_host !== undefined) login.currentBaseUrl = parseProviderUrl(`https://${value.redirect_host}`);
      if (value.status === "confirmed") {
        if (value.bot_token === undefined || value.ilink_bot_id === undefined || value.ilink_user_id === undefined) throw new Error("iLink confirmation omitted required credentials");
        const providerBaseUrl = value.baseurl === undefined ? login.currentBaseUrl : parseProviderUrl(value.baseurl);
        await writeIlinkCredentials(config.credentialsPath, { botToken: value.bot_token, baseUrl: providerBaseUrl.toString(), accountId: value.ilink_bot_id, userId: value.ilink_user_id });
        login.accountId = value.ilink_bot_id; login.userId = value.ilink_user_id;
        login.status = "confirmed";
        return;
      }
      login.status = value.status;
      if (value.status === "expired" || value.status === "verify_code_blocked" || value.status === "binded_redirect") return;
    } catch (caught) {
      if (signal.aborted) return;
      login.error = safeError(caught);
      await abortableDelay(2_000, signal);
    }
  }
  if (!signal.aborted && login.status !== "confirmed") login.status = "expired";
}

function publicLogin(login: IlinkLogin): Record<string, unknown> {
  return {
    loginId: login.loginId, qrcodeUrl: login.qrcodeUrl, status: login.status,
    expiresAt: new Date(login.createdAt + ILINK_LOGIN_TTL_MS).toISOString(),
    ...(login.userId === undefined ? {} : { userId: login.userId }),
    ...(login.accountId === undefined ? {} : { accountId: login.accountId }),
    ...(login.error === undefined ? {} : { error: login.error }),
  };
}

export function startFixtureGateway(config: GatewayConfig, port = 0): Promise<{ port: number; stop(): Promise<void> }> {
  const server = createServer((request, response) => void (async () => {
    if (request.method !== "POST" || !request.url?.startsWith("/fixture/")) { response.writeHead(404).end(); return; }
    const channel = request.url.endsWith("telegram") ? "telegram" : request.url.endsWith("wechat_ilink") ? "wechat_ilink" : undefined;
    if (channel === undefined) { response.writeHead(404).end(); return; }
    let raw = "";
    for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) { response.writeHead(413).end(); return; } }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
    const inbound = channel === "telegram" ? telegramInbound(value) : wechatIlinkInbound(value);
    if (inbound === undefined) { response.writeHead(202).end(); return; }
    try { await forwardInbound(config, inbound); response.writeHead(202).end(); } catch { response.writeHead(503).end(); }
  })());
  return new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") { reject(new Error("Gateway bind failed")); return; } resolvePromise({ port: address.port, stop: () => new Promise((resolveStop, rejectStop) => server.close((error) => error === undefined ? resolveStop() : rejectStop(error))) }); }); });
}

function parseTrustedUrl(value: string | undefined, name: string): URL {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new Error(`${name} must be HTTPS or loopback`); }
  if ((url.protocol !== "https:" && !isLoopback(url)) || url.username !== "" || url.password !== "") throw new Error(`${name} must be HTTPS or loopback`);
  return url;
}

function parseProviderUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("iLink returned an invalid provider URL"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("iLink returned an invalid provider URL");
  return url;
}

function ilinkCommonHeaders(config: IlinkConfig): Record<string, string> {
  return { "iLink-App-Id": config.appId, "iLink-App-ClientVersion": String(config.appClientVersion) };
}

function ilinkHeaders(config: IlinkConfig, botToken?: string): Record<string, string> {
  return {
    "content-type": "application/json", AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": randomWechatUin(), ...ilinkCommonHeaders(config),
    ...(botToken === undefined ? {} : { authorization: `Bearer ${botToken}` }),
  };
}

function baseInfo(config: IlinkConfig): Record<string, string> { return { channel_version: config.channelVersion, bot_agent: "FridayAgent/0.2.0" }; }
function randomWechatUin(): string { return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"); }
function ensureTrailingSlash(url: URL): string { return url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`; }
function isLoopback(url: URL): boolean { return url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost"; }

async function readIlinkCredentials(config: IlinkConfig): Promise<IlinkCredentials | undefined> {
  if (config.botToken !== undefined) return { botToken: config.botToken, baseUrl: config.baseUrl.toString() };
  try {
    const raw = await readFile(config.credentialsPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) throw new Error("iLink credentials file is too large");
    const value = record(JSON.parse(raw));
    if (typeof value?.botToken !== "string" || typeof value.baseUrl !== "string") throw new Error("iLink credentials file is invalid");
    requirePrivateToken(value.botToken, "iLink Bot Token");
    const baseUrl = parseProviderUrl(value.baseUrl).toString();
    const accountId = typeof value.accountId === "string" && value.accountId.length <= 256 ? value.accountId : undefined;
    const userId = typeof value.userId === "string" && value.userId.length <= 256 ? value.userId : undefined;
    return { botToken: value.botToken, baseUrl, ...(accountId === undefined ? {} : { accountId }), ...(userId === undefined ? {} : { userId }) };
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw caught;
  }
}

async function writeIlinkCredentials(path: string, credentials: IlinkCredentials): Promise<void> {
  requirePrivateToken(credentials.botToken, "iLink Bot Token");
  parseProviderUrl(credentials.baseUrl);
  await atomicPrivateWrite(path, JSON.stringify(credentials));
}

async function readIlinkCursor(path: string): Promise<string> {
  try { const value = await readFile(path, "utf8"); if (Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES) throw new Error("iLink cursor is too large"); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

async function writeIlinkCursor(path: string, value: string): Promise<void> { await atomicPrivateWrite(path, value); }

async function readIlinkContext(path: string, senderId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("iLink context file is too large");
    const contexts = record(JSON.parse(raw));
    const context = contexts?.[senderId];
    return typeof context === "string" && context.length <= 16 * 1024 && !context.includes("\0") ? context : undefined;
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw caught;
  }
}

async function writeIlinkContext(path: string, senderId: string, contextToken: string): Promise<void> {
  if (senderId.trim() === "" || senderId.length > 256 || contextToken.length > 16 * 1024 || contextToken.includes("\0")) throw new Error("iLink reply context is invalid");
  let contexts: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("iLink context file is too large");
    contexts = record(JSON.parse(raw)) ?? {};
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw caught;
  }
  await atomicPrivateWrite(path, JSON.stringify({ ...contexts, [senderId]: contextToken }));
}

async function atomicPrivateWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try { await writeFile(temporary, value, { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

async function boundedJson(response: Response, label: string): Promise<unknown> {
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error(`${label} response is too large`);
  try { return JSON.parse(raw) as unknown; } catch { throw new Error(`${label} response is invalid`); }
}

async function readSmallJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > 16 * 1024) throw new Error("Control request is too large"); chunks.push(bytes); }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function requireEmptyJson(request: IncomingMessage): Promise<void> { const body = record(await readSmallJson(request)); if (body === undefined || Object.keys(body).length !== 0) throw new Error("Body must be an empty JSON object"); }

function controlJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(body);
}

function bearerMatches(expected: string, header: string | undefined): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const actual = header.slice(7), left = Buffer.from(expected), right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requirePrivateToken(value: string, name: string): void { if (value.length < 20 || value.length > 4096 || /[\r\n]/.test(value)) throw new Error(`${name} is invalid`); }
function emptyToUndefined(value: string | undefined): string | undefined { return value === undefined || value === "" ? undefined : value; }
function encodeClientVersion(version: string): number { const [major = 0, minor = 0, patch = 0] = version.split(".").map((item) => Number.parseInt(item, 10) || 0); return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff); }
function parsePositiveInteger(value: string | undefined, fallback: number, name: string, max: number): number { if (value === undefined || value === "") return fallback; if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`); const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${name} is out of range`); return parsed; }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function stableUuid(value: string): string { const hash = createHash("sha256").update(value).digest("hex"); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`; }
function safeError(value: unknown): string { const message = value instanceof Error ? value.message : String(value); return message.replace(/[\r\n]/g, " ").slice(0, 512); }
async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> { if (signal.aborted) return; await new Promise<void>((resolvePromise) => { const timer = setTimeout(resolvePromise, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolvePromise(); }, { once: true }); }); }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const config = loadGatewayConfig(), ilink = loadIlinkConfig();
  const telegramBot = process.env.FRIDAY_TELEGRAM_BOT_TOKEN;
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
  const adapters: Promise<unknown>[] = [];
  if (telegramBot !== undefined && config.tokens.telegram !== undefined) {
    adapters.push(telegramLongPoll(config, telegramBot, controller.signal));
    adapters.push(channelOutboxLoop(config, "telegram", controller.signal, (notification) => sendTelegramText(telegramBot, { channel: "telegram", messageId: notification.notificationId, senderId: notification.senderId, group: false, text: notification.text }, notification.text, controller.signal)));
  }
  if (ilink !== undefined && config.tokens.wechat_ilink !== undefined) {
    adapters.push(wechatIlinkLongPoll(config, ilink, controller.signal));
    adapters.push(channelOutboxLoop(config, "wechat_ilink", controller.signal, (notification) => deliverIlinkNotification(ilink, notification, controller.signal)));
  }
  if (ilink?.controlToken !== undefined) adapters.push(startIlinkControlServer(ilink, controller.signal));
  if (adapters.length === 0) process.stdout.write("channel gateway disabled: incomplete provider credentials\n");
  else await Promise.all(adapters);
}
