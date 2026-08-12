import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFridayServer } from "../apps/fridayd/dist/server.js";
import { acknowledgeChannelNotification, deliverIlinkNotification, loadIlinkConfig, pollIlinkOnce, pullChannelNotification, sendIlinkText, sendTelegramText, startIlinkControlServer, telegramInbound, wechatIlinkInbound } from "../apps/channel-gateway/dist/index.js";

test("M2 Hub accepts only paired channel ingress and durable replay rejection", async (t) => {
  const stateDir=await mkdtemp(join(tmpdir(),"m2-hub-"));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const ownerToken="m2-owner-token-is-long-enough";const server=await createFridayServer({host:"127.0.0.1",port:0,stateDir,ownerId:"owner",ownerToken,maxBodyBytes:1_048_576});const address=await server.start();t.after(()=>server.stop());const base=`http://${address.host}:${address.port}`;
  const owner={authorization:`Bearer ${ownerToken}`,"content-type":"application/json"};
  const rotate=await fetch(`${base}/v2/channels/rotate`,{method:"POST",headers:owner,body:JSON.stringify({channel:"telegram"})});const {token}=await rotate.json();assert.equal(typeof token,"string");
  assert.equal((await fetch(`${base}/v2/inbound`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({channel:"telegram",token,senderId:"owner",messageId:randomUUID(),group:false,text:"before pairing"})})).status,401);
  assert.equal((await fetch(`${base}/v2/channels/pair`,{method:"POST",headers:owner,body:JSON.stringify({channel:"telegram",senderId:"owner"})})).status,200);
  const messageId=randomUUID();const body=JSON.stringify({channel:"telegram",token,senderId:"owner",messageId,group:false,text:"hello"});assert.equal((await fetch(`${base}/v2/inbound`,{method:"POST",headers:{"content-type":"application/json"},body})).status,202);const replay=await fetch(`${base}/v2/inbound`,{method:"POST",headers:{"content-type":"application/json"},body});assert.equal(replay.status,202);assert.equal((await replay.json()).duplicate,true);
  const notificationJob=server.jobRegistry.create({idempotencyKey:randomUUID(),runnerId:randomUUID(),workspaceId:"infra",tool:"agent",operation:"diagnose",prompt:"inspect"}).job;server.channelOutbox.bindJob(notificationJob.jobId,"telegram","owner");assert.equal(server.channelOutbox.enqueueTerminal(notificationJob.jobId,"任务已完成。"),true);
  assert.equal((await fetch(`${base}/v2/channels/telegram/outbox`)).status,401);
  const delivery=await fetch(`${base}/v2/channels/telegram/outbox`,{headers:{authorization:`Bearer ${token}`}});assert.equal(delivery.status,200);const deliveryBody=await delivery.json();assert.equal(deliveryBody.notification.text,"任务已完成。");
  const badAck=await fetch(`${base}/v2/channels/telegram/outbox/${deliveryBody.notification.notificationId}/ack`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({leaseId:randomUUID()})});assert.equal(badAck.status,409);
  const ack=await fetch(`${base}/v2/channels/telegram/outbox/${deliveryBody.notification.notificationId}/ack`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({leaseId:deliveryBody.notification.leaseId})});assert.equal(ack.status,200);assert.equal((await ack.json()).delivered,true);
});
test("Telegram and iLink provider fixtures normalize only direct messages", () => {
  assert.equal(telegramInbound({ message: { message_id: 7, text: "hi", chat: { type: "private" }, from: { id: 12 } } })?.channel, "telegram");
  assert.equal(telegramInbound({ message: { message_id: 7, text: "hi", chat: { type: "group" }, from: { id: 12 } } }), undefined);
  assert.equal(wechatIlinkInbound({ message_id: "x", sender_id: "owner", conversation_type: "single", text: "hi" })?.channel, "wechat_ilink");
  assert.equal(wechatIlinkInbound({ message_id: "x", sender_id: "owner", conversation_type: "group", text: "hi" }), undefined);
  assert.equal(wechatIlinkInbound({ message_id: 7, from_user_id: "owner", message_type: 1, item_list: [{ type: 1, text_item: { text: "official protocol" } }] })?.text, "official protocol");
  assert.equal(wechatIlinkInbound({ message_id: 8, from_user_id: "owner", group_id: "group", message_type: 1, item_list: [{ type: 1, text_item: { text: "never accept" } }] }), undefined);
});

