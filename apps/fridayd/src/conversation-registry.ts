import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { JobToolV2 } from "@friday/protocol";
import type { ConversationMedia } from "./conversation-media.js";
import { validateSelfImprovementContext, type SelfImprovementContext } from "./m3-registry.js";

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT_BYTES = 32 * 1024;

export type ConversationChannel = "web" | "telegram" | "wechat_ilink" | "voice";
export type ConversationTurnStatus = "QUEUED" | "THINKING" | "REPLIED" | "JOB_PROPOSED" | "FAILED";

export interface ConversationJobProposal {
  readonly workspaceId: string;
  readonly tool: JobToolV2;
  readonly operation: "develop" | "diagnose" | "review" | "test";
  readonly prompt: string;
  readonly runnerSelector: "auto";
}

export interface ConversationSelfImprovementProposal extends SelfImprovementContext {
  readonly workspaceId: string;
  readonly tool: Exclude<JobToolV2, "agent">;
  readonly prompt: string;
  readonly runnerSelector: "auto";
}

export interface ConversationView {
  readonly conversationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly latestStatus?: ConversationTurnStatus;
}

export interface ConversationTurnView {
  readonly turnId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly channel: ConversationChannel;
  readonly text: string;
  readonly attachments: readonly ConversationMedia[];
  readonly status: ConversationTurnStatus;
  readonly piSessionId?: string;
  readonly assistantReply?: string;
  readonly jobProposal?: ConversationJobProposal;
  readonly selfImprovementProposal?: ConversationSelfImprovementProposal;
  readonly jobId?: string;
  readonly schedulingError?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationMessageInput {
  readonly conversationId: string;
  readonly messageId: string;
  readonly channel: ConversationChannel;
  readonly text: string;
  readonly attachments?: readonly ConversationMedia[];
}

export type ConversationAcceptResult =
  | { readonly outcome: "new"; readonly turn: ConversationTurnView }
  | { readonly outcome: "duplicate"; readonly turn: ConversationTurnView }
  | { readonly outcome: "conflict" };

/**
 * Durable private conversation facts. Unlike the append-only audit ledger,
 * this registry intentionally retains bounded plaintext so a Pi session can
 * be reconstructed after a worker restart. The state directory is therefore
 * part of the Owner's private-data boundary.
 */
export class ConversationRegistry {
  readonly #databasePath: string;
  #database: DatabaseSync | undefined;

  constructor(databasePath: string) {
    this.#databasePath = databasePath;
  }

