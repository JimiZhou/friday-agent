import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, verify } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runnerRequestSignaturePayload } from "../packages/protocol/dist/index.js";
import {
  FridayRunner,
  loadRunnerConfig,
  RunnerWorkspaceRegistry,
  RUNNER_DEVICE_STATE_FILE,
  RUNNER_VERSION,
} from "../apps/runner/dist/index.js";
import { createFridayServer } from "../apps/fridayd/dist/server.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENROLLMENT_TOKEN = Buffer.alloc(32, 7).toString("base64url");

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function readRequest(request) {
  let raw = "";
  request.setEncoding("utf8");
  for await (const chunk of request) raw += chunk;
  return { raw, body: JSON.parse(raw) };
}

function assertBaseEnvelope(envelope, kind, runnerId) {
  assert.deepEqual(Object.keys(envelope).sort(), [
    "envelopeId",
    "kind",
    "payload",
    "protocolVersion",
    "runnerId",
    "sentAt",
  ]);
  assert.equal(envelope.protocolVersion, "1");
  assert.match(envelope.envelopeId, UUID_RE);
  assert.equal(envelope.kind, kind);
  assert.equal(envelope.runnerId, runnerId);
  assert.equal(Number.isNaN(Date.parse(envelope.sentAt)), false);
}

function runnerEnvironment(port, stateDirectory, extra = {}) {
  return {
    FRIDAY_HUB_URL: `http://127.0.0.1:${port}`,
    FRIDAY_RUNNER_STATE_DIR: stateDirectory,
    FRIDAY_RUNNER_ENROLLMENT_TOKEN: ENROLLMENT_TOKEN,
    FRIDAY_REQUEST_TIMEOUT_MS: "2000",
    ...extra,
  };
}

