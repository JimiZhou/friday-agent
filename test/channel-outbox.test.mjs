import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChannelOutbox, JobChannelNotifier } from "../apps/fridayd/dist/channel-outbox.js";
import { loadOrCreateHubIdentity } from "../apps/fridayd/dist/hub-identity.js";
import { SqliteJobRegistry } from "../apps/fridayd/dist/job-registry.js";

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
  assert.match(notification.text, /任务已完成/);
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
  assert.match(outbox.pull("telegram").text, /任务执行失败/);
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
  const notifier = new JobChannelNotifier(outbox, jobs);
  notifier.bind(job.jobId, "wechat_ilink", "owner-wechat");
  const call = { protocolVersion: "2", callId: randomUUID(), jobId: job.jobId, runnerId, leaseId: job.spec.leaseId, name: "service.restart", arguments: { unit: "demo.service" }, reason: "Recovery requires a restart", requestedAt: new Date().toISOString() };
  const decision = { status: "WAIT_APPROVAL", risk: "R2", background: "Service restart may interrupt requests." };
  assert.equal(notifier.requestClearance(call, decision), true);
  assert.equal(notifier.requestClearance(call, decision), false);
  const notification = outbox.pull("wechat_ilink");
  assert.match(notification.text, /需要你的授权/);
  assert.match(notification.text, /R2/);
  assert.match(notification.text, /demo\.service/);
  assert.equal(outbox.acknowledge("wechat_ilink", notification.notificationId, notification.leaseId), true);
  assert.equal(outbox.pull("wechat_ilink"), undefined);
});
