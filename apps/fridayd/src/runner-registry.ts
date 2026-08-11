import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { runnerRequestSignaturePayload, runnerRequestSignaturePayloadV2 } from "@friday/protocol";

export const RUNNER_ENROLLMENT_TTL_MS = 10 * 60_000;

export interface RunnerEnrollment {
  readonly runnerId: string;
  readonly enrollmentToken: string;
  readonly expiresAt: string;
}

export type EnrollmentResult =
  | { readonly outcome: "enrolled"; readonly duplicate: false }
  | { readonly outcome: "enrolled"; readonly duplicate: true }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "expired" }
  | { readonly outcome: "consumed" }
  | { readonly outcome: "invalid_key" };

export type RevocationResult =
  | { readonly outcome: "revoked" }
  | { readonly outcome: "already_revoked" }
  | { readonly outcome: "not_found" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * A separate connection is intentional: the EventStore owns the process-wide
 * lock, while this registry keeps runner enrollment and device credentials in
 * the same WAL database without coupling protocol facts to EventStore code.
 */
export class SqliteRunnerRegistry {
  readonly #databasePath: string;
  #database: DatabaseSync | undefined;

  constructor(databasePath: string) {
    this.#databasePath = databasePath;
  }

  open(): void {
    if (this.#database !== undefined) throw new Error("Runner registry is already open");
    const database = new DatabaseSync(this.#databasePath);
    this.#database = database;
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS runner_enrollments (
          runner_id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          consumed_at TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS runner_devices (
          runner_id TEXT PRIMARY KEY,
          public_key_pem TEXT NOT NULL,
          enrolled_at TEXT NOT NULL,
          revoked_at TEXT
        ) STRICT;
      `);
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

  issueEnrollment(now = Date.now(), runnerId = randomUUID()): RunnerEnrollment {
    const database = this.#requireDatabase();
    if (!isUuid(runnerId)) throw new Error("Runner enrollment requires a UUID runner id");
    const enrollmentToken = randomBytes(32).toString("base64url");
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + RUNNER_ENROLLMENT_TTL_MS).toISOString();
    this.#transaction(database, () => {
      database.prepare(
        "INSERT INTO runner_enrollments (runner_id, token_hash, expires_at, created_at, consumed_at) VALUES (?, ?, ?, ?, NULL)",
      ).run(runnerId, sha256(enrollmentToken), expiresAt, createdAt);
    });
    return { runnerId, enrollmentToken, expiresAt };
  }

  consumeEnrollment(
    runnerId: string,
    enrollmentToken: string,
  publicKeyPem: string,
  now = Date.now(),
  ): EnrollmentResult {
    if (!isUuid(runnerId) || !isEnrollmentToken(enrollmentToken)) return { outcome: "invalid" };
    if (!isEd25519PublicKey(publicKeyPem)) return { outcome: "invalid_key" };
    const database = this.#requireDatabase();
    const tokenHash = sha256(enrollmentToken);
    return this.#transaction(database, () => {
      const row = database.prepare(
        "SELECT runner_id AS runnerId, token_hash AS tokenHash, expires_at AS expiresAt, consumed_at AS consumedAt FROM runner_enrollments WHERE runner_id = ?",
      ).get(runnerId) as unknown;
      if (!isRecord(row) || typeof row.tokenHash !== "string" || typeof row.expiresAt !== "string") {
        return { outcome: "invalid" };
      }
      if (!safeEqual(row.tokenHash, tokenHash)) return { outcome: "invalid" };

      const existingDevice = database.prepare(
        "SELECT public_key_pem AS publicKeyPem, revoked_at AS revokedAt FROM runner_devices WHERE runner_id = ?",
      ).get(runnerId) as unknown;
      if (row.consumedAt !== null && row.consumedAt !== undefined) {
        if (
          isRecord(existingDevice) &&
          existingDevice.revokedAt === null &&
          existingDevice.publicKeyPem === publicKeyPem
        ) {
          return { outcome: "enrolled", duplicate: true };
        }
        return { outcome: "consumed" };
      }
      if (Date.parse(row.expiresAt) <= now) return { outcome: "expired" };
      if (existingDevice !== undefined) return { outcome: "consumed" };

      const enrolledAt = new Date(now).toISOString();
      database.prepare(
        "INSERT INTO runner_devices (runner_id, public_key_pem, enrolled_at, revoked_at) VALUES (?, ?, ?, NULL)",
      ).run(runnerId, publicKeyPem, enrolledAt);
      database.prepare(
        "UPDATE runner_enrollments SET consumed_at = ? WHERE runner_id = ? AND consumed_at IS NULL",
      ).run(enrolledAt, runnerId);
      return { outcome: "enrolled", duplicate: false };
    });
  }

  verifyRequest(
    runnerId: string,
    signature: string | undefined,
    method: string,
    path: string,
    body: string,
  ): boolean {
    if (!isUuid(runnerId) || signature === undefined || !BASE64URL_PATTERN.test(signature)) return false;
    const database = this.#requireDatabase();
    const device = database.prepare(
      "SELECT public_key_pem AS publicKeyPem FROM runner_devices WHERE runner_id = ? AND revoked_at IS NULL",
    ).get(runnerId) as unknown;
    if (!isRecord(device) || typeof device.publicKeyPem !== "string") return false;
    return this.#verify(device.publicKeyPem, signature, runnerRequestSignaturePayload(method, path, body));
  }

  verifyRequestV2(
    runnerId: string,
    signature: string | undefined,
    method: string,
    path: string,
    body: string,
  ): boolean {
    if (!isUuid(runnerId) || signature === undefined || !BASE64URL_PATTERN.test(signature)) return false;
    const device = this.#requireDatabase().prepare(
      "SELECT public_key_pem AS publicKeyPem FROM runner_devices WHERE runner_id = ? AND revoked_at IS NULL",
    ).get(runnerId) as unknown;
    if (!isRecord(device) || typeof device.publicKeyPem !== "string") return false;
    return this.#verify(device.publicKeyPem, signature, runnerRequestSignaturePayloadV2(method, path, body));
  }

  revokeDevice(runnerId: string, now = Date.now()): RevocationResult {
    if (!isUuid(runnerId)) return { outcome: "not_found" };
    const database = this.#requireDatabase();
    return this.#transaction(database, () => {
      const device = database.prepare(
        "SELECT revoked_at AS revokedAt FROM runner_devices WHERE runner_id = ?",
      ).get(runnerId) as unknown;
      if (!isRecord(device)) return { outcome: "not_found" };
      if (device.revokedAt !== null && device.revokedAt !== undefined) return { outcome: "already_revoked" };
      database.prepare("UPDATE runner_devices SET revoked_at = ? WHERE runner_id = ? AND revoked_at IS NULL").run(
        new Date(now).toISOString(),
        runnerId,
      );
      return { outcome: "revoked" };
    });
  }

  /** Owner-side compatibility checks never create or revive Runner identities. */
  isEnrolled(runnerId: string): boolean {
    if (!isUuid(runnerId)) return false;
    const row = this.#requireDatabase().prepare(
      "SELECT 1 AS enrolled FROM runner_devices WHERE runner_id = ? AND revoked_at IS NULL",
    ).get(runnerId) as { enrolled?: unknown } | undefined;
    return row?.enrolled === 1;
  }

  #requireDatabase(): DatabaseSync {
    if (this.#database === undefined) throw new Error("Runner registry is not open");
    return this.#database;
  }

  #verify(publicKeyPem: string, signature: string, payload: string): boolean {
    try {
      return verify(null, Buffer.from(payload, "utf8"), publicKeyPem, Buffer.from(signature, "base64url"));
    } catch {
      return false;
    }
  }

  #transaction<T>(database: DatabaseSync, operation: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isEnrollmentToken(value: string): boolean {
  return value.length === 43 && BASE64URL_PATTERN.test(value);
}

function isEd25519PublicKey(value: string): boolean {
  if (value.length < 64 || value.length > 2048) return false;
  try {
    return createPublicKey(value).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