test("runner persists an Ed25519 device identity, enrolls once, and signs register and heartbeat envelopes", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-test-"));
  const firstWorkspace = await mkdtemp(join(tmpdir(), "friday-runner-workspace-"));
  const secondWorkspace = await mkdtemp(join(tmpdir(), "friday-runner-workspace-"));
  const received = [];
  const enrolledKeys = new Map();
  const hub = createServer(async (request, response) => {
    try {
      const receivedRequest = {
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        signature: request.headers["x-friday-runner-signature"],
        contentType: request.headers["content-type"],
        ...(await readRequest(request)),
      };
      received.push(receivedRequest);
      if (request.url === "/v1/runners/enroll") {
        assert.equal(receivedRequest.body.enrollmentToken, ENROLLMENT_TOKEN);
        enrolledKeys.set(receivedRequest.body.runnerId, receivedRequest.body.publicKeyPem);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ enrolled: true, duplicate: false }));
        return;
      }

      const key = enrolledKeys.get(receivedRequest.body.runnerId);
      assert.equal(typeof receivedRequest.signature, "string");
      assert.equal(
        verify(
          null,
          Buffer.from(runnerRequestSignaturePayload("POST", request.url, receivedRequest.raw)),
          key,
          Buffer.from(receivedRequest.signature, "base64url"),
        ),
        true,
      );
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: received.length }));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  t.after(async () => {
    await closeServer(hub);
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(firstWorkspace, { recursive: true, force: true });
    await rm(secondWorkspace, { recursive: true, force: true });
  });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  const address = hub.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const environment = runnerEnvironment(address.port, stateDirectory, {
    FRIDAY_RUNNER_NAME: "Test runner",
    FRIDAY_WORKSPACES: "friday-agent,diagnostics,friday-agent",
    FRIDAY_HEARTBEAT_INTERVAL_MS: "25",
  });
  const registry = new RunnerWorkspaceRegistry(stateDirectory);
  registry.register("friday-agent", firstWorkspace);
  registry.register("diagnostics", secondWorkspace);
  const firstConfig = loadRunnerConfig(environment);
  const restoredConfig = loadRunnerConfig(environment);
  assert.match(firstConfig.runnerId, UUID_RE);
  assert.equal(restoredConfig.runnerId, firstConfig.runnerId);
  assert.equal(restoredConfig.device.publicKeyPem, firstConfig.device.publicKeyPem);
  assert.equal((await stat(join(stateDirectory, RUNNER_DEVICE_STATE_FILE))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(stateDirectory, RUNNER_DEVICE_STATE_FILE), "utf8")).includes(ENROLLMENT_TOKEN), false);

  const runner = new FridayRunner(restoredConfig);
  assert.deepEqual(runner.capabilities(), {
    protocolVersion: "1",
    runnerVersion: RUNNER_VERSION,
    capabilities: ["orchestration"],
    workspaces: ["friday-agent", "diagnostics"],
    shellExecution: false,
  });
  assert.deepEqual(await runner.register(), { accepted: 2 });
  assert.deepEqual(await runner.heartbeat(), { accepted: 3 });
  assert.equal(received.length, 3);

  const [enrollment, registration, heartbeat] = received;
  assert.equal(enrollment.path, "/v1/runners/enroll");
  assert.equal(enrollment.authorization, undefined);
  assert.equal(enrollment.signature, undefined);
  assert.equal(registration.path, "/v1/runners/register");
  assert.equal(registration.authorization, undefined);
  assert.equal(registration.contentType, "application/json");
  assertBaseEnvelope(registration.body, "register", firstConfig.runnerId);
  assert.deepEqual(registration.body.payload, {
    displayName: "Test runner",
    version: RUNNER_VERSION,
    capabilities: ["orchestration"],
    workspaces: ["friday-agent", "diagnostics"],
    shellExecution: false,
  });
  assert.equal(heartbeat.path, `/v1/runners/${encodeURIComponent(firstConfig.runnerId)}/heartbeat`);
  assert.equal(heartbeat.authorization, undefined);
  assertBaseEnvelope(heartbeat.body, "heartbeat", firstConfig.runnerId);
  assert.deepEqual(heartbeat.body.payload, { status: "online", activeJobs: 0 });
  assert.notEqual(heartbeat.body.envelopeId, registration.body.envelopeId);

  const enrolledConfig = loadRunnerConfig({
    ...environment,
    FRIDAY_RUNNER_ENROLLMENT_TOKEN: undefined,
  });
  assert.notEqual(enrolledConfig.device.enrolledAt, undefined);
  await chmod(join(stateDirectory, RUNNER_DEVICE_STATE_FILE), 0o644);
  assert.throws(
    () => loadRunnerConfig(environment),
    /runner-device\.json must be a regular file with mode 0600/,
  );
});

test("runner rejects the retired shared token and validates the one-time enrollment token", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-token-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const base = {
    FRIDAY_RUNNER_STATE_DIR: stateDirectory,
    FRIDAY_RUNNER_ID: "8d86b61d-b60f-412d-a434-4d34ee193b31",
  };

  assert.throws(
    () => loadRunnerConfig({ ...base, FRIDAY_RUNNER_TOKEN: "obsolete-runner-token" }),
    /FRIDAY_RUNNER_TOKEN is no longer supported/,
  );
  for (const token of ["short", "contains whitespace", "x".repeat(44)]) {
    assert.throws(
      () => loadRunnerConfig({ ...base, FRIDAY_RUNNER_ENROLLMENT_TOKEN: token }),
      /FRIDAY_RUNNER_ENROLLMENT_TOKEN must be a 32-byte base64url token/,
    );
  }
  assert.equal(
    loadRunnerConfig({ ...base, FRIDAY_RUNNER_ENROLLMENT_TOKEN: ENROLLMENT_TOKEN }).enrollmentToken,
    ENROLLMENT_TOKEN,
  );
});

