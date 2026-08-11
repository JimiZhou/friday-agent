import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonlEventStore } from "../apps/fridayd/dist/event-store.js";
import {
  createFridayServer,
  RUNNER_SENT_AT_MAX_SKEW_MS,
  runnerSentAtWithinAllowedSkew,
} from "../apps/fridayd/dist/server.js";
import { SqliteRunnerRegistry } from "../apps/fridayd/dist/runner-registry.js";
import { RUNNER_ONLINE_TTL_MS } from "../apps/fridayd/dist/state.js";
import { runnerRequestSignaturePayload } from "../packages/protocol/dist/index.js";

const ownerToken = "runner-state-owner-token";
const runnerToken = Symbol("test-runner-device");
const runnerPrivateKeys = new Map();

function config(stateDir) {
  return {
    host: "127.0.0.1",
    port: 0,
    stateDir,
    ownerId: "owner",
    ownerToken,
    maxBodyBytes: 1_048_576,
  };
}

async function request(baseUrl, path, { method = "GET", token, body } = {}) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const runnerId = body !== undefined && typeof body === "object" && body !== null ? body.runnerId : undefined;
  const runnerPrivateKey = token === runnerToken && typeof runnerId === "string"
    ? runnerPrivateKeys.get(runnerId.toLowerCase())
    : undefined;
  if (token === runnerToken && typeof runnerPrivateKey !== "string") {
    throw new Error(`No enrolled test device is available for Runner ${String(runnerId)}`);
  }
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token === undefined || token === runnerToken ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(runnerPrivateKey === undefined
        ? {}
        : {
            "x-friday-runner-signature": sign(
              null,
              Buffer.from(runnerRequestSignaturePayload(method, path, raw)),
              runnerPrivateKey,
            ).toString("base64url"),
          }),
    },
    body: raw,
  });
}

async function enrollRunner(baseUrl) {
  const issued = await request(baseUrl, "/v1/runners/enrollment-tokens", {
    method: "POST",
    token: ownerToken,
    body: {},
  });
  assert.equal(issued.status, 201);
  const enrollment = await issued.json();
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const enrolled = await request(baseUrl, "/v1/runners/enroll", {
    method: "POST",
    body: {
      protocolVersion: "1",
      runnerId: enrollment.runnerId,
      enrollmentToken: enrollment.enrollmentToken,
      publicKeyPem,
    },
  });
  assert.equal(enrolled.status, 201);
  runnerPrivateKeys.set(enrollment.runnerId, privateKeyPem);
  return enrollment.runnerId;
}

