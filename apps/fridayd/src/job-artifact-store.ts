import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

export interface StoredJobArtifact {
  readonly artifactId: string;
  readonly jobId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly uri: string;
}

/** Owner-only Hub storage for bounded artifacts uploaded by the signed Runner. */
export class JobArtifactStore {
  readonly #root: string;
  constructor(stateDir: string) { this.#root = resolve(stateDir, "artifacts"); }

  async save(metadata: Omit<StoredJobArtifact, "uri">, bytes: Buffer): Promise<StoredJobArtifact> {
    validateMetadata(metadata);
    if (bytes.byteLength !== metadata.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new Error("Artifact digest or size does not match upload");
    const directory = join(this.#root, metadata.jobId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.#path(metadata.jobId, metadata.artifactId);
    try { lstatSync(target); throw new Error("Artifact id already exists"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    const temporary = join(directory, `.${metadata.artifactId}.${randomUUID()}.upload`);
    try { await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" }); await chmod(temporary, 0o600); await rename(temporary, target); } finally { await unlink(temporary).catch(() => {}); }
    return { ...metadata, uri: `hub://jobs/${metadata.jobId}/artifacts/${metadata.artifactId}` };
  }

  async read(jobId: string, artifactId: string): Promise<Buffer | undefined> {
    requireUuid(jobId, "job id"); requireUuid(artifactId, "artifact id");
    try { return await readFile(this.#path(jobId, artifactId)); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  }

  #path(jobId: string, artifactId: string): string {
    requireUuid(jobId, "job id"); requireUuid(artifactId, "artifact id");
    const path = resolve(this.#root, jobId, artifactId);
    if (!isDescendant(this.#root, path)) throw new Error("Artifact path escaped state directory");
    return path;
  }
}

function validateMetadata(value: Omit<StoredJobArtifact, "uri">): void {
  requireUuid(value.artifactId, "artifact id"); requireUuid(value.jobId, "job id");
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 255 || /[\\/\0]/.test(value.name)) throw new Error("Artifact name is invalid");
  if (typeof value.mediaType !== "string" || !MEDIA_TYPE.test(value.mediaType)) throw new Error("Artifact media type is invalid");
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new Error("Artifact hash is invalid");
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 16 * 1_048_576) throw new Error("Artifact size is invalid");
}
function requireUuid(value: string, label: string): void { if (typeof value !== "string" || !UUID.test(value)) throw new Error(`Artifact ${label} is invalid`); }
function isDescendant(parent: string, child: string): boolean { const path = relative(parent, child); return path !== "" && !path.startsWith("..") && !path.includes("../"); }