test("runner consumes a private enrollment handoff file only after Hub enrollment succeeds", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-token-file-test-"));
  const tokenFile = join(stateDirectory, "enrollment-token");
  await writeFile(tokenFile, `${ENROLLMENT_TOKEN}\n`, { mode: 0o600 });
  const hub = createServer(async (request, response) => {
    const received = await readRequest(request);
    if (request.url === "/v1/runners/enroll") {
      assert.equal(received.body.enrollmentToken, ENROLLMENT_TOKEN);
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    assert.equal(request.url, "/v1/runners/register");
    response.writeHead(202, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(async () => {
    await closeServer(hub);
    await rm(stateDirectory, { recursive: true, force: true });
  });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  const address = hub.address();
  assert.equal(typeof address, "object");
  const config = loadRunnerConfig({
    FRIDAY_HUB_URL: `http://127.0.0.1:${address.port}`,
    FRIDAY_RUNNER_STATE_DIR: stateDirectory,
    FRIDAY_RUNNER_ID: randomUUID(),
    FRIDAY_RUNNER_ENROLLMENT_FILE: tokenFile,
  });
  assert.equal(config.enrollmentToken, ENROLLMENT_TOKEN);
  assert.equal(config.enrollmentTokenFile, tokenFile);
  await new FridayRunner(config).register();
  await assert.rejects(readFile(tokenFile), { code: "ENOENT" });

  assert.throws(
    () => loadRunnerConfig({
      FRIDAY_RUNNER_STATE_DIR: join(stateDirectory, "other"),
      FRIDAY_RUNNER_ENROLLMENT_TOKEN: ENROLLMENT_TOKEN,
      FRIDAY_RUNNER_ENROLLMENT_FILE: tokenFile,
    }),
    /Use only one/,
  );
});

test("runner refuses an environment workspace list that does not match its local registry", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-workspaces-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const base = {
    FRIDAY_RUNNER_STATE_DIR: stateDirectory,
    FRIDAY_RUNNER_ID: "8d86b61d-b60f-412d-a434-4d34ee193b31",
  };
  assert.deepEqual(loadRunnerConfig(base).workspaces, []);
  assert.throws(
    () => loadRunnerConfig({ ...base, FRIDAY_WORKSPACES: "unregistered-workspace" }),
    /FRIDAY_WORKSPACES must exactly match the local workspace registry/,
  );
});

test("runner sends device signatures only to HTTPS or an explicit loopback HTTP Hub", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-url-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const base = {
    FRIDAY_RUNNER_STATE_DIR: stateDirectory,
    FRIDAY_RUNNER_ID: "8d86b61d-b60f-412d-a434-4d34ee193b31",
  };
  for (const hubUrl of ["http://localhost:4310", "http://127.0.0.2:4310", "http://100.64.0.10:4310", "http://private-hub.example:4310"]) {
    assert.throws(() => loadRunnerConfig({ ...base, FRIDAY_HUB_URL: hubUrl }), /plain HTTP only with 127\.0\.0\.1 or ::1/);
  }
  assert.equal(loadRunnerConfig({ ...base, FRIDAY_HUB_URL: "http://127.0.0.1:4310" }).hubUrl.href, "http://127.0.0.1:4310/");
  assert.equal(loadRunnerConfig({ ...base, FRIDAY_HUB_URL: "http://[::1]:4310" }).hubUrl.href, "http://[::1]:4310/");
  assert.equal(loadRunnerConfig({ ...base, FRIDAY_HUB_URL: "https://private-hub.example" }).hubUrl.href, "https://private-hub.example/");
});

test("runner refuses redirects instead of forwarding its device signature", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-redirect-test-"));
  const received = [];
  const hub = createServer(async (request, response) => {
    const payload = await readRequest(request);
    received.push({ path: request.url, signature: request.headers["x-friday-runner-signature"], ...payload });
    if (request.url === "/v1/runners/enroll") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(307, { "content-type": "application/json", location: "/capture" });
    response.end(JSON.stringify({ redirect: true }));
  });
  t.after(async () => {
    await closeServer(hub);
    await rm(stateDirectory, { recursive: true, force: true });
  });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  const address = hub.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const runner = new FridayRunner(loadRunnerConfig(runnerEnvironment(address.port, stateDirectory)));
  await assert.rejects(() => runner.register());
  const protectedRequests = received.filter(({ path }) => path === "/v1/runners/register");
  assert.equal(protectedRequests.length, 2);
  assert.ok(protectedRequests.every(({ signature }) => typeof signature === "string"));
  assert.equal(protectedRequests[1].raw, protectedRequests[0].raw);
  assert.equal(protectedRequests[1].signature, protectedRequests[0].signature);
  assert.equal(received.some(({ path }) => path === "/capture"), false);
});

