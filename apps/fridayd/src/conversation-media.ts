import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MAX_CONVERSATION_IMAGE_BYTES = 10 * 1_048_576;
export const MAX_CONVERSATION_VIDEO_BYTES = 40 * 1_048_576;
export const MAX_CONVERSATION_ATTACHMENTS = 8;
export const MAX_MODEL_IMAGES = 6;
export const MAX_MODEL_IMAGE_BYTES = 10 * 1_048_576;

const MEDIA_ID_PATTERN = /^[a-f0-9]{32}$/;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

export type ConversationMediaKind = "image" | "video";
export type ConversationMediaRole = "attachment" | "video_frame";

export interface ConversationMedia {
  readonly id: string;
  readonly kind: ConversationMediaKind;
  readonly role: ConversationMediaRole;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly expiresAt: string;
  readonly sourceMediaId?: string;
}

interface StoredConversationMedia extends ConversationMedia {
  readonly path: string;
}

/**
 * Private, expiring image/video storage for Owner conversations. Media is
 * stored outside SQLite with 0600 permissions; SQLite retains only bounded
 * metadata and never accepts a caller-chosen path.
 */
export class ConversationMediaRegistry {
  readonly #databasePath: string;
  readonly #directory: string;
  #database: DatabaseSync | undefined;

  constructor(databasePath: string, directory: string) {
    this.#databasePath = databasePath;
    this.#directory = resolve(directory);
  }

