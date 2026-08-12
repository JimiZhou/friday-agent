import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { JobExecutionStateV2, NodeToolCallV1, NodeToolDecisionV1 } from "@friday/protocol";
import type { SqliteJobRegistry } from "./job-registry.js";

export type OutboundChannel = "telegram" | "wechat_ilink";

export interface ChannelNotification {
  readonly notificationId: string;
  readonly channel: OutboundChannel;
  readonly senderId: string;
  readonly text: string;
  readonly leaseId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_STATES = new Set<JobExecutionStateV2>(["SUCCEEDED", "FAILED", "CANCELLED"]);
const NOTIFICATION_TEXT_BYTES = 14 * 1024;
const LEASE_MS = 60_000;

/** Durable Hub-owned queue for replies that happen after an inbound request has returned. */
export class ChannelOutbox {
  #database: DatabaseSync | undefined;

  constructor(readonly databasePath: string) {}

  open(): void {
    if (this.#database !== undefined) throw new Error("Channel outbox is already open");
    const database = new DatabaseSync(this.databasePath);
    this.#database = database;
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS channel_job_bindings_v1 (
          job_id TEXT PRIMARY KEY REFERENCES jobs_v2(job_id),
          channel TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS channel_outbox_v1 (
          notification_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL UNIQUE REFERENCES channel_job_bindings_v1(job_id),
          channel TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          available_at TEXT NOT NULL,
          lease_id TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS channel_outbox_delivery_v1
          ON channel_outbox_v1(channel, status, available_at, created_at);
        CREATE TABLE IF NOT EXISTS channel_clearance_outbox_v1 (
          notification_id TEXT PRIMARY KEY,
          call_id TEXT NOT NULL UNIQUE,
          job_id TEXT NOT NULL REFERENCES channel_job_bindings_v1(job_id),
          channel TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          available_at TEXT NOT NULL,
          lease_id TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS channel_clearance_outbox_delivery_v1
          ON channel_clearance_outbox_v1(channel, status, available_at, created_at);
      `);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void { this.#database?.close(); this.#database = undefined; }

  bindJob(jobId: string, channel: OutboundChannel, senderId: string, now = new Date()): void {
    requireUuid(jobId, "jobId"); requireChannel(channel); requireSender(senderId);
    const database = this.#requireDatabase();
    const existing = database.prepare("SELECT channel, sender_id AS senderId FROM channel_job_bindings_v1 WHERE job_id = ?").get(jobId) as unknown;
    if (isRecord(existing)) {
      if (existing.channel !== channel || existing.senderId !== senderId) throw new Error("Job is already bound to another channel recipient");
      return;
    }
    database.prepare("INSERT INTO channel_job_bindings_v1 (job_id, channel, sender_id, created_at) VALUES (?, ?, ?, ?)")
      .run(jobId.toLowerCase(), channel, senderId, now.toISOString());
  }

  enqueueTerminal(jobId: string, text: string, now = new Date()): boolean {
    requireUuid(jobId, "jobId"); requireText(text);
    const database = this.#requireDatabase();
    const binding = database.prepare("SELECT channel, sender_id AS senderId FROM channel_job_bindings_v1 WHERE job_id = ?").get(jobId) as unknown;
    if (!isRecord(binding) || !isChannel(binding.channel) || typeof binding.senderId !== "string") return false;
    const timestamp = now.toISOString();
    const result = database.prepare(`
      INSERT INTO channel_outbox_v1 (
        notification_id, job_id, channel, sender_id, text, status, attempts,
        available_at, lease_id, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL, NULL, ?, ?)
      ON CONFLICT(job_id) DO NOTHING
    `).run(randomUUID(), jobId.toLowerCase(), binding.channel, binding.senderId, text, timestamp, timestamp, timestamp);
    return result.changes === 1;
  }

  enqueueClearance(jobId: string, callId: string, text: string, now = new Date()): boolean {
    requireUuid(jobId, "jobId"); requireUuid(callId, "callId"); requireText(text);
    const database = this.#requireDatabase();
    const binding = database.prepare("SELECT channel, sender_id AS senderId FROM channel_job_bindings_v1 WHERE job_id = ?").get(jobId) as unknown;
    if (!isRecord(binding) || !isChannel(binding.channel) || typeof binding.senderId !== "string") return false;
    const timestamp = now.toISOString();
    const result = database.prepare(`
      INSERT INTO channel_clearance_outbox_v1 (
        notification_id, call_id, job_id, channel, sender_id, text, status, attempts,
        available_at, lease_id, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL, NULL, ?, ?)
      ON CONFLICT(call_id) DO NOTHING
    `).run(randomUUID(), callId.toLowerCase(), jobId.toLowerCase(), binding.channel, binding.senderId, text, timestamp, timestamp, timestamp);
    return result.changes === 1;
  }

  pull(channel: OutboundChannel, now = new Date()): ChannelNotification | undefined {
    requireChannel(channel);
    const database = this.#requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = now.toISOString();
      database.prepare(`
        UPDATE channel_outbox_v1
        SET status = 'PENDING', lease_id = NULL, lease_expires_at = NULL, available_at = ?, updated_at = ?
        WHERE channel = ? AND status = 'LEASED' AND lease_expires_at <= ?
      `).run(timestamp, timestamp, channel, timestamp);
      database.prepare(`
        UPDATE channel_clearance_outbox_v1
        SET status = 'PENDING', lease_id = NULL, lease_expires_at = NULL, available_at = ?, updated_at = ?
        WHERE channel = ? AND status = 'LEASED' AND lease_expires_at <= ?
      `).run(timestamp, timestamp, channel, timestamp);
      const row = database.prepare(`
        SELECT source, notificationId, channel, senderId, text FROM (
          SELECT 'terminal' AS source, notification_id AS notificationId, channel, sender_id AS senderId, text, created_at AS createdAt
          FROM channel_outbox_v1 WHERE channel = ? AND status = 'PENDING' AND available_at <= ?
          UNION ALL
          SELECT 'clearance' AS source, notification_id AS notificationId, channel, sender_id AS senderId, text, created_at AS createdAt
          FROM channel_clearance_outbox_v1 WHERE channel = ? AND status = 'PENDING' AND available_at <= ?
        ) ORDER BY createdAt, notificationId LIMIT 1
      `).get(channel, timestamp, channel, timestamp) as unknown;
      if (!isRecord(row) || (row.source !== "terminal" && row.source !== "clearance") || typeof row.notificationId !== "string" || !isChannel(row.channel) || typeof row.senderId !== "string" || typeof row.text !== "string") {
        database.exec("COMMIT");
        return undefined;
      }
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
      const changed = database.prepare(`
        UPDATE ${row.source === "terminal" ? "channel_outbox_v1" : "channel_clearance_outbox_v1"}
        SET status = 'LEASED', attempts = attempts + 1, lease_id = ?, lease_expires_at = ?, updated_at = ?
        WHERE notification_id = ? AND status = 'PENDING'
      `).run(leaseId, leaseExpiresAt, timestamp, row.notificationId);
      if (changed.changes !== 1) throw new Error("Channel notification lease was lost");
      database.exec("COMMIT");
      return { notificationId: row.notificationId, channel: row.channel, senderId: row.senderId, text: row.text, leaseId };
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  acknowledge(channel: OutboundChannel, notificationId: string, leaseId: string, now = new Date()): boolean {
    requireChannel(channel); requireUuid(notificationId, "notificationId"); requireUuid(leaseId, "leaseId");
    const database = this.#requireDatabase();
    for (const table of ["channel_outbox_v1", "channel_clearance_outbox_v1"] as const) {
      const result = database.prepare(`
        UPDATE ${table}
        SET status = 'DELIVERED', lease_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE notification_id = ? AND channel = ? AND status = 'LEASED' AND lease_id = ?
      `).run(now.toISOString(), notificationId.toLowerCase(), channel, leaseId.toLowerCase());
      if (result.changes === 1) return true;
    }
    return false;
  }

  terminalJobsMissingNotification(): readonly string[] {
    return (this.#requireDatabase().prepare(`
      SELECT binding.job_id AS jobId
      FROM channel_job_bindings_v1 binding
      JOIN jobs_v2 job ON job.job_id = binding.job_id
      LEFT JOIN channel_outbox_v1 outbox ON outbox.job_id = binding.job_id
      WHERE job.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND outbox.job_id IS NULL
      ORDER BY job.updated_at
    `).all() as Array<{ jobId: string }>).map((row) => row.jobId);
  }

  #requireDatabase(): DatabaseSync {
    if (this.#database === undefined) throw new Error("Channel outbox is not open");
    return this.#database;
  }
}

/** Binds a conversation-created Job and turns its terminal Runner evidence into one notification. */
export class JobChannelNotifier {
  constructor(readonly outbox: ChannelOutbox, readonly jobs: SqliteJobRegistry) {}

  bind(jobId: string, channel: OutboundChannel, senderId: string): void { this.outbox.bindJob(jobId, channel, senderId); }

  observe(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (job === undefined || !TERMINAL_STATES.has(job.status)) return false;
    return this.outbox.enqueueTerminal(jobId, terminalText(job.status, job.tool, job.operation, this.jobs.listEvents(jobId)));
  }

  requestClearance(call: NodeToolCallV1, decision: NodeToolDecisionV1): boolean {
    if (decision.status !== "WAIT_APPROVAL") return false;
    const argumentsText = JSON.stringify(call.arguments);
    return this.outbox.enqueueClearance(call.jobId, call.callId, truncateUtf8([
      "Friday 需要你的授权后才能继续任务。",
      `风险等级：${decision.risk}`,
      `背景：${decision.background}`,
      `能力：${call.name}`,
      `精确参数：${argumentsText}`,
      "该操作尚未执行。请登录 Web 控制台核对并授权。",
    ].join("\n"), NOTIFICATION_TEXT_BYTES));
  }

  reconcile(): number {
    let created = 0;
    for (const jobId of this.outbox.terminalJobsMissingNotification()) if (this.observe(jobId)) created += 1;
    return created;
  }
}

function terminalText(status: JobExecutionStateV2, tool: string, operation: string, events: ReturnType<SqliteJobRegistry["listEvents"]>): string {
  const heading = status === "SUCCEEDED" ? "任务已完成。" : status === "FAILED" ? "任务执行失败。" : "任务已取消。";
  const details: string[] = [];
  for (const entry of events) {
    if (entry.event.type === "output" && typeof entry.event.chunk === "string" && entry.event.chunk.trim() !== "") details.push(entry.event.chunk.trim());
    if (entry.event.type === "error" && typeof entry.event.error?.message === "string") details.push(entry.event.error.message.trim());
  }
  const text = [heading, `类型：${tool} / ${operation}`, ...(details.length === 0 ? [] : ["", "执行结果：", details.join("\n")])].join("\n");
  return truncateUtf8(text, NOTIFICATION_TEXT_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n…（结果已截断，请在 Web 控制台查看完整记录）";
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  let prefix = "";
  for (const character of value) {
    if (Buffer.byteLength(prefix + character, "utf8") > budget) break;
    prefix += character;
  }
  return prefix + suffix;
}

function requireUuid(value: string, name: string): void { if (!UUID_PATTERN.test(value)) throw new Error(`${name} is invalid`); }
function requireChannel(value: string): asserts value is OutboundChannel { if (!isChannel(value)) throw new Error("Channel is invalid"); }
function isChannel(value: unknown): value is OutboundChannel { return value === "telegram" || value === "wechat_ilink"; }
function requireSender(value: string): void { if (value.trim() === "" || Buffer.byteLength(value, "utf8") > 256 || value.includes("\0")) throw new Error("Sender is invalid"); }
function requireText(value: string): void { if (value.trim() === "" || Buffer.byteLength(value, "utf8") > NOTIFICATION_TEXT_BYTES || value.includes("\0")) throw new Error("Notification text is invalid"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