test("runner retries a lost response with the same signed envelope and accepts Hub replay success", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-retry-test-"));
  const received = [];
  const hub = createServer(async (request, response) => {
    const payload = await readRequest(request);
    received.push({ path: request.url, signature: request.headers["x-friday-runner-signature"], ...payload });
    if (request.url === "/v1/runners/enroll") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const protectedRequests = received.filter(({ path }) => path === "/v1/runners/register");
    if (protectedRequests.length === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true, duplicate: true }));
  });
  t.after(async () => {
    await closeServer(hub);
    await rm(stateDirectory, { recursive: true, force: true });
  });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  const address = hub.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const runner = new FridayRunner(loadRunnerConfig(runnerEnvironment(address.port, stateDirectory)));
  assert.deepEqual(await runner.register(), { accepted: true, duplicate: true });
  const protectedRequests = received.filter(({ path }) => path === "/v1/runners/register");
  assert.equal(protectedRequests.length, 2);
  assert.equal(protectedRequests[1].raw, protectedRequests[0].raw);
  assert.equal(protectedRequests[1].signature, protectedRequests[0].signature);
});

test("runner retries a lost enrollment response without regenerating its device identity", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-enrollment-retry-test-"));
  const received = [];
  const hub = createServer(async (request, response) => {
    const payload = await readRequest(request);
    received.push({ path: request.url, ...payload });
    const enrollments = received.filter(({ path }) => path === "/v1/runners/enroll");
    if (request.url === "/v1/runners/enroll" && enrollments.length === 1) {
      request.socket.destroy();
      return;
    }
    if (request.url === "/v1/runners/enroll") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ enrolled: true, duplicate: true }));
      return;
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true }));
  });
  t.after(async () => {
    await closeServer(hub);
    await rm(stateDirectory, { recursive: true, force: true });
  });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  const address = hub.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const runner = new FridayRunner(loadRunnerConfig(runnerEnvironment(address.port, stateDirectory)));
  assert.deepEqual(await runner.register(), { accepted: true });
  const enrollments = received.filter(({ path }) => path === "/v1/runners/enroll");
  assert.equal(enrollments.length, 2);
  assert.equal(enrollments[1].raw, enrollments[0].raw);
  assert.equal(enrollments[1].body.publicKeyPem, enrollments[0].body.publicKeyPem);
  assert.equal(received.filter(({ path }) => path === "/v1/runners/register").length, 1);
});

