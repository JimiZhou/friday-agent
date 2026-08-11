import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open as openFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";

export interface EventRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly recordedAt: string;
  readonly type: string;
  readonly payload: unknown;
  readonly previousHash: string | null;
  readonly hash: string;
}

/**
 * The durable event boundary used by fridayd. M0 used JsonlEventStore; M1
 * provides the same replay contract on top of SQLite WAL.
 */
export interface EventStore {
  open(): Promise<void>;
  close(): Promise<void>;
  list(afterSequence?: number): readonly EventRecord[];
  append(type: string, payload: unknown): Promise<EventRecord>;
}

type EventWithoutHash = Omit<EventRecord, "hash">;

interface LockRecord {
  lockId?: string;
  pid: number;
  openedAt: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface LockSnapshot {
  contents: string;
  identity: FileIdentity;
  record: LockRecord;
}

interface OwnedClaim {
  handle: FileHandle;
  lockId: string;
  path: string;
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

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isEventRecord(value: unknown): value is EventRecord {
  if (typeof value !== "object" || value === null || !hasExactKeys(value, EVENT_KEYS)) return false;
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

function parseLockRecord(contents: string): LockRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<LockRecord>;
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid ?? 0) < 1 || typeof candidate.openedAt !== "string") {
    return undefined;
  }
  if (candidate.lockId !== undefined && !UUID_PATTERN.test(candidate.lockId)) return undefined;
  return candidate as LockRecord;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function identityOf(handle: FileHandle): Promise<FileIdentity> {
  const stats = await handle.stat();
  return { dev: stats.dev, ino: stats.ino };
}

async function writeAll(handle: FileHandle, data: Buffer, position: number | null): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const result = await handle.write(
      data,
      offset,
      data.length - offset,
      position === null ? null : position + offset,
    );
    if (result.bytesWritten === 0) {
      const error = new Error("File write completed without making progress") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    offset += result.bytesWritten;
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  const handle = await openFile(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function readLockSnapshot(path: string): Promise<LockSnapshot | undefined> {
  let handle: FileHandle;
  try {
    handle = await openFile(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const [contents, identity] = await Promise.all([handle.readFile("utf8"), identityOf(handle)]);
    const record = parseLockRecord(contents);
    if (record === undefined) throw new Error(`Event store has an unreadable lock file: ${path}`);
    return { contents, identity, record };
  } finally {
    await handle.close();
  }
}

async function removeUniqueFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * The on-disk lock is published only after its contents are complete and synced.
 * A hard link provides the atomic create-if-absent operation without ever exposing
 * a partially initialized lock at the well-known path.
 */
async function publishLock(path: string, record: LockRecord): Promise<FileHandle | undefined> {
  const candidatePath = `${path}.candidate-${randomUUID()}`;
  const handle = await openFile(candidatePath, "wx+", 0o600);
  let published = false;
  try {
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    await writeAll(handle, encoded, 0);
    await handle.datasync();
    try {
      await link(candidatePath, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    }
    return handle;
  } finally {
    await removeUniqueFile(candidatePath);
    if (!published) await handle.close();
  }
}

export class JsonlEventStore {
  readonly #filePath: string;
  readonly #lockPath: string;
  #events: EventRecord[] = [];
  #writeBarrier: Promise<void> = Promise.resolve();
  #appendHandle: FileHandle | undefined;
  #lockHandle: FileHandle | undefined;
  #lockId: string | undefined;
  #unhealthyReason: Error | undefined;
  #closed = true;

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#lockPath = `${filePath}.lock`;
  }

  async open(): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    if (this.#lockHandle !== undefined || this.#appendHandle !== undefined) {
      throw new Error("Event store is already open");
    }

    await this.#acquireLock();
    this.#closed = false;
    this.#writeBarrier = Promise.resolve();
    this.#unhealthyReason = undefined;

    try {
      const handle = await openFile(this.#filePath, "a+", 0o600);
      this.#appendHandle = handle;
      await syncParentDirectory(this.#filePath);

      const contents = await handle.readFile();
      const lastNewline = contents.lastIndexOf(0x0a);
      const completeLength = contents.length === 0 ? 0 : lastNewline + 1;
      const hasPartialTail = completeLength < contents.length;
      const completeContents = contents.subarray(0, completeLength).toString("utf8");
      const events = this.#parseCompleteLines(completeContents);
      this.#verify(events);

      if (hasPartialTail) {
        await this.#quarantinePartialTail(handle, contents.subarray(completeLength), completeLength);
      }

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
    if (this.#closed || this.#appendHandle === undefined || this.#lockHandle === undefined) {
      throw new Error("Event store is not open");
    }
    if (this.#unhealthyReason !== undefined) throw this.#unhealthyError();

    let appended: EventRecord | undefined;
    const operation = this.#writeBarrier.then(async () => {
      if (this.#unhealthyReason !== undefined) throw this.#unhealthyError();
      const handle = this.#appendHandle;
      if (handle === undefined) throw new Error("Event store is not open");

      const previous = this.#events.at(-1);
      const rawWithoutHash: EventWithoutHash = {
        sequence: (previous?.sequence ?? 0) + 1,
        eventId: randomUUID(),
        recordedAt: new Date().toISOString(),
        type,
        payload,
        previousHash: previous?.hash ?? null,
      };

      // Normalize through JSON before writing so in-memory state exactly matches
      // the bytes covered by the hash and cannot alias the caller's payload.
      const normalizedWithoutHash = JSON.parse(JSON.stringify(rawWithoutHash)) as EventWithoutHash;
      const eventValue: unknown = {
        ...normalizedWithoutHash,
        hash: hashRecord(normalizedWithoutHash),
      };
      if (!isEventRecord(eventValue)) throw new Error("Event payload is not serializable as an EventRecord");
      const event = deepFreeze(eventValue);
      const encoded = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");

      try {
        await writeAll(handle, encoded, null);
        await handle.datasync();
      } catch (error) {
        this.#unhealthyReason = error instanceof Error ? error : new Error(String(error));
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
    if (this.#closed && this.#appendHandle === undefined && this.#lockHandle === undefined) return;
    this.#closed = true;
    await this.#writeBarrier;

    const appendHandle = this.#appendHandle;
    const lockHandle = this.#lockHandle;
    const lockId = this.#lockId;
    this.#appendHandle = undefined;
    this.#lockHandle = undefined;
    this.#lockId = undefined;

    let firstError: unknown;
    if (appendHandle !== undefined) {
      try {
        await appendHandle.close();
      } catch (error) {
        firstError = error;
      }
    }

    if (lockHandle !== undefined && lockId !== undefined) {
      try {
        await this.#releaseLock(lockHandle, lockId);
      } catch (error) {
        firstError ??= error;
      } finally {
        try {
          await lockHandle.close();
        } catch (error) {
          firstError ??= error;
        }
      }
    }

    if (firstError !== undefined) throw firstError;
  }

  async #acquireLock(): Promise<void> {
    const lockId = randomUUID();
    const record: LockRecord = { lockId, pid: process.pid, openedAt: new Date().toISOString() };

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const directHandle = await publishLock(this.#lockPath, record);
      if (directHandle !== undefined) {
        this.#lockHandle = directHandle;
        this.#lockId = lockId;
        return;
      }

      const existing = await readLockSnapshot(this.#lockPath);
      if (existing === undefined) continue;
      if (isProcessAlive(existing.record.pid)) {
        throw new Error(
          `Event store is locked by another fridayd instance (pid ${existing.record.pid}): ${this.#lockPath}`,
        );
      }

      const generation = existing.record.lockId ?? sha256(existing.contents);
      const claimPath = `${this.#lockPath}.takeover-${generation}`;

      // Prepare and sync the replacement before taking the generation claim,
      // keeping the crash window while holding that claim to a minimum.
      let replacementPath: string | undefined = `${this.#lockPath}.candidate-${randomUUID()}`;
      let replacementHandle: FileHandle | undefined = await openFile(replacementPath, "wx+", 0o600);
      try {
        const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
        await writeAll(replacementHandle, encoded, 0);
        await replacementHandle.datasync();
      } catch (error) {
        await replacementHandle.close();
        replacementHandle = undefined;
        await removeUniqueFile(replacementPath);
        replacementPath = undefined;
        throw error;
      }

      const claim = await this.#acquireTakeoverClaim(claimPath);
      if (claim === undefined) {
        await replacementHandle.close();
        await removeUniqueFile(replacementPath);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        continue;
      }

      let stalePinPath: string | undefined;
      try {
        const current = await readLockSnapshot(this.#lockPath);
        if (current === undefined || !sameIdentity(current.identity, existing.identity)) continue;
        if (isProcessAlive(current.record.pid)) continue;

        // Pin the stale inode under a unique name, then verify it once more.
        // We remove the well-known path only while holding this generation's
        // claim. A new owner is published with link(2), which never overwrites
        // a contender that may have won the brief path-absent window.
        stalePinPath = `${this.#lockPath}.stale-${generation}-${randomUUID()}`;
        await link(this.#lockPath, stalePinPath);
        const beforeRename = await readLockSnapshot(this.#lockPath);
        const pinned = await readLockSnapshot(stalePinPath);
        if (
          beforeRename === undefined ||
          pinned === undefined ||
          !sameIdentity(beforeRename.identity, existing.identity) ||
          !sameIdentity(pinned.identity, existing.identity)
        ) {
          continue;
        }

        await unlink(this.#lockPath);
        try {
          await link(replacementPath, this.#lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        await removeUniqueFile(replacementPath);
        replacementPath = undefined;
        await syncParentDirectory(this.#lockPath);

        this.#lockHandle = replacementHandle;
        this.#lockId = lockId;
        replacementHandle = undefined;
        return;
      } finally {
        if (replacementHandle !== undefined) await replacementHandle.close();
        if (replacementPath !== undefined) await removeUniqueFile(replacementPath);
        if (stalePinPath !== undefined) await removeUniqueFile(stalePinPath);
        try {
          await this.#releaseLock(claim.handle, claim.lockId, claim.path);
        } finally {
          await claim.handle.close();
        }
      }
    }

    throw new Error(`Could not acquire event store lock: ${this.#lockPath}`);
  }

  /**
   * A takeover claim can itself survive a crash. Never delete or replace such
   * a claim: if its process is dead, derive a deterministic successor path
   * from its immutable lock id and contend there. Concurrent recoverers choose
   * the same successor, while a live claim always stops takeover. A successful
   * main-lock generation change makes all stale ancestors irrelevant.
   */
  async #acquireTakeoverClaim(basePath: string): Promise<OwnedClaim | undefined> {
    let path = basePath;
    for (let depth = 0; depth < 64; depth += 1) {
      const lockId = randomUUID();
      const handle = await publishLock(path, {
        lockId,
        pid: process.pid,
        openedAt: new Date().toISOString(),
      });
      if (handle !== undefined) return { handle, lockId, path };

      const existing = await readLockSnapshot(path);
      if (existing === undefined) continue;
      if (isProcessAlive(existing.record.pid)) return undefined;

      const generation = existing.record.lockId ?? sha256(existing.contents);
      path = `${basePath}.successor-${sha256(`${path}\n${generation}`)}`;
    }

    throw new Error(`Takeover claim chain is too deep: ${basePath}`);
  }

  async #releaseLock(handle: FileHandle, lockId: string, path = this.#lockPath): Promise<void> {
    const [ownedIdentity, current] = await Promise.all([identityOf(handle), readLockSnapshot(path)]);
    if (current === undefined || current.record.lockId !== lockId || !sameIdentity(ownedIdentity, current.identity)) return;
    await unlink(path);
    await syncParentDirectory(path);
  }

  async #quarantinePartialTail(handle: FileHandle, tail: Buffer, completeLength: number): Promise<void> {
    const quarantinePath = `${this.#filePath}.quarantine-${Date.now()}-${randomUUID()}.partial`;
    const quarantineHandle = await openFile(quarantinePath, "wx", 0o600);
    let durable = false;
    try {
      await writeAll(quarantineHandle, tail, 0);
      await quarantineHandle.datasync();
      durable = true;
    } finally {
      await quarantineHandle.close();
      if (!durable) await removeUniqueFile(quarantinePath);
    }

    await syncParentDirectory(quarantinePath);
    await handle.truncate(completeLength);
    await handle.datasync();
  }

  #parseCompleteLines(contents: string): EventRecord[] {
    if (contents.length === 0) return [];
    const lines = contents.split("\n");
    lines.pop();
    return lines.map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid event JSON at line ${index + 1}`, { cause: error });
      }
      if (!isEventRecord(parsed)) throw new Error(`Invalid event record at line ${index + 1}`);
      return parsed;
    });
  }

  #unhealthyError(): Error {
    return new Error("Event store is unhealthy; close and reopen before appending", {
      cause: this.#unhealthyReason,
    });
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
}