test("Telegram replies use plain sendMessage chunks addressed only to the paired private sender", async (t) => {
  const requests = [];
  const provider = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, body: JSON.parse(raw) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result: { message_id: requests.length } }));
    });
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => provider.close((error) => error === undefined ? resolve() : reject(error))));
  const address = provider.address(); const port = typeof address === "object" && address !== null ? address.port : 0;
  const inbound = telegramInbound({ message: { message_id: 7, text: "hi", chat: { type: "private" }, from: { id: 123456789 } } });
  await sendTelegramText("123456:abcdefghijklmnopqrst", inbound, "x".repeat(4_100), AbortSignal.timeout(1_000), new URL(`http://127.0.0.1:${port}/`));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "/bot123456:abcdefghijklmnopqrst/sendMessage");
  assert.deepEqual(requests.map((item) => item.body.chat_id), ["123456789", "123456789"]);
  assert.deepEqual(requests.map((item) => item.body.text.length), [4_096, 4]);
});

test("iLink adapter uses the official getupdates contract and is disabled without complete private config", async (t) => {
  assert.equal(loadIlinkConfig({}), undefined);
  assert.throws(() => loadIlinkConfig({ FRIDAY_WECHAT_ILINK_BASE_URL: "https://ilinkai.weixin.qq.com" }), /requires/);
  let requestBody; let authorizationType; let authorization; let appId; let appClientVersion;
  const provider = createServer((request, response) => {
    authorizationType = request.headers.authorizationtype; authorization = request.headers.authorization;
    appId = request.headers["ilink-app-id"]; appClientVersion = request.headers["ilink-app-clientversion"];
    let raw = ""; request.on("data", (chunk) => { raw += chunk; }); request.on("end", () => {
      requestBody = JSON.parse(raw);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ret: 0, get_updates_buf: "next-cursor", msgs: [{ message_id: 19, from_user_id: "owner", message_type: 1, item_list: [{ type: 1, text_item: { text: "from ilink" } }] }, { message_id: 20, from_user_id: "owner", group_id: "not-a-dm", message_type: 1, item_list: [{ type: 1, text_item: { text: "drop" } }] }] }));
    });
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => provider.close((error) => error === undefined ? resolve() : reject(error))));
  const address = provider.address(); const port = typeof address === "object" && address !== null ? address.port : 0;
  const stateDir = await mkdtemp(join(tmpdir(), "m2-ilink-")); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const config = loadIlinkConfig({ FRIDAY_WECHAT_ILINK_BASE_URL: `http://127.0.0.1:${port}/`, FRIDAY_WECHAT_ILINK_BOT_TOKEN: "private-ilink-token-value", FRIDAY_GATEWAY_STATE_DIR: stateDir });
  const result = await pollIlinkOnce(config, "prior-cursor", AbortSignal.timeout(1_000));
  assert.deepEqual(requestBody, { get_updates_buf: "prior-cursor", base_info: { channel_version: "0.2.0", bot_agent: "FridayAgent/0.2.0" } });
  assert.equal(authorizationType, "ilink_bot_token"); assert.equal(authorization, "Bearer private-ilink-token-value");
  assert.equal(appId, "bot"); assert.equal(appClientVersion, "512");
  assert.deepEqual(result, { nextCursor: "next-cursor", messages: [{ channel: "wechat_ilink", messageId: result.messages[0].messageId, senderId: "owner", group: false, text: "from ilink" }] });
});