test("runner obtains a device-signed model grant before handing an Agent Job to sandboxd", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-model-job-"));
  const workspace = await mkdtemp(join(tmpdir(), "friday-runner-model-workspace-"));
  const hubState = await mkdtemp(join(tmpdir(), "friday-runner-model-hub-"));
  const socketPath = join(stateDirectory, "sandbox.sock");
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "friday@example.invalid"]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Friday Test"]);
  await writeFile(join(workspace, "README.md"), "fixture\n");
  execFileSync("git", ["-C", workspace, "add", "README.md"]);
  execFileSync("git", ["-C", workspace, "commit", "-qm", "fixture"]);

  const friday = await createFridayServer({
    host: "127.0.0.1",
    port: 0,
    stateDir: hubState,
    ownerId: "owner",
    ownerToken: "runner-model-owner-token",
    runnerModelProxy: {
      openai: { baseUrl: new URL("http://127.0.0.1:9/v1/"), apiKey: "hub-only-upstream-key", codexModel: "fixed-codex-model", piModel: "fixed-pi-model" },
      tokenTtlSeconds: 300,
      requestTimeoutMs: 5_000,
      maxRequestBytes: 1_048_576,
    },
    maxBodyBytes: 1_048_576,
  });
  const address = await friday.start();
  const enrollment = friday.runnerRegistry.issueEnrollment();
  new RunnerWorkspaceRegistry(stateDirectory).register("repo", workspace);
  const config = loadRunnerConfig({
    FRIDAY_HUB_URL: `http://${address.host}:${address.port}`,
    FRIDAY_RUNNER_STATE_DIR: stateDirectory,
    FRIDAY_RUNNER_ID: enrollment.runnerId,
    FRIDAY_RUNNER_ENROLLMENT_TOKEN: enrollment.enrollmentToken,
    FRIDAY_HEARTBEAT_INTERVAL_MS: "10",
    FRIDAY_REQUEST_TIMEOUT_MS: "2000",
    FRIDAY_SANDBOX_SOCKET: socketPath,
  });
  const runner = new FridayRunner(config);
  await runner.register();
  const created = friday.jobRegistry.create({ idempotencyKey: randomUUID(), runnerId: config.runnerId, workspaceId: "repo", tool: "codex", operation: "develop", prompt: "Inspect the fixture" });
  friday.jobRegistry.approve(created.job.jobId, "owner");

  const sandboxRequests = [];
  const controller = new AbortController();
  const failSafe = setTimeout(() => controller.abort(), 5_000);
  const sandbox = createNetServer((socket) => {
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { raw += chunk; });
    socket.once("end", () => {
      sandboxRequests.push(JSON.parse(raw));
      socket.end(JSON.stringify({ ok: true, exitCode: 0, stdout: "fixture complete", stderr: "", executorImageId: `sha256:${"d".repeat(64)}` }));
      controller.abort();
    });
  });
  sandbox.listen(socketPath);
  await once(sandbox, "listening");
  t.after(async () => {
    await closeServer(sandbox);
    await friday.stop();
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(hubState, { recursive: true, force: true });
  });

  await runner.run(controller.signal);
  assert.equal(sandboxRequests.length, 1);
  assert.equal(sandboxRequests[0].spec.jobId, created.job.jobId);
  assert.equal(sandboxRequests[0].modelAccess.tool, "codex");
  assert.equal(sandboxRequests[0].modelAccess.model, "fixed-codex-model");
  assert.match(sandboxRequests[0].modelAccess.accessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(sandboxRequests[0]).includes("hub-only-upstream-key"), false);
  assert.equal(friday.jobRegistry.get(created.job.jobId).status, "SUCCEEDED");
});

