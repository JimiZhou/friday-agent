import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface Budget {
  readonly networkRequests: number;
  readonly fileBytes: number;
  readonly secretRefs: number;
  readonly timeoutSeconds: number;
}

export interface McpDefinition {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly schemaSha256: string;
  readonly budget: Budget;
}

export interface McpInvocation {
  readonly name: string;
  readonly input: string;
  readonly networkRequests: number;
  readonly fileBytes: number;
  readonly secretRefs: number;
  readonly elapsedSeconds: number;
}

export interface UntrustedMcpResult {
  readonly trust: "untrusted";
  readonly text: string;
  readonly truncated: boolean;
  readonly source: string;
  readonly schemaSha256: string;
}

/**
 * A registry is deliberately not an MCP client.  Installing a definition only
 * pins metadata; enabling it is a separate Owner action.  A stopped or absent
 * broker therefore cannot affect the M1 execution path.
 */
export class McpRegistry {
  #db: DatabaseSync | undefined;
  constructor(readonly path: string) {}

  open(): void {
    this.#db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS mcp_registry_v1 (
        name TEXT PRIMARY KEY, version TEXT NOT NULL, source TEXT NOT NULL,
        schema_sha256 TEXT NOT NULL, budget_json TEXT NOT NULL,
        enabled INTEGER NOT NULL, created_at TEXT NOT NULL
      ) STRICT;`);
  }

  close(): void { this.#db?.close(); this.#db = undefined; }

  register(definition: McpDefinition): void {
    validateMcp(definition);
    this.db.prepare(`INSERT INTO mcp_registry_v1 VALUES(?,?,?,?,?,0,?)
      ON CONFLICT(name) DO UPDATE SET version=excluded.version,source=excluded.source,
      schema_sha256=excluded.schema_sha256,budget_json=excluded.budget_json,
      enabled=0,created_at=excluded.created_at`).run(
      definition.name, definition.version, definition.source, definition.schemaSha256,
      JSON.stringify(definition.budget), new Date().toISOString(),
    );
  }

  enable(name: string): void {
    requireName(name, "MCP name");
    if (this.db.prepare("UPDATE mcp_registry_v1 SET enabled=1 WHERE name=?").run(name).changes !== 1) {
      throw new Error("MCP is not registered");
    }
  }

  disable(name: string): void {
    requireName(name, "MCP name");
    if (this.db.prepare("UPDATE mcp_registry_v1 SET enabled=0 WHERE name=?").run(name).changes !== 1) {
      throw new Error("MCP is not registered");
    }
  }

  resolve(name: string): McpDefinition | undefined {
    const row = this.db.prepare(`SELECT name,version,source,schema_sha256 AS schemaSha256,
      budget_json AS budgetJson,enabled FROM mcp_registry_v1 WHERE name=?`).get(name) as Record<string, unknown> | undefined;
    if (row === undefined || row.enabled !== 1) return undefined;
    const definition = {
      name: row.name as string, version: row.version as string, source: row.source as string,
      schemaSha256: row.schemaSha256 as string, budget: JSON.parse(row.budgetJson as string) as Budget,
    };
    validateMcp(definition);
    return definition;
  }

  list(): readonly (McpDefinition & { readonly enabled: boolean })[] {
    return (this.db.prepare(`SELECT name,version,source,schema_sha256 AS schemaSha256,
      budget_json AS budgetJson,enabled FROM mcp_registry_v1 ORDER BY name`).all() as Record<string, unknown>[]).map((row) => {
      const definition = { name: row.name as string, version: row.version as string, source: row.source as string,
        schemaSha256: row.schemaSha256 as string, budget: JSON.parse(row.budgetJson as string) as Budget };
      validateMcp(definition);
      return { ...definition, enabled: row.enabled === 1 };
    });
  }

  get db(): DatabaseSync { if (this.#db === undefined) throw new Error("MCP registry is not open"); return this.#db; }
}

/**
 * The broker accepts an injected, already-isolated transport. Friday never
 * passes environment variables or secret values to it. The transport receives
 * the pinned definition and a plain request only; metadata budgets are checked
 * again on its returned accounting record.
 */
export class McpBroker {
  constructor(readonly registry: McpRegistry) {}

  async invoke(
    invocation: McpInvocation,
    transport: (definition: McpDefinition, input: string) => Promise<{ readonly output: string; readonly usage: Omit<McpInvocation, "name" | "input"> }>,
  ): Promise<UntrustedMcpResult> {
    const definition = this.registry.resolve(invocation.name);
    if (definition === undefined) throw new Error("MCP is disabled or not registered");
    requireText(invocation.input, "MCP input", 64 * 1024);
    validateUsage(invocation, definition.budget);
    const result = await transport(definition, invocation.input);
    if (typeof result.output !== "string") throw new Error("MCP transport returned invalid output");
    validateUsage(result.usage, definition.budget);
    if (Buffer.byteLength(result.output, "utf8") > definition.budget.fileBytes) throw new Error("MCP output exceeds budget");
    const output = untrustedMcpOutput(result.output, Math.max(1, Math.min(definition.budget.fileBytes, 1_048_576)));
    return { ...output, source: definition.source, schemaSha256: definition.schemaSha256 };
  }
}

/**
 * Minimal Streamable-HTTP MCP client for a single `tools/call` invocation.
 * It deliberately has no Secret API, inherited environment, cookies, or
 * redirect following. The registry supplies the only allowed endpoint.
 */
export async function invokeStreamableHttpMcp(
  definition: McpDefinition,
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly output: string; readonly usage: Omit<McpInvocation, "name" | "input"> }> {
  const startedAt = Date.now();
  const endpoint = new URL(definition.source);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "friday", method: "tools/call", params: { name: definition.name, arguments: { input } } }),
    signal: AbortSignal.timeout(definition.budget.timeoutSeconds * 1000),
  });
  if (!response.ok) throw new Error(`MCP transport rejected request (${response.status})`);
  const body = await response.json() as unknown;
  const output = readMcpOutput(body);
  return { output, usage: { networkRequests: 1, fileBytes: Buffer.byteLength(output, "utf8"), secretRefs: 0, elapsedSeconds: Math.ceil((Date.now() - startedAt) / 1000) } };
}

export function untrustedMcpOutput(value: string, maxBytes: number): { readonly trust: "untrusted"; readonly text: string; readonly truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) throw new Error("Invalid output budget");
  const bytes = Buffer.from(value, "utf8");
  return { trust: "untrusted", text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: bytes.length > maxBytes };
}

export interface SignedProcedure {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly manifestSha256: string;
  readonly signature: string;
}

export type SandboxAdapter = "remote-agent" | "codex-app-server" | "pi-rpc" | "claude-code";
export interface AdapterDefinition { readonly runnerId: string; readonly adapter: SandboxAdapter; readonly image: string; readonly imageId: string; }
/**
 * A runner/adapter pair must first be pinned and enabled by the Owner. The
 * deterministic fleet scheduler may then select only from those pre-authorized
 * pairs; this registry still grants no execution authority by itself.
 */
export class AdapterRegistry {
  #db: DatabaseSync | undefined;
  constructor(readonly path: string) {}
  open(): void { this.#db = new DatabaseSync(this.path); this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS adapter_registry_v1 (runner_id TEXT NOT NULL,adapter TEXT NOT NULL,image TEXT NOT NULL,image_id TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(runner_id,adapter)) STRICT;`); }
  close(): void { this.#db?.close(); this.#db = undefined; }
  register(definition: AdapterDefinition): void { validateAdapter(definition); this.db.prepare(`INSERT INTO adapter_registry_v1 VALUES(?,?,?,?,0,?) ON CONFLICT(runner_id,adapter) DO UPDATE SET image=excluded.image,image_id=excluded.image_id,enabled=0,created_at=excluded.created_at`).run(definition.runnerId, definition.adapter, definition.image, definition.imageId, new Date().toISOString()); }
  enable(runnerId: string, adapter: SandboxAdapter): void { validateAdapterName(adapter); if (this.db.prepare("UPDATE adapter_registry_v1 SET enabled=1 WHERE runner_id=? AND adapter=?").run(runnerId, adapter).changes !== 1) throw new Error("Runner adapter is not registered"); }
  disable(runnerId: string, adapter: SandboxAdapter): void { validateAdapterName(adapter); if (this.db.prepare("UPDATE adapter_registry_v1 SET enabled=0 WHERE runner_id=? AND adapter=?").run(runnerId, adapter).changes !== 1) throw new Error("Runner adapter is not registered"); }
  resolve(runnerId: string, adapter: SandboxAdapter): AdapterDefinition | undefined { validateAdapterName(adapter); const row = this.db.prepare("SELECT runner_id AS runnerId,adapter,image,image_id AS imageId,enabled FROM adapter_registry_v1 WHERE runner_id=? AND adapter=?").get(runnerId, adapter) as Record<string, unknown> | undefined; if (row === undefined || row.enabled !== 1) return undefined; return { runnerId: row.runnerId as string, adapter: row.adapter as SandboxAdapter, image: row.image as string, imageId: row.imageId as string }; }
  list(runnerId?: string): readonly (AdapterDefinition & { readonly enabled: boolean })[] { const rows = (runnerId === undefined ? this.db.prepare("SELECT runner_id AS runnerId,adapter,image,image_id AS imageId,enabled FROM adapter_registry_v1 ORDER BY runner_id,adapter").all() : this.db.prepare("SELECT runner_id AS runnerId,adapter,image,image_id AS imageId,enabled FROM adapter_registry_v1 WHERE runner_id=? ORDER BY adapter").all(runnerId)) as Record<string, unknown>[]; return rows.map((row) => ({ runnerId: row.runnerId as string, adapter: row.adapter as SandboxAdapter, image: row.image as string, imageId: row.imageId as string, enabled: row.enabled === 1 })); }
  get db(): DatabaseSync { if (this.#db === undefined) throw new Error("Adapter registry is not open"); return this.#db; }
}

export interface ProcedureView {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly manifestSha256: string;
  readonly enabled: boolean;
  readonly sandboxVerified: boolean;
}

/** Procedures remain disabled until the exact signed manifest was replayed in a sandbox. */
export class ProcedureRegistry {
  #db: DatabaseSync | undefined;
  constructor(readonly path: string, readonly ownerPublicKeyPem: string) {}

  open(): void {
    const key = createPublicKey(this.ownerPublicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Owner procedure key must be Ed25519");
    this.#db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS procedure_versions_v2 (
        id TEXT NOT NULL, version TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
        signature TEXT NOT NULL, capabilities_json TEXT NOT NULL, sandbox_verified INTEGER NOT NULL,
        verification_evidence_sha256 TEXT, created_at TEXT NOT NULL, PRIMARY KEY(id,version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS procedure_active_v2 (
        id TEXT PRIMARY KEY, version TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;`);
  }

  close(): void { this.#db?.close(); this.#db = undefined; }

  register(procedure: SignedProcedure): void {
    validateProcedure(procedure);
    if (!verify(null, Buffer.from(procedurePayload(procedure), "utf8"), this.ownerPublicKeyPem, Buffer.from(procedure.signature, "base64url"))) {
      throw new Error("Owner procedure signature is invalid");
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO procedure_versions_v2 VALUES(?,?,?,?,?,0,NULL,?)
      ON CONFLICT(id,version) DO UPDATE SET manifest_sha256=excluded.manifest_sha256,
      signature=excluded.signature,capabilities_json=excluded.capabilities_json,sandbox_verified=0,
      verification_evidence_sha256=NULL,created_at=excluded.created_at`).run(
      procedure.id, procedure.version, procedure.manifestSha256, procedure.signature,
      JSON.stringify([...procedure.capabilities].sort()), now,
    );
    this.db.prepare(`INSERT INTO procedure_active_v2 VALUES(?,?,0,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,enabled=0,updated_at=excluded.updated_at`).run(procedure.id, procedure.version, now);
  }

  markSandboxVerified(id: string, version: string, evidenceSha256: string): void {
    requireName(id, "Procedure id"); requireVersion(version); requireSha(evidenceSha256, "Verification evidence hash");
    if (this.db.prepare(`UPDATE procedure_versions_v2 SET sandbox_verified=1,verification_evidence_sha256=?
      WHERE id=? AND version=?`).run(evidenceSha256, id, version).changes !== 1) throw new Error("Procedure version is not registered");
  }

  enable(id: string): void {
    requireName(id, "Procedure id");
    const active = this.active(id);
    if (active === undefined) throw new Error("Procedure not registered");
    if (!active.sandboxVerified) throw new Error("Procedure requires sandbox replay verification before enable");
    this.db.prepare("UPDATE procedure_active_v2 SET enabled=1,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
  }

  rollback(id: string): void {
    requireName(id, "Procedure id");
    const current = this.active(id);
    if (current === undefined) throw new Error("Procedure not registered");
    const previous = this.db.prepare(`SELECT version,manifest_sha256 AS manifestSha256,capabilities_json AS capabilitiesJson,
      sandbox_verified AS sandboxVerified FROM procedure_versions_v2 WHERE id=? AND version<>?
      ORDER BY created_at DESC LIMIT 1`).get(id, current.version) as Record<string, unknown> | undefined;
    if (previous === undefined || previous.sandboxVerified !== 1) throw new Error("No sandbox-verified procedure rollback exists");
    this.db.prepare("UPDATE procedure_active_v2 SET version=?,enabled=1,updated_at=? WHERE id=?").run(previous.version as string, new Date().toISOString(), id);
  }

  active(id: string): ProcedureView | undefined {
    const row = this.db.prepare(`SELECT a.id,a.version,a.enabled,v.manifest_sha256 AS manifestSha256,
      v.capabilities_json AS capabilitiesJson,v.sandbox_verified AS sandboxVerified
      FROM procedure_active_v2 a JOIN procedure_versions_v2 v ON a.id=v.id AND a.version=v.version WHERE a.id=?`).get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return { id: row.id as string, version: row.version as string, manifestSha256: row.manifestSha256 as string,
      capabilities: JSON.parse(row.capabilitiesJson as string) as readonly string[], enabled: row.enabled === 1, sandboxVerified: row.sandboxVerified === 1 };
  }

  list(): readonly ProcedureView[] {
    return (this.db.prepare("SELECT id FROM procedure_active_v2 ORDER BY id").all() as { id: string }[]).flatMap((row) => {
      const value = this.active(row.id); return value === undefined ? [] : [value];
    });
  }

  get db(): DatabaseSync { if (this.#db === undefined) throw new Error("Procedure registry is not open"); return this.#db; }
}

export function procedurePayload(procedure: Omit<SignedProcedure, "signature">): string {
  return JSON.stringify({ capabilities: [...procedure.capabilities].sort(), id: procedure.id, manifestSha256: procedure.manifestSha256, version: procedure.version });
}

export interface SignedSkill {
  readonly id: string;
  readonly version: string;
  /** Immutable HTTPS source selected by the Owner, never a model-provided URL. */
  readonly source: string;
  readonly contentSha256: string;
  readonly capabilities: readonly string[];
  readonly signature: string;
}

export interface SkillView {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly contentSha256: string;
  readonly capabilities: readonly string[];
  readonly enabled: boolean;
  readonly sandboxVerified: boolean;
}

/**
 * Skills are signed, inert metadata.  This registry has no installer, package
 * manager, or host execution path: enabling a Skill only permits a separately
 * reviewed Runner/Sandbox procedure to reference its pinned content digest.
 */
export class SkillRegistry {
  #db: DatabaseSync | undefined;
  constructor(readonly path: string, readonly ownerPublicKeyPem: string) {}

  open(): void {
    const key = createPublicKey(this.ownerPublicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Owner skill key must be Ed25519");
    this.#db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS skill_versions_v1 (
        id TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL, content_sha256 TEXT NOT NULL,
        signature TEXT NOT NULL, capabilities_json TEXT NOT NULL, sandbox_verified INTEGER NOT NULL,
        verification_evidence_sha256 TEXT, created_at TEXT NOT NULL, PRIMARY KEY(id,version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS skill_active_v1 (
        id TEXT PRIMARY KEY, version TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;`);
  }

  close(): void { this.#db?.close(); this.#db = undefined; }

  register(skill: SignedSkill): void {
    validateSkill(skill);
    if (!verify(null, Buffer.from(skillPayload(skill), "utf8"), this.ownerPublicKeyPem, Buffer.from(skill.signature, "base64url"))) throw new Error("Owner skill signature is invalid");
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO skill_versions_v1 VALUES(?,?,?,?,?,?,0,NULL,?)
      ON CONFLICT(id,version) DO UPDATE SET source=excluded.source,content_sha256=excluded.content_sha256,
      signature=excluded.signature,capabilities_json=excluded.capabilities_json,sandbox_verified=0,
      verification_evidence_sha256=NULL,created_at=excluded.created_at`).run(
      skill.id, skill.version, skill.source, skill.contentSha256, skill.signature,
      JSON.stringify([...skill.capabilities].sort()), now,
    );
    this.db.prepare(`INSERT INTO skill_active_v1 VALUES(?,?,0,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,enabled=0,updated_at=excluded.updated_at`).run(skill.id, skill.version, now);
  }

  markSandboxVerified(id: string, version: string, evidenceSha256: string): void {
    requireName(id, "Skill id"); requireVersion(version); requireSha(evidenceSha256, "Verification evidence hash");
    if (this.db.prepare("UPDATE skill_versions_v1 SET sandbox_verified=1,verification_evidence_sha256=? WHERE id=? AND version=?").run(evidenceSha256, id, version).changes !== 1) throw new Error("Skill version is not registered");
  }

  enable(id: string): void {
    requireName(id, "Skill id");
    const active = this.active(id);
    if (active === undefined) throw new Error("Skill not registered");
    if (!active.sandboxVerified) throw new Error("Skill requires sandbox replay verification before enable");
    this.db.prepare("UPDATE skill_active_v1 SET enabled=1,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
  }

  rollback(id: string): void {
    requireName(id, "Skill id");
    const current = this.active(id);
    if (current === undefined) throw new Error("Skill not registered");
    const previous = this.db.prepare(`SELECT version,source,content_sha256 AS contentSha256,capabilities_json AS capabilitiesJson,sandbox_verified AS sandboxVerified
      FROM skill_versions_v1 WHERE id=? AND version<>? ORDER BY created_at DESC LIMIT 1`).get(id, current.version) as Record<string, unknown> | undefined;
    if (previous === undefined || previous.sandboxVerified !== 1) throw new Error("No sandbox-verified skill rollback exists");
    this.db.prepare("UPDATE skill_active_v1 SET version=?,enabled=1,updated_at=? WHERE id=?").run(previous.version as string, new Date().toISOString(), id);
  }

  active(id: string): SkillView | undefined {
    const row = this.db.prepare(`SELECT a.id,a.version,a.enabled,v.source,v.content_sha256 AS contentSha256,v.capabilities_json AS capabilitiesJson,v.sandbox_verified AS sandboxVerified
      FROM skill_active_v1 a JOIN skill_versions_v1 v ON a.id=v.id AND a.version=v.version WHERE a.id=?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : skillView(row);
  }

  list(): readonly SkillView[] { return (this.db.prepare("SELECT id FROM skill_active_v1 ORDER BY id").all() as { id: string }[]).flatMap((row) => { const skill = this.active(row.id); return skill === undefined ? [] : [skill]; }); }
  get db(): DatabaseSync { if (this.#db === undefined) throw new Error("Skill registry is not open"); return this.#db; }
}

export function skillPayload(skill: Omit<SignedSkill, "signature">): string {
  return JSON.stringify({ capabilities: [...skill.capabilities].sort(), contentSha256: skill.contentSha256, id: skill.id, source: skill.source, version: skill.version });
}

export type SelfPatchState = "DRAFT" | "TESTED" | "WAIT_APPROVAL" | "CLEARED" | "CANARY" | "DEPLOYED" | "ROLLED_BACK" | "FAILED";
export type ApprovalRisk = "R2" | "R3";
export interface SelfPatchView { readonly id: string; readonly branch: string; readonly patchSha256: string; readonly state: SelfPatchState; readonly approvalRisk?: ApprovalRisk; readonly evidenceSha256?: string; readonly canaryId?: string; }

export type SelfImprovementCategory = "pi_upgrade" | "architecture" | "capability" | "security" | "dependency";
export type SelfImprovementAction =
  | "test"
  | "network_access"
  | "dependency_install"
  | "service_restart"
  | "canary_deploy"
  | "rollback"
  | "git_push"
  | "policy_change"
  | "credential_access"
  | "root_access"
  | "data_delete"
  | "production_cutover";

export interface SelfImprovementContext {
  readonly category: SelfImprovementCategory;
  readonly title: string;
  readonly background: string;
  readonly expectedBenefit: string;
  readonly riskSummary: string;
  readonly rollbackPlan: string;
  readonly requestedActions: readonly SelfImprovementAction[];
}

export interface SelfImprovementClearance {
  readonly clearanceId: string;
  readonly risk: ApprovalRisk;
  readonly manifestSha256: string;
  readonly requestedAt: string;
  readonly grantedAt?: string;
  readonly grantedBy?: string;
}

export interface SelfImprovementView extends SelfPatchView, SelfImprovementContext {
  readonly sourceJobId?: string;
  readonly clearance?: SelfImprovementClearance;
}

/**
 * This registry is an audit gate, not a Git writer. A patch is never applied
 * to main and Friday never pushes it. An external deployment operator can use
 * the recorded patch only after test evidence and R2/R3 approval.
 */
export class SelfPatchRegistry {
  #db: DatabaseSync | undefined;
  constructor(readonly path: string) {}
  open(): void {
    this.#db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS self_patches_v2 (
        id TEXT PRIMARY KEY, branch TEXT NOT NULL, patch_sha256 TEXT NOT NULL, state TEXT NOT NULL,
        approval_risk TEXT, evidence_sha256 TEXT, canary_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS self_improvements_v1 (
        patch_id TEXT PRIMARY KEY REFERENCES self_patches_v2(id),
        source_job_id TEXT,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        background TEXT NOT NULL,
        expected_benefit TEXT NOT NULL,
        risk_summary TEXT NOT NULL,
        rollback_plan TEXT NOT NULL,
        requested_actions_json TEXT NOT NULL,
        clearance_id TEXT UNIQUE,
        clearance_manifest_sha256 TEXT,
        clearance_requested_at TEXT,
        clearance_granted_at TEXT,
        clearance_granted_by TEXT
      ) STRICT;`);
    const columns = this.db.prepare("PRAGMA table_info(self_improvements_v1)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "source_job_id")) this.db.exec("ALTER TABLE self_improvements_v1 ADD COLUMN source_job_id TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS self_improvements_source_job_v1 ON self_improvements_v1(source_job_id) WHERE source_job_id IS NOT NULL");
  }
  close(): void { this.#db?.close(); this.#db = undefined; }
  create(id: string, branch: string, patch: string): void {
    validateSelfPatch(id, branch, patch);
    this.#insertPatch(id, branch, patch);
  }
  createImprovement(id: string, branch: string, patch: string, context: SelfImprovementContext): SelfImprovementView {
    return this.#createImprovement(id, branch, patch, context);
  }
  createImprovementFromJob(id: string, branch: string, patch: string, context: SelfImprovementContext, sourceJobId: string): SelfImprovementView {
    requireUuid(sourceJobId, "Source Job id");
    const normalizedContext = normalizeImprovementContext(context, patch);
    const existing = this.getImprovement(id);
    if (existing !== undefined) {
      if (
        existing.sourceJobId === sourceJobId &&
        existing.branch === branch &&
        existing.patchSha256 === hash(patch) &&
        sameImprovementContext(existing, normalizedContext)
      ) return existing;
      throw new Error("Self improvement id is already bound to a different source");
    }
    return this.#createImprovement(id, branch, patch, normalizedContext, sourceJobId);
  }
  #createImprovement(id: string, branch: string, patch: string, context: SelfImprovementContext, sourceJobId?: string): SelfImprovementView {
    validateSelfPatch(id, branch, patch);
    const normalizedContext = normalizeImprovementContext(context, patch);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#insertPatch(id, branch, patch);
      this.db.prepare(`
        INSERT INTO self_improvements_v1 (
          patch_id, source_job_id, category, title, background, expected_benefit,
          risk_summary, rollback_plan, requested_actions_json,
          clearance_id, clearance_manifest_sha256, clearance_requested_at,
          clearance_granted_at, clearance_granted_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
      `).run(
        id,
        sourceJobId ?? null,
        normalizedContext.category,
        normalizedContext.title,
        normalizedContext.background,
        normalizedContext.expectedBenefit,
        normalizedContext.riskSummary,
        normalizedContext.rollbackPlan,
        JSON.stringify(normalizedContext.requestedActions),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve original failure. */ }
      throw error;
    }
    return this.#requireImprovement(id);
  }
  markTested(id: string, evidenceSha256: string): void { this.#transition(id, "TESTED", { evidenceSha256 }); }
  requestApproval(id: string, risk: ApprovalRisk): void {
    if (this.getImprovement(id) !== undefined) throw new Error("Self improvements require a Hub-derived clearance request");
    if (risk !== "R2" && risk !== "R3") throw new Error("Self patches require R2 or R3 approval"); this.#transition(id, "WAIT_APPROVAL", { approvalRisk: risk });
  }
  approveCanary(id: string, risk: ApprovalRisk, canaryId: string): void {
    if (this.getImprovement(id) !== undefined) throw new Error("Self improvements require an explicit clearance grant before Canary");
    requireText(canaryId, "Canary id", 128); const current = this.get(id); if (current?.state !== "WAIT_APPROVAL" || current.approvalRisk !== risk) throw new Error("Self patch requires matching R2/R3 approval"); this.#transition(id, "CANARY", { canaryId });
  }
  requestClearance(id: string): SelfImprovementView {
    const improvement = this.#requireImprovement(id);
    if (improvement.state !== "TESTED" || improvement.evidenceSha256 === undefined) throw new Error("Self improvement requires test evidence before clearance");
    const risk = improvementRisk(improvement.requestedActions);
    const clearanceId = randomUUID();
    const requestedAt = new Date().toISOString();
    const manifest = clearanceManifest(improvement, clearanceId, risk, requestedAt);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE self_patches_v2 SET state='WAIT_APPROVAL',approval_risk=?,updated_at=? WHERE id=? AND state='TESTED'")
        .run(risk, requestedAt, id);
      this.db.prepare(`
        UPDATE self_improvements_v1
        SET clearance_id=?, clearance_manifest_sha256=?, clearance_requested_at=?,
            clearance_granted_at=NULL, clearance_granted_by=NULL
        WHERE patch_id=? AND clearance_id IS NULL
      `).run(clearanceId, hash(JSON.stringify(manifest)), requestedAt, id);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve original failure. */ }
      throw error;
    }
    return this.#requireImprovement(id);
  }
  grantClearance(id: string, clearanceId: string, ownerId: string): SelfImprovementView {
    requireUuid(clearanceId, "Clearance id");
    requireText(ownerId, "Clearance owner", 128);
    const improvement = this.#requireImprovement(id);
    if (improvement.state !== "WAIT_APPROVAL" || improvement.clearance?.clearanceId !== clearanceId || improvement.clearance.grantedAt !== undefined) {
      throw new Error("Self improvement clearance does not match the pending manifest");
    }
    const grantedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE self_patches_v2 SET state='CLEARED',updated_at=? WHERE id=? AND state='WAIT_APPROVAL'").run(grantedAt, id);
      this.db.prepare("UPDATE self_improvements_v1 SET clearance_granted_at=?,clearance_granted_by=? WHERE patch_id=? AND clearance_id=? AND clearance_granted_at IS NULL")
        .run(grantedAt, ownerId, id, clearanceId);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve original failure. */ }
      throw error;
    }
    return this.#requireImprovement(id);
  }
  startImprovementCanary(id: string, clearanceId: string, canaryId: string): SelfImprovementView {
    requireUuid(clearanceId, "Clearance id");
    requireText(canaryId, "Canary id", 128);
    const improvement = this.#requireImprovement(id);
    if (
      improvement.state !== "CLEARED" ||
      improvement.clearance?.clearanceId !== clearanceId ||
      improvement.clearance.grantedAt === undefined
    ) throw new Error("Self improvement requires matching granted clearance");
    this.#transition(id, "CANARY", { canaryId });
    return this.#requireImprovement(id);
  }
  completeCanary(id: string, ok: boolean): void {
    if (this.getImprovement(id) !== undefined) throw new Error("Self improvements require clearance-gated Canary completion");
    this.#transition(id, ok ? "DEPLOYED" : "ROLLED_BACK");
  }
  completeImprovementCanary(id: string, ok: boolean): SelfImprovementView {
    const improvement = this.#requireImprovement(id);
    if (improvement.state !== "CANARY" || improvement.clearance?.grantedAt === undefined) {
      throw new Error("Self improvement has no cleared active Canary");
    }
    this.#transition(id, ok ? "DEPLOYED" : "ROLLED_BACK");
    return this.#requireImprovement(id);
  }
  fail(id: string): void { this.#transition(id, "FAILED"); }
  get(id: string): SelfPatchView | undefined {
    const row = this.db.prepare("SELECT id,branch,patch_sha256 AS patchSha256,state,approval_risk AS approvalRisk,evidence_sha256 AS evidenceSha256,canary_id AS canaryId FROM self_patches_v2 WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return { id: row.id as string, branch: row.branch as string, patchSha256: row.patchSha256 as string, state: row.state as SelfPatchState,
      ...(typeof row.approvalRisk === "string" ? { approvalRisk: row.approvalRisk as ApprovalRisk } : {}), ...(typeof row.evidenceSha256 === "string" ? { evidenceSha256: row.evidenceSha256 } : {}), ...(typeof row.canaryId === "string" ? { canaryId: row.canaryId } : {}) };
  }
  list(): readonly SelfPatchView[] { return (this.db.prepare("SELECT id FROM self_patches_v2 ORDER BY created_at DESC LIMIT 200").all() as { id: string }[]).flatMap((row) => { const value = this.get(row.id); return value === undefined ? [] : [value]; }); }
  getImprovement(id: string): SelfImprovementView | undefined {
    const patch = this.get(id);
    if (patch === undefined) return undefined;
    const row = this.db.prepare(`
      SELECT category,title,background,expected_benefit AS expectedBenefit,
             source_job_id AS sourceJobId,
             risk_summary AS riskSummary,rollback_plan AS rollbackPlan,
             requested_actions_json AS requestedActionsJson,
             clearance_id AS clearanceId,
             clearance_manifest_sha256 AS clearanceManifestSha256,
             clearance_requested_at AS clearanceRequestedAt,
             clearance_granted_at AS clearanceGrantedAt,
             clearance_granted_by AS clearanceGrantedBy
      FROM self_improvements_v1 WHERE patch_id=?
    `).get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const context = improvementContextFromRow(row);
    const hasClearance = typeof row.clearanceId === "string" && typeof row.clearanceManifestSha256 === "string" && typeof row.clearanceRequestedAt === "string";
    if (hasClearance && patch.approvalRisk !== "R2" && patch.approvalRisk !== "R3") throw new Error("Stored self improvement clearance is invalid");
    const clearance: SelfImprovementClearance | undefined = hasClearance
      ? {
          clearanceId: row.clearanceId as string,
          risk: patch.approvalRisk as ApprovalRisk,
          manifestSha256: row.clearanceManifestSha256 as string,
          requestedAt: row.clearanceRequestedAt as string,
          ...(typeof row.clearanceGrantedAt === "string" ? { grantedAt: row.clearanceGrantedAt } : {}),
          ...(typeof row.clearanceGrantedBy === "string" ? { grantedBy: row.clearanceGrantedBy } : {}),
        }
      : undefined;
    const view: SelfImprovementView = { ...patch, ...context, ...(typeof row.sourceJobId === "string" ? { sourceJobId: row.sourceJobId } : {}), ...(clearance === undefined ? {} : { clearance }) };
    if (
      clearance !== undefined &&
      hash(JSON.stringify(clearanceManifest(view, clearance.clearanceId, clearance.risk, clearance.requestedAt))) !== clearance.manifestSha256
    ) throw new Error("Stored self improvement clearance manifest does not match its digest");
    return view;
  }
  listImprovements(): readonly SelfImprovementView[] {
    return (this.db.prepare("SELECT patch_id AS id FROM self_improvements_v1 ORDER BY rowid DESC LIMIT 200").all() as { id: string }[])
      .flatMap((row) => { const value = this.getImprovement(row.id); return value === undefined ? [] : [value]; });
  }
  #transition(id: string, next: SelfPatchState, changes: { readonly approvalRisk?: ApprovalRisk; readonly evidenceSha256?: string; readonly canaryId?: string } = {}): void {
    requirePatchId(id); if (changes.evidenceSha256 !== undefined) requireSha(changes.evidenceSha256, "Test evidence hash");
    const current = this.get(id); if (current === undefined || !allowed(current.state, next)) throw new Error("Invalid self-patch transition");
    this.db.prepare("UPDATE self_patches_v2 SET state=?,approval_risk=COALESCE(?,approval_risk),evidence_sha256=COALESCE(?,evidence_sha256),canary_id=COALESCE(?,canary_id),updated_at=? WHERE id=?").run(next, changes.approvalRisk ?? null, changes.evidenceSha256 ?? null, changes.canaryId ?? null, new Date().toISOString(), id);
  }
  #insertPatch(id: string, branch: string, patch: string): void {
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO self_patches_v2 VALUES(?,?,?,?,NULL,NULL,NULL,?,?)").run(id, branch, hash(patch), "DRAFT", now, now);
  }
  #requireImprovement(id: string): SelfImprovementView {
    const improvement = this.getImprovement(id);
    if (improvement === undefined) throw new Error("Self improvement is not registered");
    return improvement;
  }
  get db(): DatabaseSync { if (this.#db === undefined) throw new Error("Self patch registry is not open"); return this.#db; }
}

const SELF_IMPROVEMENT_CATEGORIES: readonly SelfImprovementCategory[] = ["pi_upgrade", "architecture", "capability", "security", "dependency"];
const SELF_IMPROVEMENT_ACTIONS: readonly SelfImprovementAction[] = [
  "test", "network_access", "dependency_install", "service_restart", "canary_deploy", "rollback", "git_push",
  "policy_change", "credential_access", "root_access", "data_delete", "production_cutover",
];

function validateSelfPatch(id: string, branch: string, patch: string): void {
  requirePatchId(id);
  if (!/^friday\/self\/[a-z0-9][a-z0-9-]{0,79}$/.test(branch) || branch === "main") {
    throw new Error("Self patch must use an isolated friday/self branch");
  }
  if (!patch.startsWith("diff --git ") || Buffer.byteLength(patch, "utf8") > 2 * 1024 * 1024) {
    throw new Error("Self patch must be a bounded Git patch");
  }
}

export function validateSelfImprovementContext(context: SelfImprovementContext): void {
  if (!SELF_IMPROVEMENT_CATEGORIES.includes(context.category)) throw new Error("Invalid self improvement category");
  requireText(context.title, "Improvement title", 200);
  requireText(context.background, "Improvement background", 4096);
  requireText(context.expectedBenefit, "Improvement expected benefit", 2048);
  requireText(context.riskSummary, "Improvement risk summary", 2048);
  requireText(context.rollbackPlan, "Improvement rollback plan", 4096);
  if (
    !Array.isArray(context.requestedActions) ||
    context.requestedActions.length === 0 ||
    context.requestedActions.length > 16 ||
    context.requestedActions.some((action) => !SELF_IMPROVEMENT_ACTIONS.includes(action)) ||
    new Set(context.requestedActions).size !== context.requestedActions.length
  ) throw new Error("Invalid self improvement requested actions");
}

function normalizeImprovementContext(context: SelfImprovementContext, patch: string): SelfImprovementContext {
  validateSelfImprovementContext(context);
  const actions = new Set<SelfImprovementAction>(context.requestedActions);
  // Every self modification needs reproducible validation, a bounded Canary,
  // and a rollback path even when the model forgets to request them.
  actions.add("test");
  actions.add("canary_deploy");
  actions.add("rollback");
  if (context.category === "pi_upgrade" || context.category === "dependency") {
    actions.add("network_access");
    actions.add("dependency_install");
    actions.add("service_restart");
  }
  if (context.category === "architecture" || context.category === "capability" || context.category === "security") {
    actions.add("service_restart");
  }
  const paths = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].flatMap((match) => [match[1] ?? "", match[2] ?? ""]);
  if (paths.some((path) => /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$/.test(path))) {
    actions.add("network_access");
    actions.add("dependency_install");
  }
  if (paths.some((path) => /^deploy\//.test(path))) actions.add("production_cutover");
  if (paths.some((path) => /(?:auth|webauthn|identity|credential|runner-registry|job-registry|fleet-scheduler|m3-registry|config\.ts|server\.ts)/i.test(path))) {
    actions.add("policy_change");
  }
  const additions = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
  if (/(?:^|\s)(?:sudo|su\s+-)|\/etc\/sudoers|\bUSER\s+root\b|\bsetuid\b|--user\s+(?:0|root)\b/i.test(additions)) actions.add("root_access");
  if (/\brm\s+-[a-z]*r[a-z]*f|\bDROP\s+(?:TABLE|DATABASE)\b|\btruncate\s+-s\s+0\b|\bshred\b/i.test(additions)) actions.add("data_delete");
  if (/\b(?:credential|secret|api[_-]?key|private[_-]?key|authorized_keys)\b|process\.env\s*\[/i.test(additions)) actions.add("credential_access");
  if (/\b(?:systemctl|service)\s+(?:restart|stop|start)|docker\s+compose\s+(?:up|down|restart)/i.test(additions)) actions.add("service_restart");
  if (/\bgit\s+push\b|refs\/(?:heads|for)\//i.test(additions)) actions.add("git_push");
  if (/\b(?:npm|pnpm|yarn|pip|apt-get|apk)\s+(?:install|add)\b/i.test(additions)) {
    actions.add("network_access");
    actions.add("dependency_install");
  }
  return { ...context, requestedActions: [...actions].sort() };
}

function improvementContextFromRow(row: Record<string, unknown>): SelfImprovementContext {
  let requestedActions: unknown;
  try { requestedActions = JSON.parse(row.requestedActionsJson as string) as unknown; } catch { throw new Error("Stored self improvement context is invalid"); }
  const context = {
    category: row.category,
    title: row.title,
    background: row.background,
    expectedBenefit: row.expectedBenefit,
    riskSummary: row.riskSummary,
    rollbackPlan: row.rollbackPlan,
    requestedActions,
  } as SelfImprovementContext;
  validateSelfImprovementContext(context);
  return context;
}

function sameImprovementContext(left: SelfImprovementContext, right: SelfImprovementContext): boolean {
  return left.category === right.category &&
    left.title === right.title &&
    left.background === right.background &&
    left.expectedBenefit === right.expectedBenefit &&
    left.riskSummary === right.riskSummary &&
    left.rollbackPlan === right.rollbackPlan &&
    JSON.stringify([...left.requestedActions].sort()) === JSON.stringify([...right.requestedActions].sort());
}

function improvementRisk(actions: readonly SelfImprovementAction[]): ApprovalRisk {
  return actions.some((action) => action === "policy_change" || action === "credential_access" || action === "root_access" || action === "data_delete" || action === "production_cutover")
    ? "R3"
    : "R2";
}

function clearanceManifest(
  improvement: SelfImprovementView,
  clearanceId: string,
  risk: ApprovalRisk,
  requestedAt: string,
): Record<string, unknown> {
  return {
    protocol: "friday-self-improvement-clearance-v1",
    clearanceId,
    patchId: improvement.id,
    branch: improvement.branch,
    patchSha256: improvement.patchSha256,
    sourceJobId: improvement.sourceJobId,
    evidenceSha256: improvement.evidenceSha256,
    category: improvement.category,
    title: improvement.title,
    background: improvement.background,
    expectedBenefit: improvement.expectedBenefit,
    riskSummary: improvement.riskSummary,
    rollbackPlan: improvement.rollbackPlan,
    requestedActions: [...improvement.requestedActions].sort(),
    risk,
    requestedAt,
  };
}

function validateMcp(definition: McpDefinition): void { requireName(definition.name, "MCP name"); requireVersion(definition.version); if (!/^https:\/\//.test(definition.source)) throw new Error("MCP source must be HTTPS"); requireSha(definition.schemaSha256, "MCP schema hash"); for (const value of Object.values(definition.budget)) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid MCP budget"); if (definition.budget.timeoutSeconds < 1 || definition.budget.timeoutSeconds > 3600 || definition.budget.fileBytes > 1_048_576) throw new Error("Invalid MCP budget"); }
function validateUsage(usage: Pick<McpInvocation, "networkRequests" | "fileBytes" | "secretRefs" | "elapsedSeconds">, budget: Budget): void { for (const key of ["networkRequests", "fileBytes", "secretRefs", "elapsedSeconds"] as const) if (!Number.isSafeInteger(usage[key]) || usage[key] < 0 || usage[key] > budget[key === "elapsedSeconds" ? "timeoutSeconds" : key]) throw new Error("MCP budget exceeded"); }
function validateProcedure(procedure: SignedProcedure): void { requireName(procedure.id, "Procedure id"); requireVersion(procedure.version); requireSha(procedure.manifestSha256, "Procedure manifest hash"); if (procedure.capabilities.length === 0 || procedure.capabilities.length > 32 || procedure.capabilities.some((item) => !/^[a-z][a-z0-9_.-]{0,63}$/.test(item))) throw new Error("Invalid procedure capabilities"); if (!/^[A-Za-z0-9_-]{86}$/.test(procedure.signature)) throw new Error("Invalid procedure signature"); }
function validateSkill(skill: SignedSkill): void { requireName(skill.id, "Skill id"); requireVersion(skill.version); requireSha(skill.contentSha256, "Skill content hash"); let source: URL; try { source = new URL(skill.source); } catch { throw new Error("Invalid skill source"); } if (source.protocol !== "https:" || source.username !== "" || source.password !== "" || source.hash !== "") throw new Error("Invalid skill source"); if (skill.capabilities.length === 0 || skill.capabilities.length > 32 || skill.capabilities.some((item) => !/^[a-z][a-z0-9_.-]{0,63}$/.test(item))) throw new Error("Invalid skill capabilities"); if (!/^[A-Za-z0-9_-]{86}$/.test(skill.signature)) throw new Error("Invalid skill signature"); }
function skillView(row: Record<string, unknown>): SkillView { return { id: row.id as string, version: row.version as string, source: row.source as string, contentSha256: row.contentSha256 as string, capabilities: JSON.parse(row.capabilitiesJson as string) as readonly string[], enabled: row.enabled === 1, sandboxVerified: row.sandboxVerified === 1 }; }
function validateAdapter(definition: AdapterDefinition): void { if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(definition.runnerId)) throw new Error("Invalid Runner id"); validateAdapterName(definition.adapter); if (!/^[a-z0-9][a-z0-9._/-]{0,255}(?::[A-Za-z0-9._-]{1,128})?$/.test(definition.image) || definition.image.endsWith(":" + "latest")) throw new Error("Adapter image must be an explicit deployment reference"); if (!/^sha256:[a-f0-9]{64}$/.test(definition.imageId)) throw new Error("Adapter image ID must be immutable sha256"); }
function validateAdapterName(value: string): asserts value is SandboxAdapter { if (value !== "remote-agent" && value !== "codex-app-server" && value !== "pi-rpc" && value !== "claude-code") throw new Error("Unsupported sandbox adapter"); }
function requireName(value: string, label: string): void { if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error(`Invalid ${label}`); }
function requireVersion(value: string): void { if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error("Invalid version"); }
function requireSha(value: string, label: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label}`); }
function requireText(value: string, label: string, maximum: number): void { if (typeof value !== "string" || value.trim() === "" || Buffer.byteLength(value, "utf8") > maximum) throw new Error(`Invalid ${label}`); }
function requirePatchId(value: string): void { if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error("Invalid self patch id"); }
function requireUuid(value: string, label: string): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`Invalid ${label}`); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function allowed(current: SelfPatchState, next: SelfPatchState): boolean { return ({ DRAFT: ["TESTED", "FAILED"], TESTED: ["WAIT_APPROVAL", "FAILED"], WAIT_APPROVAL: ["CLEARED", "CANARY", "ROLLED_BACK"], CLEARED: ["CANARY", "ROLLED_BACK"], CANARY: ["DEPLOYED", "ROLLED_BACK", "FAILED"], DEPLOYED: [], ROLLED_BACK: [], FAILED: [] } as Record<SelfPatchState, readonly SelfPatchState[]>)[current].includes(next); }
function readMcpOutput(value: unknown): string { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("MCP returned invalid JSON-RPC response"); const result = (value as Record<string, unknown>).result; if (typeof result !== "object" || result === null || Array.isArray(result)) throw new Error("MCP returned an error or invalid result"); const content = (result as Record<string, unknown>).content; if (!Array.isArray(content) || content.length === 0 || content.length > 64) throw new Error("MCP returned invalid content"); const text = content.map((part) => typeof part === "object" && part !== null && !Array.isArray(part) && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text as string : "[non-text MCP content omitted]").join("\n"); if (Buffer.byteLength(text, "utf8") > 1_048_576) throw new Error("MCP output exceeds maximum size"); return text; }
