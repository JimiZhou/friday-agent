import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFridayServer } from "../apps/fridayd/dist/server.js";
import { loadOrCreateHubIdentity } from "../apps/fridayd/dist/hub-identity.js";
import { SqliteJobRegistry } from "../apps/fridayd/dist/job-registry.js";
import { modelRelayRoute, sandboxDockerArguments, validateRequest } from "../apps/sandboxd/dist/index.js";
import { loadPiModelConfig, piRpcLaunchPlan } from "../apps/pi-worker/dist/index.js";
import { JobArtifactStore } from "../apps/fridayd/dist/job-artifact-store.js";
import { JOB_PROTOCOL_VERSION, runnerRequestSignaturePayloadV2 } from "../packages/protocol/dist/index.js";

const ownerToken = "a-secure-owner-token-for-tests";

test("Owner Web opens through Basic Auth while browser writes keep Origin and CSRF protection", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-owner-web-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const webPassword = "owner-web-password-for-tests";
  const origin = "https://friday.example.test";
  const friday = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken, publicOrigin: origin, webPassword, maxBodyBytes: 1_048_576 });
  const address = await friday.start();
  t.after(() => friday.stop());
  const base = `http://${address.host}:${address.port}`;
  const basic = `Basic ${Buffer.from(`owner:${webPassword}`).toString("base64")}`;
  const webChallenge = await fetch(`${base}/`);
  assert.equal(webChallenge.status, 401);
  assert.equal(webChallenge.headers.get("www-authenticate"), 'Basic realm="Friday Agent", charset="UTF-8"');
  const web = await fetch(`${base}/`, { headers: { authorization: basic } });
  assert.equal(web.status, 200);
  const webHtml = await web.text();
  assert.match(webHtml, /Basic Auth · 私有连接/);
  assert.match(webHtml, /记忆与成长/);
  assert.match(webHtml, /data-view="chat"/);
  assert.match(webHtml, /data-view="devices"/);
  assert.match(webHtml, /data-view="tasks"/);
  assert.match(webHtml, /data-view="clearance"/);
  assert.match(webHtml, /src="\/assets\/friday\.js"/);
  assert.doesNotMatch(webHtml, /<script[^>]*>\s*const/);
  const script = await fetch(`${base}/assets/friday.js`, { headers: { authorization: basic } });
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /text\/javascript/);
  const statusBefore = await fetch(`${base}/v2/auth/status`);
  assert.equal(statusBefore.status, 401);
  const status = await fetch(`${base}/v2/auth/status`, { headers: { authorization: basic } });
  assert.deepEqual(await status.json(), { authenticated: true, authMode: "basic", passwordEnabled: true, passkeyConfigured: false });
  const rejected = await fetch(`${base}/v2/jobs`, { method: "POST", headers: { authorization: basic, "content-type": "application/json", origin }, body: "{}" });
  assert.equal(rejected.status, 401);
  const wrongOrigin = await fetch(`${base}/v2/jobs`, { method: "POST", headers: { authorization: basic, "x-friday-csrf": "basic", "content-type": "application/json", origin: "https://evil.example.test" }, body: "{}" });
  assert.equal(wrongOrigin.status, 401);
  const basicAccepted = await fetch(`${base}/v2/jobs`, { method: "POST", headers: { authorization: basic, "x-friday-csrf": "basic", "content-type": "application/json", origin }, body: "{}" });
  assert.equal(basicAccepted.status, 400);
  const bearerAccepted = await fetch(`${base}/v2/jobs`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(bearerAccepted.status, 400, "bearer automation remains available outside the browser authentication path");
  const passkeyLogin = await fetch(`${base}/v2/auth/login/options`, { method: "POST", headers: { "content-type": "application/json", origin }, body: "{}" });
  assert.equal(passkeyLogin.status, 401, "Passkey remains optional and cannot authenticate without an enrolled credential");
  const bootstrap = await fetch(`${base}/v2/auth/bootstrap`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(bootstrap.status, 201);
});