test("Remote Agent completes a multi-step evidence loop on a non-Git managed node", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-agent-loop-"));
  const nodeRoot = await mkdtemp(join(tmpdir(), "friday-runner-agent-node-"));
  const hubState = await mkdtemp(join(tmpdir(), "friday-runner-agent-hub-"));
  const socketPath = join(stateDirectory, "sandbox.sock");
  const friday = await createFridayServer({
    host: "127.0.0.1", port: 0, stateDir: hubState, ownerId: "owner", ownerToken: "runner-agent-owner-token",
    runnerModelProxy: { openai: { baseUrl: new URL("http://127.0.0.1:9/v1/"), apiKey: "hub-only-upstream-key", codexModel: "fixed-codex-model", piModel: "fixed-pi-model" }, tokenTtlSeconds: 300, requestTimeoutMs: 5_000, maxRequestBytes: 1_048_576 },
    maxBodyBytes: 1_048_576,
  });
  const address = await friday.start();
  const enrollment = friday.runnerRegistry.issueEnrollment();
  new RunnerWorkspaceRegistry(stateDirectory).register("node", nodeRoot);
  const config = loadRunnerConfig({ FRIDAY_HUB_URL: `http://${address.host}:${address.port}`, FRIDAY_RUNNER_STATE_DIR: stateDirectory, FRIDAY_RUNNER_ID: enrollment.runnerId, FRIDAY_RUNNER_ENROLLMENT_TOKEN: enrollment.enrollmentToken, FRIDAY_HEARTBEAT_INTERVAL_MS: "10", FRIDAY_REQUEST_TIMEOUT_MS: "2000", FRIDAY_SANDBOX_SOCKET: socketPath });
  const runner = new FridayRunner(config);
  await runner.register();
  const created = friday.jobRegistry.create({ idempotencyKey: randomUUID(), runnerId: config.runnerId, workspaceId: "node", tool: "agent", operation: "diagnose", prompt: "Read the host mapping and report evidence" }).job;
  const sandboxRequests = [];
  const controller = new AbortController();
  const failSafe = setTimeout(() => controller.abort(), 5_000);
  const sandbox = createNetServer((socket) => {
    let raw = "";
    socket.setEncoding("utf8"); socket.on("data", (chunk) => { raw += chunk; });
    socket.once("end", () => {
      const request = JSON.parse(raw); sandboxRequests.push(request);
      const stdout = sandboxRequests.length === 1
        ? JSON.stringify({ type: "finish", summary: "Everything is fine." })
        : sandboxRequests.length === 2
          ? JSON.stringify({ type: "tool_call", callId: randomUUID(), name: "file.read", arguments: { path: "/tmp", maxBytes: 65536 }, reason: "Try a candidate evidence path" })
          : sandboxRequests.length === 3
            ? JSON.stringify({ type: "tool_call", callId: randomUUID(), name: "file.read", arguments: { path: "/etc/hosts", maxBytes: 65536 }, reason: "Recover from the failed path and obtain real node evidence" })
            : JSON.stringify({ type: "finish", summary: "Verified the managed node host mapping from /etc/hosts; the result is based on the returned file hash and contents." });
      socket.end(JSON.stringify({ ok: true, exitCode: 0, stdout, stderr: "", executorImageId: `sha256:${"e".repeat(64)}` }));
      if (sandboxRequests.length === 4) { clearTimeout(failSafe); controller.abort(); }
    });
  });
  sandbox.listen(socketPath); await once(sandbox, "listening");
  t.after(async () => { clearTimeout(failSafe); await closeServer(sandbox); await friday.stop(); await rm(stateDirectory, { recursive: true, force: true }); await rm(nodeRoot, { recursive: true, force: true }); await rm(hubState, { recursive: true, force: true }); });
  await runner.run(controller.signal);
  assert.equal(sandboxRequests.length, 4);
  assert.equal(sandboxRequests[0].modelAccess.tool, "agent");
  assert.equal(sandboxRequests[0].worktreePath, await realpath(join(stateDirectory, "jobs", created.jobId, "worktree")));
  assert.match(sandboxRequests[1].agentPrompt, /no real node observation/);
  assert.match(sandboxRequests[2].agentPrompt, /outside the node read allow-list/);
  assert.match(sandboxRequests[3].agentPrompt, /toolExchanges/);
  assert.match(sandboxRequests[3].agentPrompt, /\/etc\/hosts|\/private\/etc\/hosts/);
  assert.match(sandboxRequests[3].agentPrompt, /sha256/);
  assert.equal(friday.jobRegistry.get(created.jobId).status, "SUCCEEDED");
  assert.match(friday.jobRegistry.listEvents(created.jobId).find((entry) => entry.event.type === "output").event.chunk, /Verified the managed node/);
});