test("iLink sendmessage preserves the provider reply context and QR control persists credentials privately", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "m2-ilink-control-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let sentBody;
  const provider = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url?.startsWith("/ilink/bot/get_bot_qrcode")) {
      request.resume(); request.on("end", () => response.end(JSON.stringify({ qrcode: "private-qr-handle", qrcode_img_content: "https://example.test/wechat-pair" })));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/ilink/bot/get_qrcode_status")) {
      response.end(JSON.stringify({ status: "confirmed", bot_token: "private-confirmed-ilink-token", ilink_bot_id: "bot-1", ilink_user_id: "owner-wechat", baseurl: "https://ilinkai.weixin.qq.com/" }));
      return;
    }
    if (request.method === "POST" && request.url === "/ilink/bot/sendmessage") {
      let raw = ""; request.on("data", (chunk) => { raw += chunk; }); request.on("end", () => { sentBody = JSON.parse(raw); response.end(JSON.stringify({ ret: 0 })); });
      return;
    }
    response.writeHead(404).end(JSON.stringify({ ret: 1 }));
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => provider.close((error) => error === undefined ? resolve() : reject(error))));
  const providerAddress = provider.address(); const providerPort = typeof providerAddress === "object" && providerAddress !== null ? providerAddress.port : 0;

  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const probeAddress = probe.address(); const controlPort = typeof probeAddress === "object" && probeAddress !== null ? probeAddress.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => error === undefined ? resolve() : reject(error)));
  const controlToken = "C".repeat(43);
  const config = loadIlinkConfig({ FRIDAY_WECHAT_ILINK_BASE_URL: `http://127.0.0.1:${providerPort}/`, FRIDAY_GATEWAY_STATE_DIR: stateDir, FRIDAY_GATEWAY_CONTROL_TOKEN: controlToken, FRIDAY_GATEWAY_PORT: String(controlPort) });
  const controller = new AbortController();
  const control = await startIlinkControlServer(config, controller.signal);
  t.after(async () => { controller.abort(); await control.stop().catch(() => undefined); });
  const headers = { authorization: `Bearer ${controlToken}`, "content-type": "application/json" };
  const start = await fetch(`http://127.0.0.1:${control.port}/v1/wechat-ilink/login`, { method: "POST", headers, body: "{}" });
  const login = await start.json();
  assert.equal(start.status, 201); assert.equal(login.status, "wait"); assert.equal(login.qrcodeUrl, "https://example.test/wechat-pair");
  let statusBody;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const statusResponse = await fetch(`http://127.0.0.1:${control.port}/v1/wechat-ilink/login/${login.loginId}`, { headers });
    statusBody = await statusResponse.json();
    if (statusBody.status === "confirmed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(statusBody.status, "confirmed"); assert.equal(statusBody.userId, "owner-wechat");
  const credentialsPath = join(stateDir, "wechat-ilink-credentials.json");
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.equal(stored.userId, "owner-wechat"); assert.equal(typeof stored.botToken, "string");

  const directConfig = loadIlinkConfig({ FRIDAY_WECHAT_ILINK_BASE_URL: `http://127.0.0.1:${providerPort}/`, FRIDAY_WECHAT_ILINK_BOT_TOKEN: "private-direct-ilink-token", FRIDAY_GATEWAY_STATE_DIR: stateDir });
  await sendIlinkText(directConfig, { botToken: "private-direct-ilink-token", baseUrl: `http://127.0.0.1:${providerPort}/` }, { channel: "wechat_ilink", messageId: "018f6f57-51d4-7b48-a3a3-c5e8b194aaf2", senderId: "owner-wechat", group: false, text: "hello", contextToken: "private-reply-context" }, "Friday reply", AbortSignal.timeout(1_000));
  assert.equal(sentBody.msg.to_user_id, "owner-wechat"); assert.equal(sentBody.msg.context_token, "private-reply-context"); assert.equal(sentBody.msg.item_list[0].text_item.text, "Friday reply");
});

