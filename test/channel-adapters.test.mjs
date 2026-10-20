import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { channelInbound, createSocketAdapter, textChunks, validateChannelCredentials } from "../apps/channel-gateway/dist/channel-adapters.js";
import { ChannelRuntime } from "../apps/channel-gateway/dist/channel-runtime.js";
import { startIlinkControlServer, loadIlinkConfig } from "../apps/channel-gateway/dist/index.js";
import { createFridayServer } from "../apps/fridayd/dist/server.js";
import { parseJoinArguments, joinPlan } from "../apps/fridayctl/dist/join.js";

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition timed out");
}

test("channel adapters accept only direct text with stable message IDs", () => {
  const cases = [
    ["feishu", { message: { chat_type: "p2p", message_type: "text", message_id: "f1", content: '{"text":"/menu"}' }, sender: { sender_id: { open_id: "owner" } } }],
    ["wecom", { body: { chattype: "single", msgtype: "text", msgid: "w1", from: { userid: "owner" }, text: { content: "/menu" } } }],
    ["qq", { t: "C2C_MESSAGE_CREATE", d: { id: "q1", author: { user_openid: "owner" }, content: "/menu" } }],
    ["cmcc", { type: "text_message", messageId: "c1", from: "owner", content: "/menu" }],
  ];
  for (const [channel, event] of cases) {
    const first = channelInbound(channel, event);
    assert.equal(first.senderId, "owner");
    assert.equal(first.text, "/menu");
    assert.equal(first.group, false);
    assert.equal(first.messageId, channelInbound(channel, event).messageId);
    assert.match(first.messageId, /^[0-9a-f-]{36}$/);
  }
  assert.equal(channelInbound("feishu", { ...cases[0][1], message: { ...cases[0][1].message, chat_type: "group" } }), undefined);
  assert.equal(channelInbound("wecom", { body: { ...cases[1][1].body, chattype: "group" } }), undefined);
  assert.equal(channelInbound("qq", { ...cases[2][1], t: "GROUP_AT_MESSAGE_CREATE" }), undefined);
  assert.equal(channelInbound("cmcc", { ...cases[3][1], group: true }), undefined);
  assert.equal(channelInbound("cmcc", { type: "media_message", from: "owner", content: "/menu" }), undefined);
  assert.equal(channelInbound("cmcc", { ...cases[3][1], content: "x".repeat(20_000) }), undefined);
  assert.throws(() => validateChannelCredentials("cmcc", { apiKey: "not-a-key" }));
  assert.throws(() => validateChannelCredentials("feishu", { appId: "app", appSecret: "secret", endpoint: "https://evil.test" }));
});

test("CMCC WebSocket authenticates, serves the paired Owner's slash menu and rejects strangers", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-cmcc-ws-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const hub = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken: "test-owner-token-for-adapters", maxBodyBytes: 1_048_576 });
  const address = await hub.start(); t.after(() => hub.stop());
  const base = `http://${address.host}:${address.port}`, headers = { authorization: "Bearer test-owner-token-for-adapters", "content-type": "application/json" };
  const token = (await (await fetch(base + "/v2/channels/rotate", { method: "POST", headers, body: '{"channel":"cmcc"}' })).json()).token;
  await fetch(base + "/v2/channels/pair", { method: "POST", headers, body: '{"channel":"cmcc","senderId":"owner"}' });
  const provider = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => provider.once("listening", resolve));
  t.after(() => new Promise((resolve) => { for (const client of provider.clients) client.terminate(); provider.close(resolve); }));
  const controller = new AbortController(); t.after(() => controller.abort());
  const sent = [], accepted = [];
  let authenticated = false;
  provider.on("connection", (socket, request) => {
    assert.equal(request.headers["x-api-key"], "ak_fixture-secret-for-testing");
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "auth") {
        assert.equal(message.version, "2.0");
        socket.send('{"type":"auth_ok"}');
        socket.send('{"type":"text_message","messageId":"stranger1","from":"stranger","content":"/menu"}');
        socket.send('{"type":"text_message","messageId":"owner1","from":"owner","content":"/menu"}');
      } else if (message.type === "send") sent.push(message);
    });
  });
  const adapter = createSocketAdapter("cmcc", { apiKey: "ak_fixture-secret-for-testing" }, {
    accepts: (sender) => sender === "owner",
    connected: (value) => { authenticated = value; }, failure: () => {},
    inbound: async (message) => {
      accepted.push(message);
      const response = await fetch(base + "/v2/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...message, token }) });
      assert.equal(response.status, 202);
      return (await response.json()).reply;
    },
  }, controller.signal, `ws://127.0.0.1:${provider.address().port}`);
  await until(() => sent.length === 1);
  assert.equal(authenticated, true);
  assert.equal(accepted.length, 1);
  assert.equal(sent[0].to, "owner");
  assert.match(sent[0].content, /Friday 平台操作菜单/);
  assert.match(sent[0].content, /\/devices/);
  adapter.stop();
});