test("Remote Agent repairs a malformed model action without discarding real observations", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-runner-agent-repair-"));
  const nodeRoot = await mkdtemp(join(tmpdir(), "friday-runner-agent-repair-node-"));
  const hubState = await mkdtemp(join(tmpdir(), "friday-runner-agent-repair-hub-"));
  const socketPath = join(stateDirectory, "sandbox.sock");
  const friday = await createFridayServer({
    host: "127.0.0.1", port: 0, stateDir: hubState, ownerId: "owner", ownerToken: "runner-agent-repair-owner-token",
    runnerModelProxy: { openai: { baseUrl: new URL("http://127.0.0.1:9/v1/"), apiKey: "hub-only-upstream-key", codexModel: "fixed-codex-model", piModel: "fixed-pi-model" }, tokenTtlSeconds: 300, requestTimeoutMs: 5_000, maxRequestBytes: 1_048_576 },
    maxBodyBytes: 1_048_576,
  });
  const address = await friday.start();
  const enrollment = friday.runnerRegistry.issueEnrollment();
  new RunnerWorkspaceRegistry(stateDirectory).register("node", nodeRoot);
  const config = loadRunnerConfig({ FRIDAY_HUB_URL: `http://${address.host}:${address.port}`, FRIDAY_RUNNER_STATE_DIR: stateDirectory, FRIDAY_RUNNER_ID: enrollment.runnerId, FRIDAY_RUNNER_ENROLLMENT_TOKEN: enrollment.enrollmentToken, FRIDAY_HEARTBEAT_INTERVAL_MS: "10", FRIDAY_REQUEST_TIMEOUT_MS: "2000", FRIDAY_SANDBOX_SOCKET: socketPath });
  const runner = new FridayRunner(config);
  await runner.register();
  const created = friday.jobRegistry.create({ idempotencyKey: randomUUID(), runnerId: config.runnerId, workspaceId: "node", tool: "agent", operation: "diagnose", prompt: "Read host identity" }).job;
  const sandboxRequests = [];
  const controller = new AbortController();
  const failSafe = setTimeout(() => controller.abort(), 5_000);
  const sandbox = createNetServer((socket) => {
    let raw = "";
    socket.setEncoding("utf8"); socket.on("data", (chunk) => { raw += chunk; });
    socket.once("end", () => {
      const request = JSON.parse(raw); sandboxRequests.push(request);
      const stdout = sandboxRequests.length === 1
        ? JSON.stringify({ type: "tool_call", callId: randomUUID(), name: "file.read", arguments: { path: "/etc/hosts" }, reason: "Observe host identity" })
        : sandboxRequests.length === 2
          ? JSON.stringify({ type: "tool_call", callId: randomUUID(), name: "file.read", arguments: { path: "/etc/hosts" }, reason: "Invalid extra field", risk: "R0" })
          : JSON.stringify({ type: "finish", summary: "Verified host identity from the observed hosts file." });
      socket.end(JSON.stringify({ ok: true, exitCode: 0, stdout, stderr: "", executorImageId: `sha256:${"f".repeat(64)}` }));
      if (sandboxRequests.length === 3) { clearTimeout(failSafe); controller.abort(); }
    });
  });
  sandbox.listen(socketPath); await once(sandbox, "listening");
  t.after(async () => { clearTimeout(failSafe); await closeServer(sandbox); await friday.stop(); await rm(stateDirectory, { recursive: true, force: true }); await rm(nodeRoot, { recursive: true, force: true }); await rm(hubState, { recursive: true, force: true }); });
  await runner.run(controller.signal);
  assert.equal(sandboxRequests.length, 3);
  assert.match(sandboxRequests[2].agentPrompt, /previous response was rejected/);
  assert.match(sandboxRequests[2].agentPrompt, /toolExchanges/);
  assert.match(sandboxRequests[2].agentPrompt, /\/etc\/hosts|\/private\/etc\/hosts/);
  assert.equal(friday.jobRegistry.get(created.jobId).status, "SUCCEEDED");
});
