import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  JOB_PROTOCOL_VERSION,
  canonicalJsonV2,
  jobManifestProjectionV2,
  type JobSpecV2,
} from "@friday/protocol";

export const HUB_IDENTITY_STATE_FILE = "hub-identity.json";

interface HubIdentityPin {
  readonly protocolVersion: typeof JOB_PROTOCOL_VERSION;
  readonly algorithm: "ed25519";
  readonly publicKeyPem: string;
}

/**
 * Trust-on-first-use happens only over the Runner's already-required HTTPS Hub
 * connection. A later key change fails closed and requires explicit local
 * operator intervention to rotate the pinned Hub identity.
 */
export function pinHubIdentity(stateDir: string, publicKeyPem: string): HubIdentityPin {
  const pin = validateHubIdentity({ protocolVersion: JOB_PROTOCOL_VERSION, algorithm: "ed25519", publicKeyPem });
  const path = join(stateDir, HUB_IDENTITY_STATE_FILE);
  try {
    const existing = validateHubIdentity(JSON.parse(readPrivateFile(path)) as unknown);
    if (existing.publicKeyPem !== pin.publicKeyPem) {
      throw new Error("Hub signing key changed; explicit Runner key rotation is required");
    }
    return existing;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = join(stateDir, `.${HUB_IDENTITY_STATE_FILE}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(pin)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    try { if (lstatSync(temporary).isFile()) unlinkSync(temporary); } catch {}
  }
  return pin;
}

export function verifyHubAssignment(spec: JobSpecV2, pinnedPublicKeyPem: string): void {
  if (spec.protocolVersion !== JOB_PROTOCOL_VERSION) throw new Error("Unsupported Hub Job protocol");
  const projection = jobManifestProjectionV2(spec);
  const manifestSha256 = createHash("sha256").update(canonicalJsonV2(projection)).digest("hex");
  if (manifestSha256 !== spec.manifestSha256) throw new Error("Hub Job manifest digest does not match");
  let publicKey: ReturnType<typeof createPublicKey>;
  try { publicKey = createPublicKey(pinnedPublicKeyPem); } catch { throw new Error("Pinned Hub public key is invalid"); }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Pinned Hub key must be Ed25519");
  if (!verify(null, Buffer.from(canonicalJsonV2(projection), "utf8"), publicKey, Buffer.from(spec.hubSignature, "base64url"))) {
    throw new Error("Hub Job signature is invalid");
  }
  if (Date.parse(spec.leaseExpiresAt) <= Date.now() || Date.parse(spec.expiresAt) <= Date.now()) {
    throw new Error("Hub Job lease is expired");
  }
  if (spec.network.mode !== "none" || spec.network.allowedHosts.length !== 0) {
    throw new Error("M1 Runner only accepts no-network Job manifests");
  }
}

function validateHubIdentity(value: unknown): HubIdentityPin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw missingIdentity();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.protocolVersion !== JOB_PROTOCOL_VERSION || record.algorithm !== "ed25519" || typeof record.publicKeyPem !== "string") throw new Error("Hub identity pin is invalid");
  try {
    if (createPublicKey(record.publicKeyPem).asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
  } catch { throw new Error("Hub identity pin is invalid"); }
  return { protocolVersion: JOB_PROTOCOL_VERSION, algorithm: "ed25519", publicKeyPem: record.publicKeyPem };
}

function readPrivateFile(path: string): string {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) throw new Error(`${path} must be a regular 0600 file`);
  return readFileSync(path, "utf8");
}
function missingIdentity(): Error { const error = new Error("Hub identity pin is missing") as NodeJS.ErrnoException; error.code = "ENOENT"; return error; }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