test("private dynamic channel config persists, redacts keys and can disable/reload", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "friday-channel-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController(); t.after(() => controller.abort());
  const runtime = new ChannelRuntime({ hubUrl: new URL("http://127.0.0.1:1"), tokens: {} }, directory, controller.signal, async (_channel, _credentials, callbacks, signal) => {
    callbacks.connected(true);
    signal.addEventListener("abort", () => callbacks.connected(false), { once: true });
    return { async send() {}, stop() {} };
  });
  await runtime.load();
  const fixture = { senderId: "owner", ingestToken: "t".repeat(43), credentials: { appId: "app", appSecret: "private-secret" } };
  await runtime.configure("feishu", fixture);
  await until(() => runtime.status().find((entry) => entry.channel === "feishu").connected);
  assert.equal((await stat(join(directory, "feishu-channel.json"))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(directory, "feishu-channel.json"), "utf8")).credentials.appSecret, "private-secret");
  assert.doesNotMatch(JSON.stringify(runtime.status()), /private-secret|tttttttt/);
  await runtime.disable("feishu");
  assert.equal(runtime.status().find((entry) => entry.channel === "feishu").configured, false);
  assert.doesNotMatch(await readFile(join(directory, "feishu-channel.json"), "utf8"), /private-secret/);
});

test("child-node join needs only its one-time credential and never accepts SSH or Owner token options", () => {
  const args = ["runner", "join", "--hub-url", "https://hub.test", "--runner-name", "inner-node", "--service-user", "ubuntu", "--enrollment-file", "./enrollment.json"];
  const options = parseJoinArguments(args);
  assert.equal(options.dryRun, false);
  assert.equal(options.hubUrl.origin, "https://hub.test");
  assert.match(joinPlan(options).join("\n"), /no SSH connection and no Owner token/);
  assert.throws(() => parseJoinArguments([...args, "--owner-token-env", "SECRET"]));
  assert.throws(() => parseJoinArguments([...args, "--identity-file", "id_rsa"]));
  assert.throws(() => parseJoinArguments(args.slice(0, -2)), /enrollment-file/);
  assert.throws(() => parseJoinArguments([...args, "--hub-url", "http://public.test"]));
});

test("channel text chunks preserve Unicode without exceeding platform limits", () => {
  const text = "你好🌍".repeat(2000);
  const chunks = textChunks(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 3500));
});