test("iLink sendmessage rejects a non-zero provider errcode even on HTTP 200", async (t) => {
  const provider = createServer((request, response) => { request.resume(); request.on("end", () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ret: 0, errcode: -14 })); }); });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => provider.close((error) => error === undefined ? resolve() : reject(error))));
  const address = provider.address(); const port = typeof address === "object" && address !== null ? address.port : 0;
  const stateDir = await mkdtemp(join(tmpdir(), "m2-ilink-error-")); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const config = loadIlinkConfig({ FRIDAY_WECHAT_ILINK_BASE_URL: `http://127.0.0.1:${port}/`, FRIDAY_WECHAT_ILINK_BOT_TOKEN: "private-direct-ilink-token", FRIDAY_GATEWAY_STATE_DIR: stateDir });
  await assert.rejects(() => sendIlinkText(config, { botToken: "private-direct-ilink-token", baseUrl: `http://127.0.0.1:${port}/` }, { channel: "wechat_ilink", messageId: randomUUID(), senderId: "owner", group: false, text: "hello", contextToken: "context" }, "reply", AbortSignal.timeout(1_000)), /errcode=-14/);
});

test("Gateway pulls and acknowledges durable channel notifications with its ingest credential", async (t) => {
  const token = "N".repeat(43); let acknowledged;
  const hub = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.method === "GET") { response.end(JSON.stringify({ notification: { notificationId: "018f6f57-51d4-7b48-a3a3-c5e8b194aaf2", channel: "telegram", senderId: "123456789", text: "done", leaseId: "018f6f57-51d4-7b48-a3a3-c5e8b194aaf3" } })); return; }
    let raw = ""; request.on("data", (chunk) => { raw += chunk; }); request.on("end", () => { acknowledged = JSON.parse(raw); response.end(JSON.stringify({ delivered: true })); });
  });
  await new Promise((resolve, reject) => { hub.once("error", reject); hub.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => hub.close((error) => error === undefined ? resolve() : reject(error))));
  const address = hub.address(); const port = typeof address === "object" && address !== null ? address.port : 0;
  const config = { hubUrl: new URL(`http://127.0.0.1:${port}/`), tokens: { telegram: token } };
  const notification = await pullChannelNotification(config, "telegram");
  assert.equal(notification.text, "done");
  await acknowledgeChannelNotification(config, notification);
  assert.deepEqual(acknowledged, { leaseId: notification.leaseId });
});

test("iLink durable notification survives an upgrade without persisted reply context", async (t) => {
  let sentBody;
  const provider = createServer((request, response) => {
    let raw = ""; request.on("data", (chunk) => { raw += chunk; }); request.on("end", () => {
      sentBody = JSON.parse(raw); response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ret: 0, errcode: 0 }));
    });
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => provider.close((error) => error === undefined ? resolve() : reject(error))));
  const address = provider.address(); const port = typeof address === "object" && address !== null ? address.port : 0;
  const stateDir = await mkdtemp(join(tmpdir(), "m2-ilink-upgrade-")); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const config = loadIlinkConfig({ FRIDAY_WECHAT_ILINK_BASE_URL: `http://127.0.0.1:${port}/`, FRIDAY_WECHAT_ILINK_BOT_TOKEN: "private-direct-ilink-token", FRIDAY_GATEWAY_STATE_DIR: stateDir });
  const notification = { notificationId: randomUUID(), channel: "wechat_ilink", senderId: "paired-owner", text: "task complete", leaseId: randomUUID() };
  await deliverIlinkNotification(config, notification, AbortSignal.timeout(1_000));
  assert.equal(sentBody.msg.to_user_id, "paired-owner");
  assert.equal(sentBody.msg.client_id, `friday-${notification.notificationId}`);
  assert.equal("context_token" in sentBody.msg, false);
});