test("sandboxd accepts only a signed job worktree and produces a no-network Docker plan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "friday-sandboxd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hub = await loadOrCreateHubIdentity(root);
  const keyFile = join(root, "hub.pub");
  await writeFile(keyFile, hub.publicKeyPem, { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const state = join(root, "runner");
  const registry = new SqliteJobRegistry(join(root, "friday.sqlite"), hub);
  registry.open();
  t.after(() => registry.close());
  const input = { idempotencyKey: randomUUID(), runnerId: randomUUID(), workspaceId: "repo", tool: "codex", operation: "develop", prompt: "fixture" };
  const created = registry.create(input);
  registry.approve(created.job.jobId, "owner");
  const spec = registry.pull(input.runnerId);
  assert.ok(spec);
  const worktree = join(state, "jobs", spec.jobId, "worktree");
  await mkdir(worktree, { recursive: true, mode: 0o700 });
  const config = { socketPath: join(root, "sandbox.sock"), runnerStateDir: state, hubPublicKeyFile: keyFile, agentImage: { image: "friday-agent:0.1.0", imageId: `sha256:${"a".repeat(64)}` }, codexImage: { image: "friday-agent:0.1.0", imageId: `sha256:${"c".repeat(64)}` }, hubUrl: new URL("http://127.0.0.1:4310/"), modelRelayDirectory: "/tmp/friday-model-relays", runnerUid: 1001, runnerGid: 1000 };
  const modelAccess = { protocolVersion: JOB_PROTOCOL_VERSION, accessToken: "x".repeat(43), jobId: spec.jobId, runnerId: spec.runnerId, leaseId: spec.leaseId, tool: "codex", provider: "openai", model: "codex-test", expiresAt: new Date(Date.parse(spec.leaseExpiresAt) - 1_000).toISOString() };
  assert.equal(validateRequest(config, { spec, worktreePath: worktree, modelAccess }).jobId, spec.jobId);
  const args = sandboxDockerArguments(config, { spec, worktreePath: worktree, modelAccess });
  assert.ok(args.includes("--network") && args.includes("none"));
  assert.ok(args.includes("--read-only") && args.includes("--cap-drop"));
  assert.ok(args.includes("1001:1000"));
  assert.equal(args.includes("friday-agent-wrapper"), false, "the image ENTRYPOINT owns the executable");
  assert.equal(args.at(-1), "codex");
  assert.equal(args.includes(modelAccess.accessToken), false, "the short-lived Hub token stays in the host relay, not the container");
  assert.throws(() => validateRequest(config, { spec, worktreePath: root, modelAccess }), /worktree/);
  assert.throws(() => validateRequest(config, { spec: { ...spec, prompt: "tampered" }, worktreePath: worktree, modelAccess }), /digest/);
  assert.throws(() => validateRequest(config, { spec, worktreePath: worktree }), /model access/);

  const diagnosticConfig = { ...config, codexImage: undefined };
  assert.throws(() => validateRequest(diagnosticConfig, { spec, worktreePath: worktree, modelAccess }), /Codex sandbox adapter/);

  const piInput = { ...input, idempotencyKey: randomUUID(), runnerId: randomUUID(), tool: "pi", prompt: "fixture pi" };
  const piCreated = registry.create(piInput); registry.approve(piCreated.job.jobId, "owner");
  const piSpec = registry.pull(piInput.runnerId); assert.ok(piSpec);
  const piWorktree = join(state, "jobs", piSpec.jobId, "worktree"); await mkdir(piWorktree, { recursive: true, mode: 0o700 });
  assert.throws(() => validateRequest(config, { spec: piSpec, worktreePath: piWorktree }), /Pi sandbox adapter/);
  const piConfig = { ...config, piImage: { image: "friday-agent:0.1.0", imageId: `sha256:${"b".repeat(64)}` } };
  const piAccess = { ...modelAccess, accessToken: "y".repeat(43), jobId: piSpec.jobId, runnerId: piSpec.runnerId, leaseId: piSpec.leaseId, tool: "pi", model: "pi-test", expiresAt: new Date(Date.parse(piSpec.leaseExpiresAt) - 1_000).toISOString() };
  const piArgs = sandboxDockerArguments(piConfig, { spec: piSpec, worktreePath: piWorktree, modelAccess: piAccess });
  assert.ok(piArgs.includes("friday-agent:0.1.0"));
  assert.equal(piArgs.includes("friday-agent-wrapper"), false);
  assert.equal(piArgs.at(-1), "pi");
});

test("sandbox model relay accepts only pinned CLI routes and Claude's fixed compatibility query", () => {
  assert.deepEqual(modelRelayRoute("POST", "/openai/v1/responses"), { provider: "openai", path: "/openai/v1/responses" });
  assert.deepEqual(modelRelayRoute("POST", "/anthropic/v1/messages?beta=true"), { provider: "anthropic", path: "/anthropic/v1/messages" });
  assert.throws(() => modelRelayRoute("POST", "/openai/v1/responses?beta=true"), /not allowed/);
  assert.throws(() => modelRelayRoute("POST", "/anthropic/v1/messages?beta=false"), /not allowed/);
  assert.throws(() => modelRelayRoute("GET", "/anthropic/v1/messages?beta=true"), /not allowed/);
});

test("Hub artifact storage binds bytes to a live lease and does not expose path traversal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "friday-artifact-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hub = await loadOrCreateHubIdentity(root);
  const registry = new SqliteJobRegistry(join(root, "friday.sqlite"), hub); registry.open(); t.after(() => registry.close());
  const input = { idempotencyKey: randomUUID(), runnerId: randomUUID(), workspaceId: "repo", tool: "agent", operation: "test", prompt: "fixture" };
  const created = registry.create(input); const spec = registry.pull(input.runnerId); assert.ok(spec);
  registry.assertActiveLease(created.job.jobId, input.runnerId, spec.leaseId);
  const bytes = Buffer.from("diff --git a/a b/a\n", "utf8"); const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const store = new JobArtifactStore(root); const artifact = await store.save({ artifactId: randomUUID(), jobId: created.job.jobId, name: "changes.diff", mediaType: "text/x-diff", sha256, sizeBytes: bytes.byteLength }, bytes);
  assert.match(artifact.uri, /^hub:\/\/jobs\//);
  assert.deepEqual(await store.read(created.job.jobId, artifact.artifactId), bytes);
  await assert.rejects(() => store.save({ artifactId: randomUUID(), jobId: created.job.jobId, name: "../escape", mediaType: "text/x-diff", sha256, sizeBytes: bytes.byteLength }, bytes), /name/);
});

test("signed Runner artifact upload becomes an Owner-only downloadable diff", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-artifact-http-")); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const friday = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576 }); t.after(() => friday.stop());
  const address = await friday.start(); const base = `http://${address.host}:${address.port}`; const runnerId = randomUUID(); const keys = generateKeyPairSync("ed25519");
  const enrollment = friday.runnerRegistry.issueEnrollment(Date.now(), runnerId); friday.runnerRegistry.consumeEnrollment(runnerId, enrollment.enrollmentToken, keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const created = friday.jobRegistry.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "repo", tool: "agent", operation: "develop", prompt: "fixture" }); const spec = friday.jobRegistry.pull(runnerId); assert.ok(spec);
  const artifactId = randomUUID(); const bytes = Buffer.from("diff --git a/a b/a\n", "utf8"); const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const path = `/v2/runners/${runnerId}/jobs/${created.job.jobId}/artifacts/${artifactId}`;
  const value = { protocolVersion: JOB_PROTOCOL_VERSION, runnerId, jobId: created.job.jobId, leaseId: spec.leaseId, artifactId, name: "changes.diff", mediaType: "text/x-diff", sha256, sizeBytes: bytes.byteLength, contentBase64: bytes.toString("base64") };
  const raw = JSON.stringify(value); const signature = sign(null, Buffer.from(runnerRequestSignaturePayloadV2("POST", path, raw)), keys.privateKey).toString("base64url");
  const upload = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-friday-runner-signature": signature }, body: raw }); assert.equal(upload.status, 201); const uploaded = await upload.json(); assert.match(uploaded.artifact.uri, /^hub:\/\//);
  const running = { protocolVersion: JOB_PROTOCOL_VERSION, eventId: randomUUID(), jobId: created.job.jobId, runnerId, leaseId: spec.leaseId, sequence: 0, sentAt: new Date().toISOString(), type: "state", state: "RUNNING" };
  const artifactEvent = { protocolVersion: JOB_PROTOCOL_VERSION, eventId: randomUUID(), jobId: created.job.jobId, runnerId, leaseId: spec.leaseId, sequence: 1, sentAt: new Date().toISOString(), type: "artifact", artifact: uploaded.artifact };
  for (const event of [running, artifactEvent]) { const eventPath = `/v2/runners/${runnerId}/jobs/${created.job.jobId}/events`; const eventRaw = JSON.stringify(event); const eventSignature = sign(null, Buffer.from(runnerRequestSignaturePayloadV2("POST", eventPath, eventRaw)), keys.privateKey).toString("base64url"); assert.equal((await fetch(`${base}${eventPath}`, { method: "POST", headers: { "content-type": "application/json", "x-friday-runner-signature": eventSignature }, body: eventRaw })).status, 202); }
  const denied = await fetch(`${base}/v2/jobs/${created.job.jobId}/artifacts/${artifactId}`); assert.equal(denied.status, 401);
  const downloaded = await fetch(`${base}/v2/jobs/${created.job.jobId}/artifacts/${artifactId}`, { headers: { authorization: `Bearer ${ownerToken}` } }); assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
});

test("Pi rpc uses only full private OpenAI-compatible configuration", () => {
  assert.equal(loadPiModelConfig({}), undefined);
  assert.throws(() => loadPiModelConfig({ FRIDAY_PI_BASE_URL: "http://example.test/", FRIDAY_PI_MODEL: "model", FRIDAY_PI_API_KEY: "a-very-long-private-key" }), /HTTPS/);
  const config = loadPiModelConfig({ FRIDAY_PI_BASE_URL: "https://models.example.test/v1/", FRIDAY_PI_MODEL: "private/model", FRIDAY_PI_API_KEY: "a-very-long-private-key" });
  assert.ok(config);
  assert.deepEqual(piRpcLaunchPlan(config).arguments, ["--mode", "rpc"]);
  assert.throws(() => piRpcLaunchPlan(undefined), /NOT_CONFIGURED/);
});