test("QQ authenticates with AppSecret, identifies C2C events and replies with the bound message context", async (t) => {
  const provider = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => provider.once("listening", resolve));
  t.after(() => new Promise((resolve) => { for (const client of provider.clients) client.terminate(); provider.close(resolve); }));
  const controller = new AbortController(); t.after(() => controller.abort());
  const frames = [], requests = [];
  provider.on("connection", (socket) => {
    socket.send('{"op":10,"d":{"heartbeat_interval":1000}}');
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()); frames.push(frame);
      if (frame.op === 2) {
        socket.send('{"op":0,"t":"READY","s":1,"d":{"session_id":"test-session"}}');
        socket.send('{"op":0,"t":"C2C_MESSAGE_CREATE","s":2,"d":{"id":"private-message","author":{"user_openid":"owner"},"content":"/menu"}}');
      }
      if (frame.op === 1) socket.send('{"op":11}');
    });
  });
  const adapter = createSocketAdapter("qq", { appId: "app-id", appSecret: "private-app-secret" }, {
    accepts: (sender) => sender === "owner", connected() {}, failure() {}, inbound: async () => "Friday menu",
  }, controller.signal, undefined, {
    socketFactory: (_endpoint, options) => new WebSocket(`ws://127.0.0.1:${provider.address().port}`, options),
    requestJson: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("getAppAccessToken")) return { access_token: "test-access", expires_in: 7200 };
      if (url.endsWith("/gateway")) return { url: "wss://gateway.qq.com" };
      return { id: "reply-id" };
    },
  });
  await until(() => requests.some((request) => request.url.endsWith("/messages")));
  assert.equal(frames[0].op, 2);
  assert.equal(frames[0].d.token, "QQBot test-access");
  assert.equal(frames[0].d.intents, 1 << 25);
  const send = requests.find((request) => request.url.endsWith("/messages"));
  assert.match(send.url, /\/users\/owner\/messages$/);
  assert.equal(JSON.parse(send.init.body).msg_id, "private-message");
  assert.equal(JSON.parse(send.init.body).msg_seq, 1);
  assert.equal(JSON.parse(send.init.body).content, "Friday menu");
  adapter.stop();
});

test("Hub channel configuration goes through authenticated loopback control, pairs owners and never returns credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "friday-channel-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController(); t.after(() => controller.abort());
  const controlToken = "c".repeat(43);
  const runtime = new ChannelRuntime({ hubUrl: new URL("http://127.0.0.1:1"), tokens: {} }, directory, controller.signal, async (_channel, _credentials, callbacks, signal) => {
    callbacks.connected(true);
    signal.addEventListener("abort", () => callbacks.connected(false), { once: true });
    return { async send() {}, stop() {} };
  });
  await runtime.load();
  const ilink = { ...loadIlinkConfig({ FRIDAY_GATEWAY_STATE_DIR: directory, FRIDAY_GATEWAY_CONTROL_TOKEN: controlToken }), controlPort: 0 };
  const gateway = await startIlinkControlServer(ilink, controller.signal, runtime);
  t.after(() => gateway.stop().catch(() => {}));
  assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/v1/channels/status`)).status, 401);
  const hub = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir: join(directory, "hub"), ownerId: "owner", ownerToken: "owner-token-for-configuration", maxBodyBytes: 1_048_576, channelGateway: { controlUrl: new URL(`http://127.0.0.1:${gateway.port}`), controlToken } });
  const address = await hub.start(); t.after(() => hub.stop());
  const base = `http://${address.host}:${address.port}`, headers = { authorization: "Bearer owner-token-for-configuration", "content-type": "application/json" };
  assert.equal((await fetch(base + "/v4/channels")).status, 401);
  const configured = await fetch(base + "/v4/channels/feishu/configure", { method: "POST", headers, body: JSON.stringify({ senderId: "paired-owner", credentials: { appId: "app", appSecret: "private-secret" } }) });
  assert.equal(configured.status, 200);
  assert.doesNotMatch(await configured.text(), /private-secret/);
  const status = await fetch(base + "/v4/channels", { headers });
  assert.doesNotMatch(await status.text(), /private-secret/);
  const stored = JSON.parse(await readFile(join(directory, "feishu-channel.json"), "utf8"));
  const inbound = async (senderId, token = stored.ingestToken) => fetch(base + "/v2/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "feishu", senderId, token, group: false, messageId: randomUUID(), text: "/menu" }) });
  assert.equal((await inbound("other")).status, 401);
  const owner = await inbound("paired-owner");
  assert.equal(owner.status, 202);
  assert.match((await owner.json()).reply, /Friday 平台操作菜单/);
  assert.equal((await fetch(base + "/v4/channels/feishu/disable", { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal((await inbound("paired-owner")).status, 401);
});