function seedEnrolledRunner(stateDir, runnerId) {
  const keys = generateKeyPairSync("ed25519");
  const registry = new SqliteRunnerRegistry(join(stateDir, "friday.sqlite"));
  registry.open();
  try {
    const enrollment = registry.issueEnrollment(Date.now(), runnerId);
    assert.deepEqual(
      registry.consumeEnrollment(
        runnerId,
        enrollment.enrollmentToken,
        keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
      { outcome: "enrolled", duplicate: false },
    );
  } finally {
    registry.close();
  }
  runnerPrivateKeys.set(runnerId, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

function registerEnvelope(
  runnerId,
  { envelopeId = randomUUID(), sentAt = new Date().toISOString() } = {},
) {
  return {
    protocolVersion: "1",
    envelopeId,
    kind: "register",
    runnerId,
    sentAt,
    payload: {
      displayName: "State test runner",
      version: "0.1.0",
      capabilities: ["orchestration"],
      workspaces: ["friday-agent"],
      shellExecution: false,
    },
  };
}

function heartbeatEnvelope(runnerId, sentAt, status = "online", envelopeId = randomUUID()) {
  return {
    protocolVersion: "1",
    envelopeId,
    kind: "heartbeat",
    runnerId,
    sentAt,
    payload: { status, activeJobs: status === "degraded" ? 2 : 0 },
  };
}

async function startFriday(stateDir) {
  const friday = await createFridayServer(config(stateDir));
  const address = await friday.start();
  return { friday, baseUrl: `http://${address.host}:${address.port}` };
}

async function runnerEvents(baseUrl) {
  const response = await request(baseUrl, "/v1/events", { token: ownerToken });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.events.filter((event) => event.type.startsWith("runner."));
}

test("runner envelopes are durable idempotency keys and liveness uses Hub receipt time", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "fridayd-runner-state-"));
  let active;
  t.after(async () => {
    await active?.friday.stop();
    await rm(stateDir, { recursive: true, force: true });
  });

  active = await startFriday(stateDir);
  const runnerId = await enrollRunner(active.baseUrl);
  const runnerClockBase = Date.now();
  const register = registerEnvelope(runnerId, {
    sentAt: new Date(runnerClockBase).toISOString(),
  });

  const missingShellDeclaration = structuredClone(register);
  delete missingShellDeclaration.payload.shellExecution;
  const missingShellResponse = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: missingShellDeclaration,
  });
  assert.equal(missingShellResponse.status, 400);

  const shellCapability = structuredClone(register);
  shellCapability.payload.capabilities = ["shell"];
  const shellCapabilityResponse = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: shellCapability,
  });
  assert.equal(shellCapabilityResponse.status, 400);

  for (const sentAt of [
    new Date(Date.now() + RUNNER_SENT_AT_MAX_SKEW_MS + 60_000).toISOString(),
    new Date(Date.now() - RUNNER_SENT_AT_MAX_SKEW_MS - 60_000).toISOString(),
  ]) {
    const skewedRegister = registerEnvelope(runnerId, { sentAt });
    const skewedResponse = await request(active.baseUrl, "/v1/runners/register", {
      method: "POST",
      token: runnerToken,
      body: skewedRegister,
    });
    assert.equal(skewedResponse.status, 409);
    assert.equal((await skewedResponse.json()).error.code, "RUNNER_CLOCK_SKEW");
  }
  assert.equal((await runnerEvents(active.baseUrl)).length, 0);

  const beforeRegister = Date.now();
  const registered = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: register,
  });
  const afterRegister = Date.now();
  assert.equal(registered.status, 202);
  assert.equal((await registered.json()).duplicate, false);

  const duplicateRegister = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: register,
  });
  assert.equal(duplicateRegister.status, 200);
  assert.equal((await duplicateRegister.json()).duplicate, true);

  const uppercaseRegisterReplay = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: {
      ...register,
      envelopeId: register.envelopeId.toUpperCase(),
      runnerId: register.runnerId.toUpperCase(),
    },
  });
  assert.equal(uppercaseRegisterReplay.status, 200);
  assert.equal((await uppercaseRegisterReplay.json()).duplicate, true);

  const reorderedRegister = {
    payload: {
      shellExecution: false,
      workspaces: ["friday-agent"],
      capabilities: ["orchestration"],
      version: "0.1.0",
      displayName: "State test runner",
    },
    sentAt: register.sentAt,
    runnerId,
    kind: "register",
    envelopeId: register.envelopeId,
    protocolVersion: "1",
  };
  const reorderedReplay = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: reorderedRegister,
  });
  assert.equal(reorderedReplay.status, 200);
  assert.equal((await reorderedReplay.json()).duplicate, true);

  const changedRegister = structuredClone(register);
  changedRegister.payload.displayName = "Tampered runner";
  const changedRegisterResponse = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: changedRegister,
  });
  assert.equal(changedRegisterResponse.status, 409);
  assert.equal((await changedRegisterResponse.json()).error.code, "ENVELOPE_ID_CONFLICT");
  assert.equal((await runnerEvents(active.baseUrl)).length, 1);

  const degradedHeartbeat = heartbeatEnvelope(
    runnerId,
    new Date(runnerClockBase + 2_000).toISOString(),
    "degraded",
  );

  for (const sentAt of [
    new Date(Date.now() + RUNNER_SENT_AT_MAX_SKEW_MS + 60_000).toISOString(),
    new Date(Date.now() - RUNNER_SENT_AT_MAX_SKEW_MS - 60_000).toISOString(),
  ]) {
    const skewedHeartbeat = heartbeatEnvelope(runnerId, sentAt);
    const skewedResponse = await request(active.baseUrl, `/v1/runners/${runnerId}/heartbeat`, {
      method: "POST",
      token: runnerToken,
      body: skewedHeartbeat,
    });
    assert.equal(skewedResponse.status, 409);
    assert.equal((await skewedResponse.json()).error.code, "RUNNER_CLOCK_SKEW");
  }
  assert.equal((await runnerEvents(active.baseUrl)).length, 1);

  const heartbeat = await request(active.baseUrl, `/v1/runners/${runnerId}/heartbeat`, {
    method: "POST",
    token: runnerToken,
    body: degradedHeartbeat,
  });
  assert.equal(heartbeat.status, 202);

  const duplicateHeartbeat = await request(active.baseUrl, `/v1/runners/${runnerId}/heartbeat`, {
    method: "POST",
    token: runnerToken,
    body: degradedHeartbeat,
  });
  assert.equal(duplicateHeartbeat.status, 200);
  assert.equal((await duplicateHeartbeat.json()).duplicate, true);

  const changedHeartbeat = structuredClone(degradedHeartbeat);
  changedHeartbeat.payload.activeJobs = 1;
  const changedHeartbeatResponse = await request(active.baseUrl, `/v1/runners/${runnerId}/heartbeat`, {
    method: "POST",
    token: runnerToken,
    body: changedHeartbeat,
  });
  assert.equal(changedHeartbeatResponse.status, 409);
  assert.equal((await changedHeartbeatResponse.json()).error.code, "ENVELOPE_ID_CONFLICT");
  assert.equal((await runnerEvents(active.baseUrl)).length, 2);

  const regressedHeartbeat = heartbeatEnvelope(
    runnerId,
    new Date(runnerClockBase + 1_000).toISOString(),
  );
  const regressed = await request(active.baseUrl, `/v1/runners/${runnerId}/heartbeat`, {
    method: "POST",
    token: runnerToken,
    body: regressedHeartbeat,
  });
  assert.equal(regressed.status, 409);
  assert.equal((await regressed.json()).error.code, "HEARTBEAT_SENT_AT_REGRESSION");
  assert.equal((await runnerEvents(active.baseUrl)).length, 2);

  const liveResponse = await request(active.baseUrl, "/v1/runners", { token: ownerToken });
  const liveRunner = (await liveResponse.json()).runners[0];
  assert.equal(liveRunner.online, true);
  assert.equal(liveRunner.status, "degraded");
  assert.equal(liveRunner.activeJobs, 2);
  assert.equal(liveRunner.lastSentAt, degradedHeartbeat.sentAt);
  assert.equal(liveRunner.lastReceivedAt, liveRunner.lastSeenAt);
  assert.notEqual(liveRunner.lastReceivedAt, degradedHeartbeat.sentAt);
  assert.ok(Date.parse(liveRunner.lastReceivedAt) >= beforeRegister);
  assert.ok(Date.parse(liveRunner.lastReceivedAt) <= Date.now());
  assert.ok(afterRegister >= beforeRegister);

  const expired = active.friday.state.runnerView(
    runnerId,
    Date.parse(liveRunner.lastReceivedAt) + RUNNER_ONLINE_TTL_MS + 1,
  );
  assert.equal(expired.online, false);
  assert.equal(expired.status, "unknown");
  assert.equal(expired.activeJobs, 0);

  await active.friday.stop();
  active = await startFriday(stateDir);

  const restoredResponse = await request(active.baseUrl, "/v1/runners", { token: ownerToken });
  const restoredRunner = (await restoredResponse.json()).runners[0];
  assert.equal(restoredRunner.online, false);
  assert.equal(restoredRunner.status, "unknown");
  assert.equal(restoredRunner.activeJobs, 0);

  const restoredRegisterReplay = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: register,
  });
  assert.equal(restoredRegisterReplay.status, 200);
  assert.equal((await restoredRegisterReplay.json()).duplicate, true);

  const restoredChangedRegister = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: changedRegister,
  });
  assert.equal(restoredChangedRegister.status, 409);
  assert.equal((await restoredChangedRegister.json()).error.code, "ENVELOPE_ID_CONFLICT");

  const restoredHeartbeatReplay = await request(active.baseUrl, `/v1/runners/${runnerId}/heartbeat`, {
    method: "POST",
    token: runnerToken,
    body: degradedHeartbeat,
  });
  assert.equal(restoredHeartbeatReplay.status, 200);
  assert.equal((await restoredHeartbeatReplay.json()).duplicate, true);

  const restoredChangedHeartbeat = await request(active.baseUrl, `/v1/runners/${runnerId}/heartbeat`, {
    method: "POST",
    token: runnerToken,
    body: changedHeartbeat,
  });
  assert.equal(restoredChangedHeartbeat.status, 409);
  assert.equal((await restoredChangedHeartbeat.json()).error.code, "ENVELOPE_ID_CONFLICT");
  assert.equal((await runnerEvents(active.baseUrl)).length, 2);

  const replayedViewResponse = await request(active.baseUrl, "/v1/runners", { token: ownerToken });
  const replayedView = (await replayedViewResponse.json()).runners[0];
  assert.equal(replayedView.online, false);
  assert.equal(replayedView.status, "unknown");

  const freshHeartbeat = heartbeatEnvelope(
    runnerId,
    new Date(runnerClockBase + 3_000).toISOString(),
  );
  const fresh = await request(active.baseUrl, `/v1/runners/${runnerId}/heartbeat`, {
    method: "POST",
    token: runnerToken,
    body: freshHeartbeat,
  });
  assert.equal(fresh.status, 202);

  const freshViewResponse = await request(active.baseUrl, "/v1/runners", { token: ownerToken });
  const freshView = (await freshViewResponse.json()).runners[0];
  assert.equal(freshView.online, true);
  assert.equal(freshView.status, "online");
  assert.equal((await runnerEvents(active.baseUrl)).length, 3);
});

