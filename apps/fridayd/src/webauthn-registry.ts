import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

export interface WebAuthnConfig {
  readonly ownerId: string;
  readonly origin: string;
  readonly rpId: string;
}

export interface OwnerSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

/**
 * The Hub keeps only hashes of bootstrap/session values. Password and optional
 * Passkey login mint the same bounded browser session; the one-time Passkey
 * bootstrap remains separately protected by Owner automation auth.
 */
export class WebAuthnRegistry {
  readonly #databasePath: string;
  readonly #config: WebAuthnConfig;
  #database: DatabaseSync | undefined;

  constructor(databasePath: string, config: WebAuthnConfig) {
    this.#databasePath = databasePath;
    this.#config = config;
  }

  open(): void {
    if (this.#database !== undefined) throw new Error("WebAuthn registry is already open");
    const database = new DatabaseSync(this.#databasePath);
    this.#database = database;
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS webauthn_bootstrap_v1 (
          token_hash TEXT PRIMARY KEY, challenge TEXT, expires_at TEXT NOT NULL, consumed_at TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS webauthn_credentials_v1 (
          credential_id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
          transports_json TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS webauthn_login_v1 (
          challenge_hash TEXT PRIMARY KEY, challenge TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS owner_sessions_v1 (
          token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
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

  async issueBootstrap(now = Date.now()): Promise<{ readonly token: string; readonly expiresAt: string }> {
    const token = randomToken();
    const expiresAt = new Date(now + 10 * 60_000).toISOString();
    this.#requireDatabase().prepare("INSERT INTO webauthn_bootstrap_v1 (token_hash, challenge, expires_at, consumed_at) VALUES (?, NULL, ?, NULL)").run(hash(token), expiresAt);
    return { token, expiresAt };
  }

  async registrationOptions(token: string, now = Date.now()): Promise<unknown> {
    const row = this.#bootstrap(token, now);
    const credentials = this.#requireDatabase().prepare("SELECT credential_id AS credentialId, transports_json AS transportsJson FROM webauthn_credentials_v1").all() as Array<{ credentialId: string; transportsJson: string }>;
    const options = await generateRegistrationOptions({
      rpName: "Friday Agent",
      rpID: this.#config.rpId,
      userName: this.#config.ownerId,
      userID: new TextEncoder().encode(this.#config.ownerId),
      userDisplayName: this.#config.ownerId,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: credentials.map((credential) => ({ id: credential.credentialId, transports: JSON.parse(credential.transportsJson) as [] })),
    });
    this.#requireDatabase().prepare("UPDATE webauthn_bootstrap_v1 SET challenge = ? WHERE token_hash = ? AND consumed_at IS NULL").run(options.challenge, hash(token));
    return { bootstrapToken: token, options, expiresAt: row.expiresAt };
  }

  async verifyRegistration(token: string, response: RegistrationResponseJSON, now = Date.now()): Promise<void> {
    const row = this.#bootstrap(token, now);
    if (typeof row.challenge !== "string") throw new Error("Passkey registration options were not requested");
    const verified = await verifyRegistrationResponse({ response, expectedChallenge: row.challenge, expectedOrigin: this.#config.origin, expectedRPID: this.#config.rpId, requireUserVerification: true });
    if (!verified.verified || verified.registrationInfo === undefined) throw new Error("Passkey registration verification failed");
    const credential = verified.registrationInfo.credential;
    this.#transaction(() => {
      this.#requireDatabase().prepare("INSERT INTO webauthn_credentials_v1 (credential_id, public_key, counter, transports_json, created_at) VALUES (?, ?, ?, ?, ?)").run(credential.id, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), new Date(now).toISOString());
      this.#requireDatabase().prepare("UPDATE webauthn_bootstrap_v1 SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL").run(new Date(now).toISOString(), hash(token));
    });
  }

  async authenticationOptions(now = Date.now()): Promise<unknown> {
    const credentials = this.#requireDatabase().prepare("SELECT credential_id AS credentialId, transports_json AS transportsJson FROM webauthn_credentials_v1").all() as Array<{ credentialId: string; transportsJson: string }>;
    if (credentials.length === 0) throw new Error("No Owner passkey is registered");
    const options = await generateAuthenticationOptions({
      rpID: this.#config.rpId,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({ id: credential.credentialId, transports: JSON.parse(credential.transportsJson) as [] })),
    });
    const expiresAt = new Date(now + 5 * 60_000).toISOString();
    this.#requireDatabase().prepare("INSERT INTO webauthn_login_v1 (challenge_hash, challenge, expires_at, consumed_at) VALUES (?, ?, ?, NULL)").run(hash(options.challenge), options.challenge, expiresAt);
    return options;
  }

  async verifyAuthentication(response: AuthenticationResponseJSON, now = Date.now()): Promise<OwnerSession> {
    const credentialId = response.id;
    const credential = this.#requireDatabase().prepare("SELECT credential_id AS credentialId, public_key AS publicKey, counter, transports_json AS transportsJson FROM webauthn_credentials_v1 WHERE credential_id = ?").get(credentialId) as { credentialId: string; publicKey: Uint8Array; counter: number; transportsJson: string } | undefined;
    if (credential === undefined) throw new Error("Passkey authentication failed");
    const clientData = decodeClientData(response.response.clientDataJSON);
    const row = this.#requireDatabase().prepare("SELECT challenge, expires_at AS expiresAt, consumed_at AS consumedAt FROM webauthn_login_v1 WHERE challenge_hash = ?").get(hash(clientData.challenge)) as Record<string, unknown> | undefined;
    if (row === undefined || row.consumedAt !== null || typeof row.challenge !== "string" || row.challenge !== clientData.challenge || typeof row.expiresAt !== "string" || Date.parse(row.expiresAt) <= now) throw new Error("Passkey authentication failed");
    const verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: this.#config.origin,
      expectedRPID: this.#config.rpId,
      credential: { id: credential.credentialId, publicKey: new Uint8Array(credential.publicKey) as Uint8Array<ArrayBuffer>, counter: credential.counter, transports: JSON.parse(credential.transportsJson) as [] },
      requireUserVerification: true,
    });
    if (!verified.verified || verified.authenticationInfo === undefined) throw new Error("Passkey authentication failed");
    const session: OwnerSession = { token: randomToken(), csrfToken: randomToken(), expiresAt: new Date(now + 8 * 60 * 60_000).toISOString() };
    this.#transaction(() => {
      this.#requireDatabase().prepare("UPDATE webauthn_credentials_v1 SET counter = ? WHERE credential_id = ?").run(verified.authenticationInfo.newCounter, credential.credentialId);
      this.#requireDatabase().prepare("UPDATE webauthn_login_v1 SET consumed_at = ? WHERE challenge_hash = ? AND consumed_at IS NULL").run(new Date(now).toISOString(), hash(clientData.challenge));
      this.#requireDatabase().prepare("INSERT INTO owner_sessions_v1 (token_hash, csrf_hash, expires_at, revoked_at) VALUES (?, ?, ?, NULL)").run(hash(session.token), hash(session.csrfToken), session.expiresAt);
    });
    return session;
  }

  /** Password login and Passkey login mint the same bounded browser session. */
  issueSession(now = Date.now()): OwnerSession {
    const session: OwnerSession = { token: randomToken(), csrfToken: randomToken(), expiresAt: new Date(now + 8 * 60 * 60_000).toISOString() };
    this.#requireDatabase().prepare("INSERT INTO owner_sessions_v1 (token_hash, csrf_hash, expires_at, revoked_at) VALUES (?, ?, ?, NULL)")
      .run(hash(session.token), hash(session.csrfToken), session.expiresAt);
    return session;
  }

  credentialCount(): number {
    const row = this.#requireDatabase().prepare("SELECT count(*) AS count FROM webauthn_credentials_v1").get() as { count: number };
    return row.count;
  }

  validateSession(token: string | undefined, csrfToken: string | undefined, requireCsrf: boolean, now = Date.now()): boolean {
    if (!isToken(token) || (requireCsrf && !isToken(csrfToken))) return false;
    const row = this.#requireDatabase().prepare("SELECT csrf_hash AS csrfHash, expires_at AS expiresAt, revoked_at AS revokedAt FROM owner_sessions_v1 WHERE token_hash = ?").get(hash(token)) as Record<string, unknown> | undefined;
    if (row === undefined || row.revokedAt !== null || typeof row.expiresAt !== "string" || Date.parse(row.expiresAt) <= now || typeof row.csrfHash !== "string") return false;
    return !requireCsrf || row.csrfHash === hash(csrfToken as string);
  }

  revokeSession(token: string | undefined, now = Date.now()): void {
    if (!isToken(token)) return;
    this.#requireDatabase().prepare("UPDATE owner_sessions_v1 SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(new Date(now).toISOString(), hash(token));
  }

  #bootstrap(token: string, now: number): { expiresAt: string; challenge: unknown } {
    if (!isToken(token)) throw new Error("Bootstrap token is invalid");
    const row = this.#requireDatabase().prepare("SELECT challenge, expires_at AS expiresAt, consumed_at AS consumedAt FROM webauthn_bootstrap_v1 WHERE token_hash = ?").get(hash(token)) as Record<string, unknown> | undefined;
    if (row === undefined || row.consumedAt !== null || typeof row.expiresAt !== "string" || Date.parse(row.expiresAt) <= now) throw new Error("Bootstrap token is expired or consumed");
    return { expiresAt: row.expiresAt, challenge: row.challenge };
  }

  #requireDatabase(): DatabaseSync { if (this.#database === undefined) throw new Error("WebAuthn registry is not open"); return this.#database; }
  #transaction(operation: () => void): void { const database = this.#requireDatabase(); database.exec("BEGIN IMMEDIATE"); try { operation(); database.exec("COMMIT"); } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; } }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function randomToken(): string { return randomBytes(32).toString("base64url"); }
function isToken(value: string | undefined): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
function decodeClientData(value: string): { challenge: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).challenge !== "string") throw new Error();
    return { challenge: (parsed as { challenge: string }).challenge };
  } catch { throw new Error("Passkey authentication failed"); }
}
