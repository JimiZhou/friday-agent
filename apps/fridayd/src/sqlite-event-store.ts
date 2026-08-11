import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  JsonlEventStore,
  type EventRecord,
  type EventStore,
} from "./event-store.js";

type EventWithoutHash = Omit<EventRecord, "hash">;

interface LockRow {
  lockId: string;
  pid: number;
  openedAt: string;
}

const EVENT_KEYS = [
  "eventId",
  "hash",
  "payload",
  "previousHash",
  "recordedAt",
  "sequence",
  "type",
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashRecord(record: EventWithoutHash): string {
  return sha256(JSON.stringify(record));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventRecord(value: unknown): value is EventRecord {
  if (!isRecord(value) || !hasExactKeys(value, EVENT_KEYS)) return false;
  const candidate = value as Partial<EventRecord>;
  return (
    Number.isSafeInteger(candidate.sequence) &&
    (candidate.sequence ?? 0) >= 1 &&
    typeof candidate.eventId === "string" &&
    UUID_PATTERN.test(candidate.eventId) &&
    typeof candidate.recordedAt === "string" &&
    !Number.isNaN(Date.parse(candidate.recordedAt)) &&
    typeof candidate.type === "string" &&
    candidate.type.length > 0 &&
    (candidate.previousHash === null ||
      (typeof candidate.previousHash === "string" && SHA256_PATTERN.test(candidate.previousHash))) &&
    typeof candidate.hash === "string" &&
    SHA256_PATTERN.test(candidate.hash)
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function databaseError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * M1's authoritative local EventStore. It keeps the M0 hash chain so a
 * corrupted row fails closed, while SQLite WAL supplies the atomic transaction
 * boundary required before durable Job and approval state is introduced.
 */
export class SqliteEventStore implements EventStore {
  readonly #databasePath: string;
  readonly #legacyJsonlPath: string;
  #database: DatabaseSync | undefined;
  #events: EventRecord[] = [];
  #writeBarrier: Promise<void> = Promise.resolve();
  #lockId: string | undefined;
  #unhealthyReason: Error | undefined;

  constructor(databasePath: string, legacyJsonlPath: string) {
    this.#databasePath = databasePath;
    this.#legacyJsonlPath = legacyJsonlPath;
  }

  async open(): Promise<void> {
    if (this.#database !== undefined) throw new Error("SQLite event store is already open");
    await mkdir(dirname(this.#databasePath), { recursive: true, mode: 0o700 });

    const database = new DatabaseSync(this.#databasePath);
    this.#database = database;
    this.#writeBarrier = Promise.resolve();
    this.#unhealthyReason = undefined;

    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      await chmod(this.#databasePath, 0o600);
      this.#createSchema(database);
      this.#assertIntegrity(database);
      this.#acquireInstanceLock(database);
      await this.#migrateLegacyJsonlIfNeeded(database);
      const events = this.#loadEvents(database);
      this.#verify(events);
      this.#events = events.map((event) => deepFreeze(event));
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  list(afterSequence = 0): readonly EventRecord[] {
    return this.#events.filter((event) => event.sequence > afterSequence);
  }

  async append(type: string, payload: unknown): Promise<EventRecord> {
    const database = this.#database;
    if (database === undefined) throw new Error("SQLite event store is not open");
    if (this.#unhealthyReason !== undefined) throw this.#unhealthyError();

    let appended: EventRecord | undefined;
    const operation = this.#writeBarrier.then(async () => {
      if (this.#unhealthyReason !== undefined) throw this.#unhealthyError();
      const previous = this.#events.at(-1);
      const rawWithoutHash: EventWithoutHash = {
        sequence: (previous?.sequence ?? 0) + 1,
        eventId: randomUUID(),
        recordedAt: new Date().toISOString(),
        type,
        payload,
        previousHash: previous?.hash ?? null,
      };

      // Match the M0 store: persist only the normalized JSON representation,
      // never a mutable reference supplied by the caller.
      const normalizedWithoutHash = JSON.parse(JSON.stringify(rawWithoutHash)) as EventWithoutHash;
      const candidate: unknown = {
        ...normalizedWithoutHash,
        hash: hashRecord(normalizedWithoutHash),
      };
      if (!isEventRecord(candidate)) throw new Error("Event payload is not serializable as an EventRecord");
      const event = deepFreeze(candidate);

      try {
        this.#withImmediateTransaction(database, () => {
          database.prepare(
            "INSERT INTO events (sequence, event_id, recorded_at, type, payload_json, previous_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            event.sequence,
            event.eventId,
            event.recordedAt,
            event.type,
            JSON.stringify(event.payload),
            event.previousHash,
            event.hash,
          );
        });
      } catch (error) {
        this.#unhealthyReason = databaseError(error);
        throw this.#unhealthyError();
      }

      this.#events.push(event);
      appended = event;
    });
    this.#writeBarrier = operation.then(
      () => undefined,
      () => undefined,
    );

    await operation;
    if (appended === undefined) throw new Error("Event append did not complete");
    return appended;
  }

  async close(): Promise<void> {
    const database = this.#database;
    if (database === undefined) return;

    await this.#writeBarrier;
    this.#database = undefined;
    const lockId = this.#lockId;
    this.#lockId = undefined;
    let firstError: unknown;

    if (lockId !== undefined) {
      try {
        this.#withImmediateTransaction(database, () => {
          database.prepare("DELETE FROM instance_lock WHERE id = 1 AND lock_id = ?").run(lockId);
        });
      } catch (error) {
        firstError = error;
      }
    }

    try {
      database.close();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  }

  #createSchema(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        recorded_at TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        previous_hash TEXT,
        hash TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS instance_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        lock_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        opened_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
  }

  #assertIntegrity(database: DatabaseSync): void {
    const rows = database.prepare("PRAGMA integrity_check").all() as unknown[];
    if (
      rows.length !== 1 ||
      !isRecord(rows[0]) ||
      Object.values(rows[0])[0] !== "ok"
    ) {
      throw new Error("SQLite integrity_check did not return ok");
    }
  }

  #acquireInstanceLock(database: DatabaseSync): void {
    const lockId = randomUUID();
    this.#withImmediateTransaction(database, () => {
      const row = database.prepare(
        "SELECT lock_id AS lockId, pid, opened_at AS openedAt FROM instance_lock WHERE id = 1",
      ).get() as unknown;
      if (row !== undefined) {
        const current = parseLockRow(row);
        if (isProcessAlive(current.pid)) {
          throw new Error(
            `SQLite event store is locked by another fridayd instance (pid ${current.pid}): ${this.#databasePath}`,
          );
        }
        database.prepare(
          "UPDATE instance_lock SET lock_id = ?, pid = ?, opened_at = ? WHERE id = 1",
        ).run(lockId, process.pid, new Date().toISOString());
        return;
      }
      database.prepare(
        "INSERT INTO instance_lock (id, lock_id, pid, opened_at) VALUES (1, ?, ?, ?)",
      ).run(lockId, process.pid, new Date().toISOString());
    });
    this.#lockId = lockId;
  }

  async #migrateLegacyJsonlIfNeeded(database: DatabaseSync): Promise<void> {
    const eventCount = database.prepare("SELECT COUNT(*) AS count FROM events").get() as unknown;
    const count = isRecord(eventCount) ? eventCount.count : undefined;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Could not read SQLite event count");
    }
    if (count > 0 || !(await pathExists(this.#legacyJsonlPath))) return;

    const legacy = new JsonlEventStore(this.#legacyJsonlPath);
    await legacy.open();
    let events: readonly EventRecord[];
    try {
      events = legacy.list();
    } finally {
      await legacy.close();
    }
    if (events.length === 0) return;

    this.#verify(events);
    this.#withImmediateTransaction(database, () => {
      for (const event of events) {
        database.prepare(
          "INSERT INTO events (sequence, event_id, recorded_at, type, payload_json, previous_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          event.sequence,
          event.eventId,
          event.recordedAt,
          event.type,
          JSON.stringify(event.payload),
          event.previousHash,
          event.hash,
        );
      }
      database.prepare(
        "INSERT INTO metadata (key, value) VALUES ('legacy_jsonl_migration', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify({ source: this.#legacyJsonlPath, eventCount: events.length }));
    });
  }

  #loadEvents(database: DatabaseSync): EventRecord[] {
    const rows = database.prepare(
      "SELECT sequence, event_id AS eventId, recorded_at AS recordedAt, type, payload_json AS payloadJson, previous_hash AS previousHash, hash FROM events ORDER BY sequence ASC",
    ).all() as unknown[];
    return rows.map((row) => parseEventRow(row));
  }

  #withImmediateTransaction<T>(database: DatabaseSync, operation: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original error is more useful and marks an append unhealthy.
      }
      throw error;
    }
  }

  #verify(events: readonly EventRecord[]): void {
    let expectedSequence = 1;
    let previousHash: string | null = null;
    for (const event of events) {
      if (event.sequence !== expectedSequence) {
        throw new Error(`Event sequence gap at ${event.sequence}`);
      }
      if (event.previousHash !== previousHash) {
        throw new Error(`Event hash chain mismatch at sequence ${event.sequence}`);
      }
      const { hash, ...withoutHash } = event;
      if (hashRecord(withoutHash) !== hash) {
        throw new Error(`Event content hash mismatch at sequence ${event.sequence}`);
      }
      expectedSequence += 1;
      previousHash = event.hash;
    }
  }

  #unhealthyError(): Error {
    return new Error("SQLite event store is unhealthy; close and reopen before appending", {
      cause: this.#unhealthyReason,
    });
  }
}

function parseLockRow(value: unknown): LockRow {
  const pid = isRecord(value) ? value.pid : undefined;
  if (
    !isRecord(value) ||
    typeof value.lockId !== "string" ||
    !UUID_PATTERN.test(value.lockId) ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    typeof value.openedAt !== "string" ||
    Number.isNaN(Date.parse(value.openedAt))
  ) {
    throw new Error("SQLite instance lock row is invalid");
  }
  return { lockId: value.lockId, pid, openedAt: value.openedAt };
}

function parseEventRow(value: unknown): EventRecord {
  if (!isRecord(value) || typeof value.payloadJson !== "string") {
    throw new Error("SQLite event row is invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(value.payloadJson) as unknown;
  } catch (error) {
    throw new Error("SQLite event payload is not valid JSON", { cause: error });
  }
  const event: unknown = {
    sequence: value.sequence,
    eventId: value.eventId,
    recordedAt: value.recordedAt,
    type: value.type,
    payload,
    previousHash: value.previousHash,
    hash: value.hash,
  };
  if (!isEventRecord(event)) throw new Error("SQLite event row does not match EventRecord");
  return event;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
