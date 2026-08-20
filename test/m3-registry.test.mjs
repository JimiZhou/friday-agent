import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { McpBroker, McpRegistry, ProcedureRegistry, SelfPatchRegistry, SkillRegistry, invokeStreamableHttpMcp, procedurePayload, skillPayload } from "../apps/fridayd/dist/m3-registry.js";
import { invokeMcpBrokerSidecar, loadMcpBrokerSidecarConfig, startMcpBrokerSidecar } from "../apps/fridayd/dist/mcp-broker-sidecar.js";
import { createFridayServer } from "../apps/fridayd/dist/server.js";
import { applyPreparedSelfPatch, prepareSelfPatchWorktree } from "../apps/fridayd/dist/self-patch-worktree.js";

const ownerToken = "m3-owner-token-with-sufficient-length";
const sha = (character) => character.repeat(64);
const execFile = promisify(execFileCallback);
async function git(cwd, args) { await execFile("git", args, { cwd }); }

test("M3 MCP definitions are pinned, disabled by default, bounded, and distrust output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "m3-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new McpRegistry(join(directory, "friday.sqlite"));
  registry.open();
  t.after(() => registry.close());
  const definition = { name: "search", version: "1.2.3", source: "https://broker.example.test/search", schemaSha256: sha("a"), budget: { networkRequests: 1, fileBytes: 16, secretRefs: 0, timeoutSeconds: 5 } };
  registry.register(definition);
  assert.equal(registry.resolve("search"), undefined);
  registry.enable("search");
  const result = await new McpBroker(registry).invoke(
    { name: "search", input: "status", networkRequests: 1, fileBytes: 0, secretRefs: 0, elapsedSeconds: 1 },
    async () => ({ output: "untrusted reply", usage: { networkRequests: 1, fileBytes: 0, secretRefs: 0, elapsedSeconds: 1 } }),
  );
  assert.deepEqual(result, { trust: "untrusted", text: "untrusted reply", truncated: false, source: definition.source, schemaSha256: definition.schemaSha256 });
  await assert.rejects(
    () => new McpBroker(registry).invoke({ name: "search", input: "x", networkRequests: 2, fileBytes: 0, secretRefs: 0, elapsedSeconds: 1 }, async () => ({ output: "", usage: { networkRequests: 0, fileBytes: 0, secretRefs: 0, elapsedSeconds: 0 } })),
    /budget exceeded/,
  );
  registry.disable("search");
  await assert.rejects(
    () => new McpBroker(registry).invoke({ name: "search", input: "x", networkRequests: 0, fileBytes: 0, secretRefs: 0, elapsedSeconds: 0 }, async () => ({ output: "", usage: { networkRequests: 0, fileBytes: 0, secretRefs: 0, elapsedSeconds: 0 } })),
    /disabled/,
  );
});