  open(now = new Date()): void {
    if (this.#database !== undefined) throw new Error("Conversation registry is already open");
    const database = new DatabaseSync(this.#databasePath);
    this.#database = database;
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS conversations_v1 (
          conversation_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS conversation_turns_v1 (
          turn_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations_v1(conversation_id),
          message_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          message_digest TEXT NOT NULL,
          input_text TEXT NOT NULL,
          attachments_json TEXT,
          status TEXT NOT NULL,
          pi_session_id TEXT,
          assistant_reply TEXT,
          job_proposal_json TEXT,
          self_improvement_proposal_json TEXT,
          job_id TEXT,
          scheduling_error TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(channel, message_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS conversation_turns_by_conversation_v1
          ON conversation_turns_v1(conversation_id, created_at, turn_id);
        CREATE TRIGGER IF NOT EXISTS conversation_turn_updates_parent_v1
        AFTER UPDATE ON conversation_turns_v1
        BEGIN
          UPDATE conversations_v1 SET updated_at = NEW.updated_at WHERE conversation_id = NEW.conversation_id;
        END;
      `);
      const turnColumns = database.prepare("PRAGMA table_info(conversation_turns_v1)").all() as { name: string }[];
      if (!turnColumns.some((column) => column.name === "self_improvement_proposal_json")) {
        database.exec("ALTER TABLE conversation_turns_v1 ADD COLUMN self_improvement_proposal_json TEXT");
      }
      if (!turnColumns.some((column) => column.name === "attachments_json")) {
        database.exec("ALTER TABLE conversation_turns_v1 ADD COLUMN attachments_json TEXT");
      }
      // A process death cannot prove whether the model completed. Preserve the
      // input fact, fail closed, and require a new source message id to retry.
      database.prepare(`
        UPDATE conversation_turns_v1
        SET status = 'FAILED', error_code = 'AGENT_INTERRUPTED', updated_at = ?
        WHERE status IN ('QUEUED', 'THINKING')
      `).run(now.toISOString());
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    const database = this.#database;
    this.#database = undefined;
    database?.close();
  }

  accept(input: ConversationMessageInput, now = new Date()): ConversationAcceptResult {
    validateMessageInput(input);
    const database = this.#requireDatabase();
    const normalized = { ...input, messageId: input.messageId.toLowerCase() };
    const digest = messageDigest(normalized);
    return this.#transaction(database, () => {
      const existing = database.prepare(
        "SELECT * FROM conversation_turns_v1 WHERE channel = ? AND message_id = ?",
      ).get(normalized.channel, normalized.messageId) as unknown;
      if (isRecord(existing)) {
        return existing.message_digest === digest
          ? { outcome: "duplicate", turn: this.#toTurn(existing) }
          : { outcome: "conflict" };
      }

      const timestamp = now.toISOString();
      database.prepare(`
        INSERT INTO conversations_v1 (conversation_id, created_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(normalized.conversationId, timestamp, timestamp);
      const turnId = randomUUID();
      database.prepare(`
        INSERT INTO conversation_turns_v1 (
          turn_id, conversation_id, message_id, channel, message_digest,
          input_text, attachments_json, status, pi_session_id, assistant_reply,
          job_proposal_json, self_improvement_proposal_json, job_id, scheduling_error, error_code,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        turnId,
        normalized.conversationId,
        normalized.messageId,
        normalized.channel,
        digest,
        normalized.text,
        JSON.stringify(normalized.attachments ?? []),
        timestamp,
        timestamp,
      );
      return { outcome: "new", turn: this.#readTurn(turnId) };
    });
  }

  markThinking(turnId: string, piSessionId: string, now = new Date()): ConversationTurnView {
    requireUuid(turnId, "turnId");
    requireUuid(piSessionId, "piSessionId");
    const result = this.#requireDatabase().prepare(`
      UPDATE conversation_turns_v1
      SET status = 'THINKING', pi_session_id = ?, error_code = NULL, updated_at = ?
      WHERE turn_id = ? AND status = 'QUEUED'
    `).run(piSessionId.toLowerCase(), now.toISOString(), turnId.toLowerCase());
    if (result.changes !== 1) throw new Error("Conversation turn is not queued");
    return this.#readTurn(turnId);
  }

  completeReply(turnId: string, reply: string, now = new Date()): ConversationTurnView {
    requireUuid(turnId, "turnId");
    requireBoundedText(reply, "reply", 16 * 1024);
    const result = this.#requireDatabase().prepare(`
      UPDATE conversation_turns_v1
      SET status = 'REPLIED', assistant_reply = ?, error_code = NULL, updated_at = ?
      WHERE turn_id = ? AND status = 'THINKING'
    `).run(reply, now.toISOString(), turnId.toLowerCase());
    if (result.changes !== 1) throw new Error("Conversation turn is not thinking");
    return this.#readTurn(turnId);
  }

  recordProposal(
    turnId: string,
    reply: string,
    proposal: ConversationJobProposal,
    now = new Date(),
  ): ConversationTurnView {
    requireUuid(turnId, "turnId");
    requireBoundedText(reply, "reply", 16 * 1024);
    validateJobProposal(proposal);
    const result = this.#requireDatabase().prepare(`
      UPDATE conversation_turns_v1
      SET status = 'JOB_PROPOSED', assistant_reply = ?, job_proposal_json = ?,
          self_improvement_proposal_json = NULL, scheduling_error = NULL, error_code = NULL, updated_at = ?
      WHERE turn_id = ? AND status = 'THINKING'
    `).run(reply, JSON.stringify(proposal), now.toISOString(), turnId.toLowerCase());
    if (result.changes !== 1) throw new Error("Conversation turn is not thinking");
    return this.#readTurn(turnId);
  }

  recordSelfImprovementProposal(
    turnId: string,
    reply: string,
    proposal: ConversationSelfImprovementProposal,
    now = new Date(),
  ): ConversationTurnView {
    requireUuid(turnId, "turnId");
    requireBoundedText(reply, "reply", 16 * 1024);
    validateSelfImprovementProposal(proposal);
    const result = this.#requireDatabase().prepare(`
      UPDATE conversation_turns_v1
      SET status = 'JOB_PROPOSED', assistant_reply = ?, job_proposal_json = NULL,
          self_improvement_proposal_json = ?, scheduling_error = NULL, error_code = NULL, updated_at = ?
      WHERE turn_id = ? AND status = 'THINKING'
    `).run(reply, JSON.stringify(proposal), now.toISOString(), turnId.toLowerCase());
    if (result.changes !== 1) throw new Error("Conversation turn is not thinking");
    return this.#readTurn(turnId);
  }

  recordSchedulingResult(
    turnId: string,
    result: { readonly jobId: string; readonly errorCode?: never } | { readonly jobId?: never; readonly errorCode: string },
    now = new Date(),
  ): ConversationTurnView {
    requireUuid(turnId, "turnId");
    if ("jobId" in result && result.jobId !== undefined) requireUuid(result.jobId, "jobId");
    if ("errorCode" in result && result.errorCode !== undefined && !/^[A-Z][A-Z0-9_]{0,127}$/.test(result.errorCode)) {
      throw new Error("scheduling error code is invalid");
    }
    const update = "jobId" in result
      ? { jobId: result.jobId, schedulingError: null }
      : { jobId: null, schedulingError: result.errorCode };
    const changed = this.#requireDatabase().prepare(`
      UPDATE conversation_turns_v1
      SET job_id = ?, scheduling_error = ?, updated_at = ?
      WHERE turn_id = ? AND status = 'JOB_PROPOSED'
    `).run(update.jobId, update.schedulingError, now.toISOString(), turnId.toLowerCase());
    if (changed.changes !== 1) throw new Error("Conversation turn has no schedulable proposal");
    return this.#readTurn(turnId);
  }

  fail(turnId: string, errorCode: string, now = new Date()): ConversationTurnView {
    requireUuid(turnId, "turnId");
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(errorCode)) throw new Error("Conversation error code is invalid");
    const result = this.#requireDatabase().prepare(`
      UPDATE conversation_turns_v1
      SET status = 'FAILED', error_code = ?, updated_at = ?
      WHERE turn_id = ? AND status IN ('QUEUED', 'THINKING')
    `).run(errorCode, now.toISOString(), turnId.toLowerCase());
    if (result.changes !== 1) throw new Error("Conversation turn cannot fail from its current state");
    return this.#readTurn(turnId);
  }

  getConversation(conversationId: string): ConversationView | undefined {
    requireConversationId(conversationId);
    const row = this.#requireDatabase().prepare(`
      SELECT c.conversation_id AS conversationId, c.created_at AS createdAt,
             c.updated_at AS updatedAt, COUNT(t.turn_id) AS turnCount,
             (SELECT status FROM conversation_turns_v1 latest
              WHERE latest.conversation_id = c.conversation_id
              ORDER BY latest.created_at DESC, latest.turn_id DESC LIMIT 1) AS latestStatus
      FROM conversations_v1 c
      LEFT JOIN conversation_turns_v1 t ON t.conversation_id = c.conversation_id
      WHERE c.conversation_id = ?
      GROUP BY c.conversation_id
    `).get(conversationId) as unknown;
    if (!isRecord(row)) return undefined;
    return this.#toConversation(row);
  }

  listConversations(limit = 50): readonly ConversationView[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Conversation limit is invalid");
    return (this.#requireDatabase().prepare(`
      SELECT c.conversation_id AS conversationId, c.created_at AS createdAt,
             c.updated_at AS updatedAt, COUNT(t.turn_id) AS turnCount,
             (SELECT status FROM conversation_turns_v1 latest
              WHERE latest.conversation_id = c.conversation_id
              ORDER BY latest.created_at DESC, latest.turn_id DESC LIMIT 1) AS latestStatus
      FROM conversations_v1 c
      LEFT JOIN conversation_turns_v1 t ON t.conversation_id = c.conversation_id
      GROUP BY c.conversation_id
      ORDER BY c.updated_at DESC, c.conversation_id
      LIMIT ?
    `).all(limit) as unknown[]).map((row) => {
      if (!isRecord(row)) throw new Error("Stored conversation is invalid");
      return this.#toConversation(row);
    });
  }

  getTurn(turnId: string): ConversationTurnView | undefined {
    requireUuid(turnId, "turnId");
    const row = this.#requireDatabase().prepare(
      "SELECT * FROM conversation_turns_v1 WHERE turn_id = ?",
    ).get(turnId.toLowerCase()) as unknown;
    return isRecord(row) ? this.#toTurn(row) : undefined;
  }

  listTurns(conversationId: string, limit = 200): readonly ConversationTurnView[] {
    requireConversationId(conversationId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Conversation turn limit is invalid");
    return (this.#requireDatabase().prepare(`
      SELECT * FROM (
        SELECT * FROM conversation_turns_v1
        WHERE conversation_id = ?
        ORDER BY created_at DESC, turn_id DESC LIMIT ?
      ) ORDER BY created_at, turn_id
    `).all(conversationId, limit) as unknown[]).map((row) => {
      if (!isRecord(row)) throw new Error("Stored conversation turn is invalid");
      return this.#toTurn(row);
    });
  }

  #readTurn(turnId: string): ConversationTurnView {
    const row = this.#requireDatabase().prepare(
      "SELECT * FROM conversation_turns_v1 WHERE turn_id = ?",
    ).get(turnId.toLowerCase()) as unknown;
    if (!isRecord(row)) throw new Error("Conversation turn was not persisted");
    return this.#toTurn(row);
  }

  #toConversation(row: Record<string, unknown>): ConversationView {
    if (
      typeof row.conversationId !== "string" ||
      typeof row.createdAt !== "string" ||
      typeof row.updatedAt !== "string" ||
      !Number.isSafeInteger(row.turnCount) ||
      (row.latestStatus !== null && row.latestStatus !== undefined && !isTurnStatus(row.latestStatus))
    ) throw new Error("Stored conversation is invalid");
    return {
      conversationId: row.conversationId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      turnCount: row.turnCount as number,
      ...(isTurnStatus(row.latestStatus) ? { latestStatus: row.latestStatus } : {}),
    };
  }

  #toTurn(row: Record<string, unknown>): ConversationTurnView {
    if (
      typeof row.turn_id !== "string" ||
      typeof row.conversation_id !== "string" ||
      typeof row.message_id !== "string" ||
      !isChannel(row.channel) ||
      typeof row.input_text !== "string" ||
      !isTurnStatus(row.status) ||
      typeof row.created_at !== "string" ||
      typeof row.updated_at !== "string"
    ) throw new Error("Stored conversation turn is invalid");
    let proposal: ConversationJobProposal | undefined;
    if (typeof row.job_proposal_json === "string") {
      proposal = parseStoredProposal(row.job_proposal_json);
    } else if (row.job_proposal_json !== null) {
      throw new Error("Stored conversation proposal is invalid");
    }
    let selfImprovementProposal: ConversationSelfImprovementProposal | undefined;
    if (typeof row.self_improvement_proposal_json === "string") {
      selfImprovementProposal = parseStoredSelfImprovementProposal(row.self_improvement_proposal_json);
    } else if (row.self_improvement_proposal_json !== null) {
      throw new Error("Stored conversation self improvement proposal is invalid");
    }
    if (proposal !== undefined && selfImprovementProposal !== undefined) throw new Error("Stored conversation turn has conflicting proposals");
    const attachments = parseStoredAttachments(row.attachments_json);
    return {
      turnId: row.turn_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      channel: row.channel,
      text: row.input_text,
      attachments,
      status: row.status,
      ...(typeof row.pi_session_id === "string" ? { piSessionId: row.pi_session_id } : {}),
      ...(typeof row.assistant_reply === "string" ? { assistantReply: row.assistant_reply } : {}),
      ...(proposal === undefined ? {} : { jobProposal: proposal }),
      ...(selfImprovementProposal === undefined ? {} : { selfImprovementProposal }),
      ...(typeof row.job_id === "string" ? { jobId: row.job_id } : {}),
      ...(typeof row.scheduling_error === "string" ? { schedulingError: row.scheduling_error } : {}),
      ...(typeof row.error_code === "string" ? { errorCode: row.error_code } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #requireDatabase(): DatabaseSync {
    if (this.#database === undefined) throw new Error("Conversation registry is not open");
    return this.#database;
  }

  #transaction<T>(database: DatabaseSync, operation: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
}

export function validateJobProposal(proposal: ConversationJobProposal): void {
  if (!isRecord(proposal)) throw new Error("Job proposal must be an object");
  const keys = Object.keys(proposal).sort();
  const expected = ["operation", "prompt", "runnerSelector", "tool", "workspaceId"];
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) {
    throw new Error("Job proposal contains unsupported control fields");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proposal.workspaceId)) {
    throw new Error("Job proposal workspaceId is invalid");
  }
  if (!(["agent", "codex", "pi", "claude"] as const).includes(proposal.tool)) {
    throw new Error("Job proposal tool is invalid");
  }
  if (!(["develop", "diagnose", "review", "test"] as const).includes(proposal.operation)) {
    throw new Error("Job proposal operation is invalid");
  }
  requireBoundedText(proposal.prompt, "job proposal prompt", 16 * 1024);
  if (proposal.runnerSelector !== "auto") throw new Error("Job proposal must use automatic Runner selection");
}

export function validateSelfImprovementProposal(proposal: ConversationSelfImprovementProposal): void {
  if (!isRecord(proposal)) throw new Error("Self improvement proposal must be an object");
  const keys = Object.keys(proposal).sort();
  const expected = ["background", "category", "expectedBenefit", "prompt", "requestedActions", "riskSummary", "rollbackPlan", "runnerSelector", "title", "tool", "workspaceId"];
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) throw new Error("Self improvement proposal contains unsupported control fields");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proposal.workspaceId)) throw new Error("Self improvement proposal workspaceId is invalid");
  if (proposal.tool !== "codex" && proposal.tool !== "pi" && proposal.tool !== "claude") throw new Error("Self improvement proposal tool is invalid");
  requireBoundedText(proposal.prompt, "self improvement proposal prompt", 16 * 1024);
  if (proposal.runnerSelector !== "auto") throw new Error("Self improvement proposal must use automatic Runner selection");
  validateSelfImprovementContext(proposal);
}

function validateMessageInput(input: ConversationMessageInput): void {
  requireConversationId(input.conversationId);
  requireUuid(input.messageId, "messageId");
  if (!isChannel(input.channel)) throw new Error("Conversation channel is invalid");
  if (typeof input.text !== "string" || Buffer.byteLength(input.text, "utf8") > MAX_TEXT_BYTES || /\0/.test(input.text)) {
    throw new Error("message text is invalid");
  }
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 8) throw new Error("message attachments are invalid");
  for (const attachment of attachments) validateAttachment(attachment);
  if (input.text.trim() === "" && attachments.length === 0) throw new Error("message must contain text or media");
}

function messageDigest(input: ConversationMessageInput): string {
  return createHash("sha256").update(JSON.stringify({
    conversationId: input.conversationId,
    messageId: input.messageId,
    channel: input.channel,
    text: input.text,
    attachments: (input.attachments ?? []).map((attachment) => attachment.id),
  })).digest("hex");
}

function parseStoredAttachments(value: unknown): readonly ConversationMedia[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "string") throw new Error("Stored conversation attachments are invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Stored conversation attachments are invalid"); }
  if (!Array.isArray(parsed) || parsed.length > 8) throw new Error("Stored conversation attachments are invalid");
  return parsed.map((attachment) => {
    validateAttachment(attachment as ConversationMedia);
    return attachment as ConversationMedia;
  });
}

function validateAttachment(value: ConversationMedia): void {
  if (!isRecord(value)) throw new Error("message attachment is invalid");
  const expected = value.sourceMediaId === undefined
    ? ["expiresAt", "id", "kind", "mimeType", "role", "sha256", "sizeBytes"]
    : ["expiresAt", "id", "kind", "mimeType", "role", "sha256", "sizeBytes", "sourceMediaId"];
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expected.length || !keys.every((key, index) => key === expected[index]) ||
    typeof value.id !== "string" || !/^[a-f0-9]{32}$/.test(value.id) ||
    (value.kind !== "image" && value.kind !== "video") ||
    (value.role !== "attachment" && value.role !== "video_frame") ||
    typeof value.mimeType !== "string" ||
    !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 40 * 1_048_576 ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt)) ||
    (value.sourceMediaId !== undefined && !/^[a-f0-9]{32}$/.test(value.sourceMediaId))
  ) throw new Error("message attachment is invalid");
}

function parseStoredProposal(value: string): ConversationJobProposal {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Stored conversation proposal is invalid"); }
  validateJobProposal(parsed as ConversationJobProposal);
  return parsed as ConversationJobProposal;
}

function parseStoredSelfImprovementProposal(value: string): ConversationSelfImprovementProposal {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Stored conversation self improvement proposal is invalid"); }
  validateSelfImprovementProposal(parsed as ConversationSelfImprovementProposal);
  return parsed as ConversationSelfImprovementProposal;
}

function requireConversationId(value: string): void {
  if (!CONVERSATION_ID_PATTERN.test(value)) throw new Error("conversationId is invalid");
}

function requireUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`);
}

function requireBoundedText(value: string, name: string, maximumBytes: number): void {
  if (typeof value !== "string" || value.trim() === "" || Buffer.byteLength(value, "utf8") > maximumBytes || /\0/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
}

function isChannel(value: unknown): value is ConversationChannel {
  return value === "web" || value === "telegram" || value === "wechat_ilink" || value === "voice";
}

function isTurnStatus(value: unknown): value is ConversationTurnStatus {
  return value === "QUEUED" || value === "THINKING" || value === "REPLIED" || value === "JOB_PROPOSED" || value === "FAILED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
