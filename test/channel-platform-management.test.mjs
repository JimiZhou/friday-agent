import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelPlatformManagement, platformMenu } from "../apps/fridayd/dist/channel-platform-management.js";
import { createFridayServer } from "../apps/fridayd/dist/server.js";

test("every displayed menu operation starts with slash, including confirmations and cancellation", () => {
  const commands = platformMenu().split("\n").filter((line) => line.startsWith("•"));
  assert.ok(commands.length >= 10);
  for (const command of commands) assert.match(command, /^• \/[a-z]/);
  assert.ok(commands.some((command) => command.startsWith("• /confirm stop")));
  assert.ok(commands.some((command) => command.startsWith("• /runner confirm revoke")));
  assert.ok(commands.some((command) => command.startsWith("• /cancel")));
});

test("platform stop confirmation is channel/sender bound, expires, and cannot replay", async () => {
  const jobId = randomUUID();
  let stopped = 0;
  const manager = new ChannelPlatformManagement({
    enabled: true,
    status: async () => "status",
    channels: async () => "channels",
    tasks: () => [{ jobId, runnerId: randomUUID(), status: "RUNNING", operation: "diagnose" }],
    stopTask: async () => { stopped++; return "stopped"; },
  });
  const now = Date.now();
  assert.match(await manager.handle("wechat_ilink", "owner", "/"), /Friday 平台操作菜单/);
  assert.match(await manager.handle("wechat_ilink", "owner", `/stop ${jobId}`, now), /\/confirm stop/);
  assert.match(await manager.handle("wechat_ilink", "other", `确认停止任务 ${jobId}`, now), /没有匹配/);
  assert.match(await manager.handle("telegram", "owner", `确认停止任务 ${jobId}`, now), /没有匹配/);
  assert.equal(stopped, 0);
  assert.equal(await manager.handle("wechat_ilink", "owner", `/confirm stop ${jobId}`, now), "stopped");
  assert.match(await manager.handle("wechat_ilink", "owner", `确认停止任务 ${jobId}`, now, false), /没有重复/);
  assert.equal(stopped, 1);
  await manager.handle("wechat_ilink", "owner", `/stop ${jobId}`, now);
  assert.match(await manager.handle("wechat_ilink", "owner", `确认停止任务 ${jobId}`, now + 120_001), /没有匹配/);
  await manager.handle("wechat_ilink", "owner", `/stop ${jobId}`, now);
  await manager.handle("wechat_ilink", "owner", "/cancel", now);
  assert.match(await manager.handle("wechat_ilink", "owner", `确认停止任务 ${jobId}`, now), /没有匹配/);
  assert.equal(stopped, 1);
});

test("paired iLink can use slash and natural language menus without a model; unauthorized and group senders cannot manage", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-im-menu-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const server = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken: "owner-test-token-long-enough", maxBodyBytes: 1_048_576, channelFleetManagementEnabled: true });
  const address = await server.start();
  t.after(() => server.stop());
  const base = `http://${address.host}:${address.port}`;
  const headers = { authorization: "Bearer owner-test-token-long-enough", "content-type": "application/json" };
  const rotated = await fetch(`${base}/v2/channels/rotate`, { method: "POST", headers, body: JSON.stringify({ channel: "wechat_ilink" }) });
  const { token } = await rotated.json();
  await fetch(`${base}/v2/channels/pair`, { method: "POST", headers, body: JSON.stringify({ channel: "wechat_ilink", senderId: "owner" }) });
  const send = async (text, extra = {}) => {
    const response = await fetch(`${base}/v2/inbound`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "wechat_ilink", token, senderId: "owner", messageId: randomUUID(), group: false, text, ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  for (const command of ["/", "/menu", "操作菜单"]) {
    const result = await send(command);
    assert.equal(result.status, 202);
    assert.match(result.body.reply, /\/devices/);
    assert.match(result.body.reply, /\/tasks/);
  }
  assert.match((await send("平台状态")).body.reply, /0 在线/);
  assert.match((await send("查看设备")).body.reply, /没有登记过节点/);
  assert.match((await send("查看任务")).body.reply, /没有任务/);
  assert.match((await send("/channels")).body.reply, /未配置/);
  assert.equal((await send("/menu", { senderId: "stranger" })).status, 401);
  assert.equal((await send("新增纳管", { group: true })).status, 401);
  assert.match((await send("新增纳管")).body.reply, /FRIDAY_RUNNER_SSH_TARGET/);
});