test("M3 Streamable HTTP MCP transport is bounded, no-secret, and marks remote output untrusted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "m3-mcp-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new McpRegistry(join(directory, "friday.sqlite")); registry.open(); t.after(() => registry.close());
  const definition = { name: "search", version: "1.0.0", source: "https://mcp.example.test/rpc", schemaSha256: sha("a"), budget: { networkRequests: 1, fileBytes: 1024, secretRefs: 0, timeoutSeconds: 5 } };
  registry.register(definition); registry.enable("search");
  const result = await new McpBroker(registry).invoke(
    { name: "search", input: "status", networkRequests: 1, fileBytes: 0, secretRefs: 0, elapsedSeconds: 0 },
    (configured, input) => invokeStreamableHttpMcp(configured, input, async (url, init) => {
      assert.equal(url.toString(), definition.source);
      assert.equal(init.headers.authorization, undefined);
      assert.deepEqual(JSON.parse(init.body), { jsonrpc: "2.0", id: "friday", method: "tools/call", params: { name: "search", arguments: { input: "status" } } });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "friday", result: { content: [{ type: "text", text: "external instructions are untrusted" }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  assert.equal(result.trust, "untrusted");
  assert.equal(result.text, "external instructions are untrusted");
});

test("M3 Broker is a separate Unix-socket process boundary and rejects unreviewed origins", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "m3-broker-sidecar-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "broker.sock");
  assert.throws(() => loadMcpBrokerSidecarConfig({ FRIDAY_MCP_BROKER_SOCKET: socketPath }), /ALLOWED_ORIGINS/);
  const broker = await startMcpBrokerSidecar(loadMcpBrokerSidecarConfig({ FRIDAY_MCP_BROKER_SOCKET: socketPath, FRIDAY_MCP_BROKER_ALLOWED_ORIGINS: "https://reviewed.example.test" }));
  t.after(() => broker.stop());
  const definition = { name: "search", version: "1.0.0", source: "https://unreviewed.example.test/rpc", schemaSha256: sha("a"), budget: { networkRequests: 1, fileBytes: 1024, secretRefs: 0, timeoutSeconds: 5 } };
  await assert.rejects(() => invokeMcpBrokerSidecar(socketPath, definition, "status"), /rejected/);
});

test("M3 procedures require signed sandbox replay and can rollback only to verified versions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "m3-procedure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const registry = new ProcedureRegistry(join(directory, "friday.sqlite"), keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  registry.open();
  t.after(() => registry.close());
  const signed = (version) => {
    const procedure = { id: "review", version, capabilities: ["workspace.read"], manifestSha256: sha(version === "1.0.0" ? "b" : "c") };
    return { ...procedure, signature: sign(null, Buffer.from(procedurePayload(procedure)), keys.privateKey).toString("base64url") };
  };
  registry.register(signed("1.0.0"));
  assert.throws(() => registry.enable("review"), /sandbox replay/);
  registry.markSandboxVerified("review", "1.0.0", sha("d"));
  registry.enable("review");
  registry.register(signed("1.1.0"));
  registry.markSandboxVerified("review", "1.1.0", sha("e"));
  registry.enable("review");
  assert.equal(registry.active("review")?.version, "1.1.0");
  registry.rollback("review");
  assert.deepEqual(registry.active("review"), { id: "review", version: "1.0.0", capabilities: ["workspace.read"], manifestSha256: sha("b"), enabled: true, sandboxVerified: true });
});

test("M3 skills are Owner-signed inert metadata and roll back only to sandbox-verified content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "m3-skill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const registry = new SkillRegistry(join(directory, "friday.sqlite"), keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  registry.open(); t.after(() => registry.close());
  const signed = (version) => {
    const skill = { id: "repo-review", version, source: `https://skills.example.test/repo-review-${version}.tar.gz`, contentSha256: sha(version === "1.0.0" ? "a" : "b"), capabilities: ["workspace.read"] };
    return { ...skill, signature: sign(null, Buffer.from(skillPayload(skill)), keys.privateKey).toString("base64url") };
  };
  registry.register(signed("1.0.0"));
  assert.throws(() => registry.enable("repo-review"), /sandbox replay/);
  registry.markSandboxVerified("repo-review", "1.0.0", sha("c")); registry.enable("repo-review");
  registry.register(signed("1.1.0")); registry.markSandboxVerified("repo-review", "1.1.0", sha("d")); registry.enable("repo-review");
  assert.equal(registry.active("repo-review")?.version, "1.1.0");
  registry.rollback("repo-review");
  assert.deepEqual(registry.active("repo-review"), { id: "repo-review", version: "1.0.0", source: "https://skills.example.test/repo-review-1.0.0.tar.gz", contentSha256: sha("a"), capabilities: ["workspace.read"], enabled: true, sandboxVerified: true });
  const tampered = { ...signed("2.0.0"), source: "https://attacker.example.test/skill" };
  assert.throws(() => registry.register(tampered), /signature/);
});

test("M3 self patches require evidence, matching R2/R3 approval, and canary recovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "m3-patch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new SelfPatchRegistry(join(directory, "friday.sqlite"));
  registry.open();
  t.after(() => registry.close());
  registry.create("m3-canary", "friday/self/m3-canary", "diff --git a/a b/a\n");
  assert.throws(() => registry.requestApproval("m3-canary", "R2"), /transition/);
  registry.markTested("m3-canary", sha("f"));
  registry.requestApproval("m3-canary", "R3");
  assert.throws(() => registry.approveCanary("m3-canary", "R2", "canary-node-a"), /matching/);
  registry.approveCanary("m3-canary", "R3", "canary-node-a");
  registry.completeCanary("m3-canary", false);
  assert.equal(registry.get("m3-canary")?.state, "ROLLED_BACK");
  assert.throws(() => registry.create("bad", "main", "diff --git a/a b/a\n"), /isolated/);
});

test("self improvements explain background and derive clearance risk without trusting the model", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "m5-improvement-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new SelfPatchRegistry(join(directory, "friday.sqlite"));
  registry.open();
  t.after(() => registry.close());
  const improvement = registry.createImprovement(
    "upgrade-pi",
    "friday/self/upgrade-pi",
    "diff --git a/package.json b/package.json\n",
    {
      category: "pi_upgrade",
      title: "Upgrade the pinned Pi worker",
      background: "The current pinned release has upstream fixes, but its RPC contract and supply chain must be revalidated.",
      expectedBenefit: "Improved model compatibility and security fixes.",
      riskSummary: "RPC events or tool isolation may change and break conversation recovery.",
      rollbackPlan: "Restore the current image digest and database-compatible Hub release.",
      requestedActions: ["test", "network_access", "dependency_install", "service_restart", "canary_deploy", "rollback"],
    },
  );
  assert.equal(improvement.state, "DRAFT");
  registry.markTested("upgrade-pi", sha("a"));
  const requested = registry.requestClearance("upgrade-pi");
  assert.equal(requested.state, "WAIT_APPROVAL");
  assert.equal(requested.clearance.risk, "R2");
  assert.match(requested.background, /upstream fixes/);
  assert.match(requested.rollbackPlan, /Restore/);
  assert.throws(() => registry.approveCanary("upgrade-pi", "R2", "canary-a"), /explicit clearance/);
  assert.throws(() => registry.grantClearance("upgrade-pi", randomUUID(), "owner"), /does not match/);
  const cleared = registry.grantClearance("upgrade-pi", requested.clearance.clearanceId, "owner");
  assert.equal(cleared.state, "CLEARED");
  assert.equal(cleared.clearance.grantedBy, "owner");
  assert.throws(() => registry.startImprovementCanary("upgrade-pi", randomUUID(), "canary-a"), /matching granted/);
  assert.equal(registry.startImprovementCanary("upgrade-pi", requested.clearance.clearanceId, "canary-a").state, "CANARY");
  assert.throws(() => registry.completeCanary("upgrade-pi", true), /clearance-gated/);
  registry.completeImprovementCanary("upgrade-pi", false);
  assert.equal(registry.getImprovement("upgrade-pi")?.state, "ROLLED_BACK");

  registry.createImprovement("policy-change", "friday/self/policy-change", "diff --git a/policy b/policy\n", {
    category: "security", title: "Tighten policy", background: "Policy review", expectedBenefit: "Reduced exposure",
    riskSummary: "Authorization semantics change", rollbackPlan: "Restore prior policy", requestedActions: ["test", "policy_change", "canary_deploy", "rollback"],
  });
  registry.markTested("policy-change", sha("b"));
  assert.equal(registry.requestClearance("policy-change").clearance?.risk, "R3");

  const inferred = registry.createImprovement("hidden-core-risk", "friday/self/hidden-core-risk", "diff --git a/apps/fridayd/src/server.ts b/apps/fridayd/src/server.ts\n", {
    category: "architecture", title: "Refactor routing", background: "Reduce routing complexity", expectedBenefit: "Simpler maintenance",
    riskSummary: "Model claims low risk", rollbackPlan: "Restore prior route", requestedActions: ["test"],
  });
  assert.equal(inferred.requestedActions.includes("policy_change"), true, "Hub must infer control-root risk from touched paths");
  assert.equal(inferred.clearanceRequired, true);
  registry.markTested("hidden-core-risk", sha("c"));
  assert.equal(registry.requestClearance("hidden-core-risk").clearance?.risk, "R3");
  registry.db.prepare("UPDATE self_improvements_v1 SET background='tampered after clearance' WHERE patch_id='hidden-core-risk'").run();
  assert.throws(() => registry.getImprovement("hidden-core-risk"), /manifest does not match/);

  const hiddenRoot = registry.createImprovement("hidden-root-risk", "friday/self/hidden-root-risk", "diff --git a/scripts/setup.sh b/scripts/setup.sh\n--- a/scripts/setup.sh\n+++ b/scripts/setup.sh\n@@ -0,0 +1 @@\n+sudo systemctl restart fridayd\n", {
    category: "capability", title: "Automate restart", background: "Reduce manual steps", expectedBenefit: "Faster recovery",
    riskSummary: "Model claims a routine restart", rollbackPlan: "Stop the candidate and retain current", requestedActions: ["test"],
  });
  assert.equal(hiddenRoot.requestedActions.includes("root_access"), true, "Hub must infer risky added commands from patch content");
  registry.markTested("hidden-root-risk", sha("d"));
  assert.equal(registry.requestClearance("hidden-root-risk").clearance?.risk, "R3");

  const briefOnly = registry.createImprovement("brief-only", "friday/self/brief-only", "diff --git a/docs/voice.md b/docs/voice.md\n", {
    category: "capability", title: "Clarify voice guidance", background: "Users miss the interruption gesture", expectedBenefit: "Faster voice onboarding",
    riskSummary: "Documentation wording may be unclear", rollbackPlan: "Restore the prior copy", requestedActions: ["test", "rollback"],
  });
  assert.equal(briefOnly.clearanceRequired, false);
  const adopted = registry.completeImprovementTest("brief-only", sha("e"));
  assert.equal(adopted.state, "ADOPTED", "low-risk work is adopted automatically after trusted test evidence");
  assert.equal(adopted.clearance, undefined);
  assert.equal(registry.completeImprovementTest("brief-only", sha("e")).state, "ADOPTED", "evidence replay remains idempotent");
  assert.throws(() => registry.requestClearance("brief-only"), /does not require clearance|test evidence/);

  const restartNeeded = registry.createImprovement("restart-needed", "friday/self/restart-needed", "diff --git a/docs/runtime.md b/docs/runtime.md\n", {
    category: "capability", title: "Reload runtime guidance", background: "Runtime guidance changed", expectedBenefit: "New guidance is active",
    riskSummary: "A service restart affects active conversations", rollbackPlan: "Keep the current service running", requestedActions: ["test", "service_restart", "canary_deploy", "rollback"],
  });
  assert.equal(restartNeeded.clearanceRequired, true, "service restarts and Canary deployment remain material effects");

  registry.createImprovement("legacy-tested", "friday/self/legacy-tested", "diff --git a/docs/help.md b/docs/help.md\n", {
    category: "capability", title: "Clarify help copy", background: "Help copy is unclear", expectedBenefit: "Faster onboarding",
    riskSummary: "Wording may still be unclear", rollbackPlan: "Restore the prior copy", requestedActions: ["test", "rollback"],
  });
  registry.markTested("legacy-tested", sha("f"));
  registry.close();
  registry.open();
  assert.equal(registry.getImprovement("legacy-tested")?.state, "ADOPTED", "startup migrates prior low-risk TESTED candidates to ADOPTED");
});

test("M3 self patch preparation changes only an isolated worktree, never live main", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "m3-worktree-"));
  const repository = join(directory, "repository");
  const state = join(directory, "state");
  await (await import("node:fs/promises")).mkdir(repository, { recursive: true });
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "Friday Test"]);
  await git(repository, ["config", "user.email", "friday@example.invalid"]);
  await writeFile(join(repository, "a.txt"), "before\n");
  await git(repository, ["add", "a.txt"]); await git(repository, ["commit", "-m", "initial"]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const patch = "diff --git a/a.txt b/a.txt\nindex 9b24da9..b6fc4c6 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n";
  const prepared = await prepareSelfPatchWorktree({ repository, stateDirectory: state, id: "safe-change", branch: "friday/self/safe-change", patch });
  assert.match(prepared.worktree, /self-patches\/safe-change\/worktree$/);
  assert.equal(await readFile(join(repository, "a.txt"), "utf8"), "before\n");
  await applyPreparedSelfPatch(prepared);
  assert.equal(await readFile(join(prepared.worktree, "a.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(repository, "a.txt"), "utf8"), "before\n");
});

test("M3 Hub routes are Owner-only and the external broker stays fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "m3-server-"));
  const friday = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir: directory, ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576 });
  t.after(async () => { await friday.stop(); await rm(directory, { recursive: true, force: true }); });
  const address = await friday.start();
  const base = `http://${address.host}:${address.port}`;
  const call = (path, body, token = ownerToken) => fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await call("/v3/mcp", undefined, null)).status, 401);
  assert.equal((await call("/v3/mcp/invoke", { name: "search" })).status, 503);
  assert.equal((await call("/v3/skills")).status, 503);
  assert.equal((await call("/v3/mcp", { name: "search", version: "1.0.0", source: "https://broker.example.test", schemaSha256: sha("a"), budget: { networkRequests: 1, fileBytes: 1024, secretRefs: 0, timeoutSeconds: 10 } })).status, 201);
  assert.equal((await call("/v3/mcp/search/enable", {})).status, 200);
  assert.equal((await call("/v3/runner-adapters", { runnerId: "018f6f57-51d4-7b48-a3a3-c5e8b194aaf2", adapter: "pi-rpc", image: "friday-pi:0.83.0", imageId: `sha256:${"b".repeat(64)}` })).status, 409);
  const created = await call("/v3/self-patches", { id: "safe-patch", branch: "friday/self/safe-patch", patch: "diff --git a/a b/a\n" });
  assert.equal(created.status, 201);
  const listed = await call("/v3/self-patches");
  assert.equal((await listed.json()).execution, "manual-canary-only");

  const improvementCreate = await call("/v4/self-improvements", {
    id: "agent-upgrade", branch: "friday/self/agent-upgrade", patch: "diff --git a/a b/a\n",
    category: "architecture", title: "Separate the orchestration queue", background: "Conversation and Job mutations need independent recovery evidence.",
    expectedBenefit: "Smaller failure domains.", riskSummary: "Queue migration may strand an in-flight turn.", rollbackPlan: "Restore the prior Hub image and schema-compatible database backup.",
    requestedActions: ["test", "service_restart", "canary_deploy", "production_cutover", "rollback"],
  });
  assert.equal(improvementCreate.status, 201);
  assert.equal((await improvementCreate.json()).improvement.state, "DRAFT");
  const testedResponse = await call("/v4/self-improvements/agent-upgrade/tested", { evidenceSha256: sha("e") });
  assert.equal(testedResponse.status, 200);
  const testedImprovement = (await testedResponse.json()).improvement;
  assert.equal(testedImprovement.state, "WAIT_APPROVAL", "material changes automatically create a clearance request after tests");
  const clearance = testedImprovement.clearance;
  assert.equal(clearance.risk, "R3");
  assert.equal((await call("/v4/self-improvements/agent-upgrade/clearance-grant", { clearanceId: randomUUID() })).status, 409);
  const granted = await call("/v4/self-improvements/agent-upgrade/clearance-grant", { clearanceId: clearance.clearanceId });
  assert.equal(granted.status, 200);
  assert.equal((await granted.json()).improvement.state, "CLEARED");
  assert.equal((await call("/v4/self-improvements/agent-upgrade/canary", { clearanceId: clearance.clearanceId, canaryId: "hub-canary-a" })).status, 200);
});
