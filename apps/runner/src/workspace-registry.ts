import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const WORKSPACE_REGISTRY_FILE = "workspaces.json";
export const MAX_REGISTERED_WORKSPACES = 256;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface RegisteredWorkspace {
  readonly workspaceId: string;
  /** Canonical filesystem root, never a user-supplied unchecked path. */
  readonly root: string;
  readonly registeredAt: string;
}

interface WorkspaceRegistryFile {
  readonly version: 1;
  readonly workspaces: readonly RegisteredWorkspace[];
}

/**
 * The Runner's local allow-list for source trees. This is intentionally not a
 * Hub-supplied manifest: a remote request may name only a locally registered
 * workspace id, never choose an arbitrary absolute path.
 */
export class RunnerWorkspaceRegistry {
  readonly #stateDir: string;
  readonly #stateFile: string;

  constructor(stateDir: string) {
    this.#stateDir = ensurePrivateStateDirectory(stateDir);
    this.#stateFile = resolve(this.#stateDir, WORKSPACE_REGISTRY_FILE);
  }

  list(): readonly RegisteredWorkspace[] {
    return readRegistry(this.#stateFile).workspaces;
  }

  get(workspaceId: string): RegisteredWorkspace | undefined {
    requireWorkspaceId(workspaceId);
    return this.list().find((workspace) => workspace.workspaceId === workspaceId);
  }

  register(workspaceId: string, root: string, now = new Date()): RegisteredWorkspace {
    requireWorkspaceId(workspaceId);
    if (typeof root !== "string" || root.trim() === "") {
      throw new Error("Workspace root must be a non-empty filesystem path");
    }
    if (Number.isNaN(now.getTime())) throw new Error("Workspace registration time must be valid");
    const canonicalRoot = canonicalDirectory(root, "Workspace root");
    if (containsPath(canonicalRoot, this.#stateDir) || containsPath(this.#stateDir, canonicalRoot)) {
      throw new Error("Workspace root and FRIDAY_RUNNER_STATE_DIR must not contain one another");
    }

    const registry = readRegistry(this.#stateFile);
    const existing = registry.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (existing !== undefined) {
      if (existing.root === canonicalRoot) return existing;
      throw new Error(`Workspace id ${workspaceId} is already registered to a different root`);
    }
    const duplicateRoot = registry.workspaces.find((workspace) => workspace.root === canonicalRoot);
    if (duplicateRoot !== undefined) {
      throw new Error(`Workspace root is already registered as ${duplicateRoot.workspaceId}`);
    }
    if (registry.workspaces.length >= MAX_REGISTERED_WORKSPACES) {
      throw new Error(`A Runner may register at most ${MAX_REGISTERED_WORKSPACES} workspaces`);
    }
    const workspace: RegisteredWorkspace = {
      workspaceId,
      root: canonicalRoot,
      registeredAt: now.toISOString(),
    };
    writeRegistry(this.#stateFile, {
      version: 1,
      workspaces: [...registry.workspaces, workspace],
    });
    return workspace;
  }

  unregister(workspaceId: string): boolean {
    requireWorkspaceId(workspaceId);
    const registry = readRegistry(this.#stateFile);
    const workspaces = registry.workspaces.filter((workspace) => workspace.workspaceId !== workspaceId);
    if (workspaces.length === registry.workspaces.length) return false;
    writeRegistry(this.#stateFile, { version: 1, workspaces });
    return true;
  }
}

export function requireWorkspaceId(workspaceId: string): string {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("Workspace id must contain only letters, numbers, dots, underscores, and dashes");
  }
  return workspaceId;
}

export function canonicalDirectory(path: string, label = "Path"): string {
  const candidate = resolve(path);
  let canonical: string;
  try {
    canonical = realpathSync.native(candidate);
  } catch (error) {
    throw new Error(`${label} must resolve to an existing directory`, { cause: error });
  }
  const stats = lstatSync(canonical);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must resolve to a real directory`);
  }
  return canonical;
}

function ensurePrivateStateDirectory(stateDir: string): string {
  if (typeof stateDir !== "string" || stateDir.trim() === "") {
    throw new Error("FRIDAY_RUNNER_STATE_DIR must not be empty");
  }
  const resolved = resolve(stateDir);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const canonical = realpathSync.native(resolved);
  const stats = lstatSync(canonical);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error("FRIDAY_RUNNER_STATE_DIR must be a non-symlink directory with mode 0700");
  }
  return canonical;
}

function readRegistry(stateFile: string): WorkspaceRegistryFile {
  try {
    const stats = lstatSync(stateFile);
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
      throw new Error(`${stateFile} must be a regular file with mode 0600`);
    }
    return parseRegistry(readFileSync(stateFile, "utf8"), stateFile);
  } catch (error) {
    if (isFileMissing(error)) return { version: 1, workspaces: [] };
    throw error;
  }
}

function parseRegistry(source: string, stateFile: string): WorkspaceRegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${stateFile} is not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
    throw new Error(`${stateFile} is not a workspace registry`);
  }
  if (!Object.keys(parsed).every((key) => key === "version" || key === "workspaces")) {
    throw new Error(`${stateFile} has unexpected workspace registry fields`);
  }
  const workspaceIds = new Set<string>();
  const roots = new Set<string>();
  const workspaces = parsed.workspaces.map((value): RegisteredWorkspace => {
    if (!isRecord(value) || Object.keys(value).length !== 3 || !Object.keys(value).every((key) => ["workspaceId", "root", "registeredAt"].includes(key))) {
      throw new Error(`${stateFile} has an invalid workspace record`);
    }
    if (typeof value.workspaceId !== "string" || typeof value.root !== "string" || typeof value.registeredAt !== "string") {
      throw new Error(`${stateFile} has an invalid workspace record`);
    }
    requireWorkspaceId(value.workspaceId);
    if (!isAbsolute(value.root) || Number.isNaN(Date.parse(value.registeredAt))) {
      throw new Error(`${stateFile} has an invalid workspace record`);
    }
    const canonicalRoot = canonicalDirectory(value.root, `${stateFile} workspace root`);
    if (canonicalRoot !== value.root || workspaceIds.has(value.workspaceId) || roots.has(value.root)) {
      throw new Error(`${stateFile} has duplicate or non-canonical workspace records`);
    }
    workspaceIds.add(value.workspaceId);
    roots.add(value.root);
    return { workspaceId: value.workspaceId, root: value.root, registeredAt: value.registeredAt };
  });
  return { version: 1, workspaces };
}

function writeRegistry(stateFile: string, registry: WorkspaceRegistryFile): void {
  const serialized = `${JSON.stringify(registry)}\n`;
  const stateDir = dirname(stateFile);
  const temporary = resolve(stateDir, `.${WORKSPACE_REGISTRY_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, stateFile);
    fsyncDirectory(stateDir);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Renaming succeeded or the temporary file was never created.
    }
    throw error;
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
