import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFridayServer } from "../apps/fridayd/dist/server.js";
import { JOB_PROTOCOL_VERSION, runnerRequestSignaturePayloadV2 } from "../packages/protocol/dist/index.js";

const ownerToken = "model-access-owner-token";

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function signedPost(base, keys, path, value) {
  const raw = JSON.stringify(value);
  const signature = sign(null, Buffer.from(runnerRequestSignaturePayloadV2("POST", path, raw)), keys.privateKey).toString("base64url");
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-friday-runner-signature": signature }, body: raw });
}

test("Hub issues a lease-bound model token, hides the upstream key, fixes the model, and revokes on terminal state", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-model-access-"));
  const upstreamCalls = [];
  const upstream = createServer(async (request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += chunk;
    upstreamCalls.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
    response.writeHead(200, { "content-type": "application/json", "x-request-id": "upstream-fixture" });
    response.end(JSON.stringify({ id: "response-fixture", output: [] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.equal(typeof upstreamAddress, "object");
  const upstreamKey = "upstream-private-key-never-leaves-hub";
  const friday = await createFridayServer({
    host: "127.0.0.1",
    port: 0,
    stateDir,
    ownerId: "owner",
    ownerToken,
    runnerModelProxy: {
      openai: { baseUrl: new URL(`http://127.0.0.1:${upstreamAddress.port}/v1/`), apiKey: upstreamKey, codexModel: "fixed-codex-model", piModel: "fixed-pi-model" },
      tokenTtlSeconds: 300,
      requestTimeoutMs: 5_000,
      maxRequestBytes: 1_048_576,
    },
    maxBodyBytes: 1_048_576,
  });
  const address = await friday.start();
  const base = `http://${address.host}:${address.port}`;
  t.after(async () => { await friday.stop(); await closeServer(upstream); await rm(stateDir, { recursive: true, force: true }); });

  const runnerId = randomUUID();
  const keys = generateKeyPairSync("ed25519");
  const enrollment = friday.runnerRegistry.issueEnrollment(Date.now(), runnerId);
  friday.runnerRegistry.consumeEnrollment(runnerId, enrollment.enrollmentToken, keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const created = friday.jobRegistry.create({ idempotencyKey: randomUUID(), runnerId, workspaceId: "repo", tool: "codex", operation: "develop", prompt: "Use the fixture model" });
  friday.jobRegistry.approve(created.job.jobId, "owner");
  const spec = friday.jobRegistry.pull(runnerId);
  assert.ok(spec);

  const request = { protocolVersion: JOB_PROTOCOL_VERSION, requestId: randomUUID(), jobId: spec.jobId, runnerId, leaseId: spec.leaseId, tool: "codex", sentAt: new Date().toISOString() };
  const accessPath = `/v2/runners/${runnerId}/jobs/${spec.jobId}/model-access`;
  const issued = await signedPost(base, keys, accessPath, request);
  assert.equal(issued.status, 201);
  const issuedBody = await issued.json();
  assert.match(issuedBody.grant.accessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(issuedBody).includes(upstreamKey), false);
  assert.equal(issuedBody.grant.model, "fixed-codex-model");
  assert.equal(issuedBody.grant.provider, "openai");
  assert.ok(Date.parse(issuedBody.grant.expiresAt) <= Date.parse(spec.leaseExpiresAt));

  const replay = await signedPost(base, keys, accessPath, request);
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).grant.accessToken, issuedBody.grant.accessToken, "lost responses can be retried idempotently");

  const proxied = await fetch(`${base}/v2/model-proxy/openai/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${issuedBody.grant.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "attacker-selected-model", input: "hello", stream: false }),
  });
  assert.equal(proxied.status, 200);
  assert.equal(proxied.headers.get("x-request-id"), "upstream-fixture");
  assert.equal((await proxied.json()).id, "response-fixture");
  assert.deepEqual(upstreamCalls, [{ path: "/v1/responses", authorization: `Bearer ${upstreamKey}`, body: { model: "fixed-codex-model", input: "hello", stream: false } }]);

  const wrongToolRoute = await fetch(`${base}/v2/model-proxy/openai/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${issuedBody.grant.accessToken}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(wrongToolRoute.status, 401);
  assert.equal(upstreamCalls.length, 1);

  for (const [sequence, state] of [[0, "RUNNING"], [1, "SUCCEEDED"]]) {
    const event = { protocolVersion: JOB_PROTOCOL_VERSION, eventId: randomUUID(), jobId: spec.jobId, runnerId, leaseId: spec.leaseId, sequence, sentAt: new Date().toISOString(), type: "state", state };
    const eventPath = `/v2/runners/${runnerId}/jobs/${spec.jobId}/events`;
    assert.equal((await signedPost(base, keys, eventPath, event)).status, 202);
  }
  const revoked = await fetch(`${base}/v2/model-proxy/openai/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${issuedBody.grant.accessToken}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(revoked.status, 401);
  assert.equal(friday.modelAccessBroker.activeGrantCount(), 0);
});

test("model access endpoint rejects unsigned, mismatched, and disabled requests", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-model-access-disabled-"));
  const friday = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576 });
  const address = await friday.start();
  const base = `http://${address.host}:${address.port}`;
  t.after(async () => { await friday.stop(); await rm(stateDir, { recursive: true, force: true }); });
  const runnerId = randomUUID();
  const jobId = randomUUID();
  const path = `/v2/runners/${runnerId}/jobs/${jobId}/model-access`;
  const value = { protocolVersion: JOB_PROTOCOL_VERSION, requestId: randomUUID(), jobId, runnerId, leaseId: randomUUID(), tool: "codex", sentAt: new Date().toISOString() };
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal(response.status, 503);
  const proxy = await fetch(`${base}/v2/model-proxy/openai/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${"z".repeat(43)}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(proxy.status, 503);
});