  open(): void {
    if (this.#database !== undefined) throw new Error("Conversation media registry is already open");
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    chmodSync(this.#directory, 0o700);
    const stats = lstatSync(this.#directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
      throw new Error("Conversation media directory must be a private real directory");
    }
    const database = new DatabaseSync(this.#databasePath);
    this.#database = database;
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS conversation_media_v1 (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          role TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          path TEXT NOT NULL,
          source_media_id TEXT REFERENCES conversation_media_v1(id),
          expires_at TEXT NOT NULL,
          deleted_at TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS conversation_media_expiry_v1
          ON conversation_media_v1(expires_at) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS conversation_media_source_v1
          ON conversation_media_v1(source_media_id) WHERE deleted_at IS NULL;
      `);
      this.expire();
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

  save(bytes: Uint8Array, mimeType: string, ttlSeconds = 86_400, sourceMediaId?: string): ConversationMedia {
    const normalizedMimeType = mimeType.toLowerCase();
    const kind = mediaKind(normalizedMimeType);
    const maximum = kind === "image" ? MAX_CONVERSATION_IMAGE_BYTES : MAX_CONVERSATION_VIDEO_BYTES;
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > maximum ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 7 * 86_400 ||
      !matchesSignature(bytes, normalizedMimeType)
    ) {
      throw new Error("Conversation media is invalid");
    }

    let source: StoredConversationMedia | undefined;
    if (sourceMediaId !== undefined) {
      if (kind !== "image") throw new Error("Only image frames may reference a source video");
      source = this.#stored(sourceMediaId.toLowerCase());
      if (source === undefined || source.kind !== "video" || source.role !== "attachment") {
        throw new Error("Video frame source is unavailable");
      }
      const frameCount = this.#databaseRequired().prepare(
        "SELECT COUNT(*) AS count FROM conversation_media_v1 WHERE source_media_id = ? AND deleted_at IS NULL",
      ).get(source.id) as { count: number };
      if (!Number.isSafeInteger(frameCount.count) || frameCount.count >= MAX_MODEL_IMAGES) {
        throw new Error("Video has reached the representative-frame limit");
      }
    }

    const id = randomBytes(16).toString("hex");
    const path = join(this.#directory, `${id}.bin`);
    const expiresAt = new Date(Math.min(
      Date.now() + ttlSeconds * 1000,
      source === undefined ? Number.POSITIVE_INFINITY : Date.parse(source.expiresAt),
    )).toISOString();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    try {
      this.#databaseRequired().prepare(`
        INSERT INTO conversation_media_v1 (
          id, kind, role, mime_type, size_bytes, sha256, path,
          source_media_id, expires_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        id,
        kind,
        source === undefined ? "attachment" : "video_frame",
        normalizedMimeType,
        bytes.byteLength,
        sha256,
        path,
        source?.id ?? null,
        expiresAt,
      );
    } catch (error) {
      try { unlinkSync(path); } catch { /* Preserve the database failure. */ }
      throw error;
    }
    return {
      id,
      kind,
      role: source === undefined ? "attachment" : "video_frame",
      mimeType: normalizedMimeType,
      sizeBytes: bytes.byteLength,
      sha256,
      expiresAt,
      ...(source === undefined ? {} : { sourceMediaId: source.id }),
    };
  }

  resolve(ids: readonly string[]): readonly ConversationMedia[] {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_CONVERSATION_ATTACHMENTS) {
      throw new Error("Conversation media id list is invalid");
    }
    const normalized = ids.map((id) => requireMediaId(id));
    if (new Set(normalized).size !== normalized.length) throw new Error("Conversation media ids must be unique");
    const media = normalized.map((id) => {
      const stored = this.#stored(id);
      if (stored === undefined) throw new Error("Conversation media is unavailable or expired");
      return stripPath(stored);
    });
    const images = media.filter((item) => item.kind === "image");
    if (images.length > MAX_MODEL_IMAGES || images.reduce((total, item) => total + item.sizeBytes, 0) > MAX_MODEL_IMAGE_BYTES) {
      throw new Error("Conversation images exceed the model input limit");
    }
    for (const item of media) {
      if (item.role === "video_frame" && !media.some((candidate) => candidate.id === item.sourceMediaId)) {
        throw new Error("A representative frame must accompany its source video");
      }
    }
    return media;
  }

  read(id: string): { readonly media: ConversationMedia; readonly bytes: Buffer } | undefined {
    const stored = this.#stored(id.toLowerCase());
    if (stored === undefined) return undefined;
    try {
      const bytes = readFileSync(stored.path);
      if (
        bytes.byteLength !== stored.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== stored.sha256
      ) return undefined;
      return { media: stripPath(stored), bytes };
    } catch {
      return undefined;
    }
  }

  remove(id: string): boolean {
    const normalized = requireMediaId(id);
    const stored = this.#stored(normalized);
    if (stored === undefined) return false;
    const database = this.#databaseRequired();
    database.exec("BEGIN IMMEDIATE");
    try {
      const rows = database.prepare(`
        SELECT id, path FROM conversation_media_v1
        WHERE deleted_at IS NULL AND (id = ? OR source_media_id = ?)
      `).all(normalized, normalized) as { id: string; path: string }[];
      database.prepare(`
        UPDATE conversation_media_v1 SET deleted_at = ?
        WHERE deleted_at IS NULL AND (id = ? OR source_media_id = ?)
      `).run(new Date().toISOString(), normalized, normalized);
      database.exec("COMMIT");
      for (const row of rows) {
        try { unlinkSync(row.path); } catch { /* Metadata remains fail-closed. */ }
      }
      return rows.length > 0;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  expire(now = Date.now()): number {
    const rows = this.#databaseRequired().prepare(`
      SELECT id FROM conversation_media_v1
      WHERE deleted_at IS NULL AND expires_at <= ? AND source_media_id IS NULL
    `).all(new Date(now).toISOString()) as { id: string }[];
    for (const row of rows) this.remove(row.id);
    return rows.length;
  }

  #stored(id: string): StoredConversationMedia | undefined {
    if (!MEDIA_ID_PATTERN.test(id)) return undefined;
    const row = this.#databaseRequired().prepare(`
      SELECT id, kind, role, mime_type AS mimeType, size_bytes AS sizeBytes,
             sha256, path, source_media_id AS sourceMediaId, expires_at AS expiresAt
      FROM conversation_media_v1 WHERE id = ? AND deleted_at IS NULL
    `).get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const stored = parseStored(row);
    if (Date.parse(stored.expiresAt) <= Date.now()) {
      this.remove(stored.id);
      return undefined;
    }
    return stored;
  }

  #databaseRequired(): DatabaseSync {
    if (this.#database === undefined) throw new Error("Conversation media registry is not open");
    return this.#database;
  }
}

function mediaKind(mimeType: string): ConversationMediaKind {
  if (IMAGE_TYPES.has(mimeType)) return "image";
  if (VIDEO_TYPES.has(mimeType)) return "video";
  throw new Error("Conversation media type is not supported");
}

function matchesSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mimeType === "image/gif") return textPrefix(bytes, "GIF87a") || textPrefix(bytes, "GIF89a");
  if (mimeType === "image/webp") return textPrefix(bytes, "RIFF") && textAt(bytes, 8, "WEBP");
  if (mimeType === "video/webm") return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  if (mimeType === "video/mp4") return textAt(bytes, 4, "ftyp") && !textAt(bytes, 8, "qt  ");
  if (mimeType === "video/quicktime") return textAt(bytes, 4, "ftyp") && textAt(bytes, 8, "qt  ");
  return false;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function textPrefix(bytes: Uint8Array, value: string): boolean { return textAt(bytes, 0, value); }
function textAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false;
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function requireMediaId(value: string): string {
  if (typeof value !== "string" || !MEDIA_ID_PATTERN.test(value.toLowerCase())) throw new Error("Conversation media id is invalid");
  return value.toLowerCase();
}

function parseStored(row: Record<string, unknown>): StoredConversationMedia {
  if (
    typeof row.id !== "string" || !MEDIA_ID_PATTERN.test(row.id) ||
    (row.kind !== "image" && row.kind !== "video") ||
    (row.role !== "attachment" && row.role !== "video_frame") ||
    typeof row.mimeType !== "string" ||
    !Number.isSafeInteger(row.sizeBytes) ||
    typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) ||
    typeof row.path !== "string" ||
    typeof row.expiresAt !== "string" || Number.isNaN(Date.parse(row.expiresAt)) ||
    (row.sourceMediaId !== null && row.sourceMediaId !== undefined && (typeof row.sourceMediaId !== "string" || !MEDIA_ID_PATTERN.test(row.sourceMediaId)))
  ) throw new Error("Stored conversation media metadata is invalid");
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes as number,
    sha256: row.sha256,
    path: row.path,
    expiresAt: row.expiresAt,
    ...(typeof row.sourceMediaId === "string" ? { sourceMediaId: row.sourceMediaId } : {}),
  };
}

function stripPath(stored: StoredConversationMedia): ConversationMedia {
  return {
    id: stored.id,
    kind: stored.kind,
    role: stored.role,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    expiresAt: stored.expiresAt,
    ...(stored.sourceMediaId === undefined ? {} : { sourceMediaId: stored.sourceMediaId }),
  };
}
