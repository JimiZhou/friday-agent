import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface HubIdentity {
  readonly algorithm: "ed25519";
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

const IDENTITY_FILE = "hub-identity.json";

/**
 * The Hub key is generated once inside the private state directory. Runners
 * pin its public half over the authenticated Tailnet HTTPS transport; only the
 * Hub can sign a dispatch manifest.
 */
export async function loadOrCreateHubIdentity(stateDir: string): Promise<HubIdentity> {
  const path = join(stateDir, IDENTITY_FILE);
  try {
    return parseIdentity(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync("ed25519");
  const identity: HubIdentity = {
    algorithm: "ed25519",
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
  const candidate = `${path}.candidate-${process.pid}-${Date.now()}`;
  try {
    await writeFile(candidate, `${JSON.stringify(identity)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(candidate, 0o600);
    await rename(candidate, path);
  } catch (error) {
    // A concurrent first boot may have won. Always read the published identity
    // rather than replacing it with a second signing key.
    try {
      return parseIdentity(await readFile(path, "utf8"));
    } catch {
      throw error;
    }
  }
  return identity;
}

function parseIdentity(raw: string): HubIdentity {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    value.algorithm !== "ed25519" ||
    typeof value.publicKeyPem !== "string" ||
    typeof value.privateKeyPem !== "string" ||
    value.publicKeyPem.length < 64 ||
    value.privateKeyPem.length < 64
  ) {
    throw new Error("Hub identity file is invalid");
  }
  return {
    algorithm: "ed25519",
    publicKeyPem: value.publicKeyPem,
    privateKeyPem: value.privateKeyPem,
  };
}