test("runner sentAt skew includes both exact five-minute boundaries", () => {
  const receivedAtMs = Date.parse("2026-07-30T00:10:00.000Z");
  const receivedAt = new Date(receivedAtMs).toISOString();

  for (const direction of [-1, 1]) {
    assert.equal(
      runnerSentAtWithinAllowedSkew(
        new Date(receivedAtMs + direction * RUNNER_SENT_AT_MAX_SKEW_MS).toISOString(),
        receivedAt,
      ),
      true,
    );
    assert.equal(
      runnerSentAtWithinAllowedSkew(
        new Date(receivedAtMs + direction * (RUNNER_SENT_AT_MAX_SKEW_MS + 1)).toISOString(),
        receivedAt,
      ),
      false,
    );
  }
});

test("historic exact replay stays idempotent and fresh registration clears future poison", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "fridayd-runner-clock-recovery-"));
  let active;
  t.after(async () => {
    await active?.friday.stop();
    await rm(stateDir, { recursive: true, force: true });
  });

  const eventPath = join(stateDir, "events.jsonl");
  const writer = new JsonlEventStore(eventPath);
  await writer.open();

  const historicRunnerId = randomUUID();
  const historicAt = new Date(Date.now() - RUNNER_SENT_AT_MAX_SKEW_MS - 60_000).toISOString();
  const historicRegister = registerEnvelope(historicRunnerId, { sentAt: historicAt });
  await writer.append("runner.registered", {
    envelope: historicRegister,
    receivedAt: historicAt,
  });

  const poisonedRunnerId = randomUUID();
  const poisonedRegister = registerEnvelope(poisonedRunnerId, {
    sentAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  });
  await writer.append("runner.registered", {
    envelope: poisonedRegister,
    receivedAt: new Date().toISOString(),
  });
  await writer.close();
  seedEnrolledRunner(stateDir, historicRunnerId);
  seedEnrolledRunner(stateDir, poisonedRunnerId);

  active = await startFriday(stateDir);
  const historicReplay = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: historicRegister,
  });
  assert.equal(historicReplay.status, 200);
  assert.equal((await historicReplay.json()).duplicate, true);

  const freshRegister = registerEnvelope(poisonedRunnerId);
  const recovered = await request(active.baseUrl, "/v1/runners/register", {
    method: "POST",
    token: runnerToken,
    body: freshRegister,
  });
  assert.equal(recovered.status, 202);

  const freshHeartbeat = heartbeatEnvelope(
    poisonedRunnerId,
    new Date(Date.now() + 1_000).toISOString(),
  );
  const heartbeat = await request(active.baseUrl, `/v1/runners/${poisonedRunnerId}/heartbeat`, {
    method: "POST",
    token: runnerToken,
    body: freshHeartbeat,
  });
  assert.equal(heartbeat.status, 202);
  assert.equal(active.friday.state.runners.get(poisonedRunnerId).lastSentAt, freshHeartbeat.sentAt);
  assert.equal((await runnerEvents(active.baseUrl)).length, 4);
});

test("invalid rehydrated runner events fail closed and release the event-store lock", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "fridayd-invalid-state-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const eventPath = join(stateDir, "events.jsonl");

  const writer = new JsonlEventStore(eventPath);
  await writer.open();
  await writer.append("runner.registered", { unexpected: true });
  await writer.close();

  await assert.rejects(
    () => createFridayServer(config(stateDir)),
    /Invalid runner\.registered event at sequence 1/,
  );

  const lockProbe = new JsonlEventStore(eventPath);
  await lockProbe.open();
  await lockProbe.close();
});
