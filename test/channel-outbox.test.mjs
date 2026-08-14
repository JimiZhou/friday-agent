import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChannelOutbox, JobChannelNotifier } from "../apps/fridayd/dist/channel-outbox.js";
import { loadOrCreateHubIdentity } from "../apps/fridayd/dist/hub-identity.js";
import { SqliteJobRegistry } from "../apps/fridayd/dist/job-registry.js";
import { createFridayServer } from "../apps/fridayd/dist/server.js";

test("channel outbox persists terminal Job results and requires the exact delivery lease", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-outbox-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const databasePath = join(stateDir, "friday.sqlite");
  const jobs = new SqliteJobRegistry(databasePath, await loadOrCreateHubIdentity(stateDir));
  const outbox = new ChannelOutbox(databasePath);
  jobs.open(); outbox.open();
  t.after(() => { outbox.close(); jobs.close(); });

  const runnerId = randomUUID();
  const created = jobs.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "infra", tool: "agent", operation: "diagnose", prompt: "inspect" }).job;
  const spec = created.spec;
  const notifier = new JobChannelNotifier(outbox, jobs);
  notifier.bind(created.jobId, "wechat_ilink", "owner-wechat");
  assert.equal(notifier.observe(created.jobId), false);
  const base = { protocolVersion: "2", jobId: created.jobId, runnerId, leaseId: spec.leaseId };
  jobs.acceptEvent({ ...base, eventId: randomUUID(), sequence: 0, sentAt: new Date().toISOString(), type: "state", state: "RUNNING" });
  jobs.acceptEvent({ ...base, eventId: randomUUID(), sequence: 1, sentAt: new Date().toISOString(), type: "output", stream: "stdout", chunk: "all checks passed" });
  jobs.acceptEvent({ ...base, eventId: randomUUID(), sequence: 2, sentAt: new Date().toISOString(), type: "state", state: "SUCCEEDED" });
  assert.equal(notifier.observe(created.jobId), true);
  assert.equal(notifier.observe(created.jobId), false);

  const notification = outbox.pull("wechat_ilink");
  assert.equal(notification.senderId, "owner-wechat");
  assert.match(notification.text, /任务完成/);
  assert.match(notification.text, /all checks passed/);
  assert.equal(outbox.acknowledge("wechat_ilink", notification.notificationId, randomUUID()), false);
  assert.equal(outbox.acknowledge("wechat_ilink", notification.notificationId, notification.leaseId), true);
  assert.equal(outbox.pull("wechat_ilink"), undefined);
});

test("channel outbox reconciles a terminal Job after a Hub interruption", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-reconcile-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const databasePath = join(stateDir, "friday.sqlite");
  const jobs = new SqliteJobRegistry(databasePath, await loadOrCreateHubIdentity(stateDir));
  const outbox = new ChannelOutbox(databasePath);
  jobs.open(); outbox.open();
  t.after(() => { outbox.close(); jobs.close(); });
  const runnerId = randomUUID();
  const created = jobs.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "infra", tool: "agent", operation: "diagnose", prompt: "inspect" }).job;
  const notifier = new JobChannelNotifier(outbox, jobs);
  notifier.bind(created.jobId, "telegram", "123456789");
  const spec = created.spec;
  const base = { protocolVersion: "2", jobId: created.jobId, runnerId, leaseId: spec.leaseId };
  jobs.acceptEvent({ ...base, eventId: randomUUID(), sequence: 0, sentAt: new Date().toISOString(), type: "state", state: "RUNNING" });
  jobs.acceptEvent({ ...base, eventId: randomUUID(), sequence: 1, sentAt: new Date().toISOString(), type: "state", state: "FAILED" });
  assert.equal(notifier.reconcile(), 1);
  assert.equal(notifier.reconcile(), 0);
  assert.match(outbox.pull("telegram").text, /没跑完/);
});

test("channel outbox delivers each clearance request independently from the terminal result", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-clearance-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const databasePath = join(stateDir, "friday.sqlite");
  const jobs = new SqliteJobRegistry(databasePath, await loadOrCreateHubIdentity(stateDir));
  const outbox = new ChannelOutbox(databasePath);
  jobs.open(); outbox.open();
  t.after(() => { outbox.close(); jobs.close(); });
  const runnerId = randomUUID();
  const job = jobs.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "node", tool: "agent", operation: "diagnose", prompt: "inspect" }).job;
  const notifier = new JobChannelNotifier(outbox, jobs, true);
  notifier.bind(job.jobId, "wechat_ilink", "owner-wechat");
  const call = { protocolVersion: "2", callId: randomUUID(), jobId: job.jobId, runnerId, leaseId: job.spec.leaseId, name: "service.restart", arguments: { unit: "demo.service" }, reason: "Recovery requires a restart", requestedAt: new Date().toISOString() };
  const decision = { status: "WAIT_APPROVAL", risk: "R2", background: "Service restart may interrupt requests." };
  assert.equal(notifier.requestClearance(call, decision), true);
  assert.equal(notifier.requestClearance(call, decision), false);
  const notification = outbox.pull("wechat_ilink");
  assert.match(notification.text, /回复「确认」/);
  assert.match(notification.text, /Recovery requires a restart/);
  assert.equal(notification.text.includes("R2"), false);
  assert.equal(notification.text.includes("demo.service"), false);
  assert.equal(outbox.acknowledge("wechat_ilink", notification.notificationId, notification.leaseId), true);
  assert.equal(outbox.pull("wechat_ilink"), undefined);
});

test("paired private-channel confirmation approves only its bound pending call", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-approval-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const ownerToken = "channel-approval-owner-token";
  const friday = await createFridayServer({
    host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken,
    channelApprovalEnabled: true, maxBodyBytes: 1_048_576,
  });
  t.after(() => friday.stop());
  const address = await friday.start();
  const base = `http://${address.host}:${address.port}`;
  const ownerHeaders = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };

  const rotated = await fetch(`${base}/v2/channels/rotate`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ channel: "wechat_ilink" }) });
  assert.equal(rotated.status, 201);
  const channelToken = (await rotated.json()).token;
  const paired = await fetch(`${base}/v2/channels/pair`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ channel: "wechat_ilink", senderId: "owner-wechat" }) });
  assert.equal(paired.status, 200);

  const runnerId = randomUUID();
  const job = friday.jobRegistry.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "node", tool: "agent", operation: "diagnose", prompt: "inspect" }).job;
  friday.channelOutbox.bindJob(job.jobId, "wechat_ilink", "owner-wechat");
  const call = { protocolVersion: "2", callId: randomUUID(), jobId: job.jobId, runnerId, leaseId: job.spec.leaseId, name: "command.exec", arguments: { command: "readonly-check" }, reason: "检查节点状态", requestedAt: new Date().toISOString() };
  const decision = friday.nodeToolPolicy.evaluate(call);
  assert.equal(decision.status, "WAIT_APPROVAL");
  const notifier = new JobChannelNotifier(friday.channelOutbox, friday.jobRegistry, true);
  assert.equal(notifier.requestClearance(call, decision), true);

  const inbound = await fetch(`${base}/v2/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "wechat_ilink", token: channelToken, senderId: "owner-wechat", messageId: randomUUID(), group: false, text: "确认" }),
  });
  assert.equal(inbound.status, 202);
  assert.match((await inbound.json()).reply, /确认收到/);
  assert.equal(friday.nodeToolPolicy.get(call.callId).status, "APPROVED");
  assert.equal(friday.jobRegistry.get(job.jobId).status, "DISPATCHED");
});
