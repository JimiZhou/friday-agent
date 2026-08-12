import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlEventStore } from "../apps/fridayd/dist/event-store.js";
import { createFridayServer } from "../apps/fridayd/dist/server.js";
import { FridayRunner, loadRunnerConfig } from "../apps/runner/dist/index.js";
import { runnerRequestSignaturePayload } from "../packages/protocol/dist/index.js";

const ownerToken = "test-owner-token";

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
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function signedRunnerRequest(baseUrl, path, body, privateKeyPem) {
  const raw = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-friday-runner-signature": sign(
        null,
        Buffer.from(runnerRequestSignaturePayload("POST", path, raw)),
        privateKeyPem,
      ).toString("base64url"),
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
  return { runnerId: enrollment.runnerId, privateKeyPem };
}

test("fridayd accepts one owner, registers a runner, and restores its event log", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "fridayd-test-"));
  let friday;
  let restored;
  t.after(async () => {
    await restored?.stop();
    await friday?.stop();
    await rm(stateDir, { recursive: true, force: true });
  });

  friday = await createFridayServer(config(stateDir));
  const address = await friday.start();
  let baseUrl = `http://${address.host}:${address.port}`;

  const health = await request(baseUrl, "/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).protocolVersion, "1");

  const unauthorized = await request(baseUrl, "/v1/info");
  assert.equal(unauthorized.status, 401);

  const messageId = randomUUID();
  const sensitiveText = "Authorization: Bearer must-not-reach-the-event-log";
  const sensitiveUri = "https://attachments.invalid/audio.wav?signature=must-not-persist";
  const message = {
    protocolVersion: "1",
    messageId,
    channel: "web",
    senderId: "owner",
    conversationId: "web-main",
    authStrength: "strong",
    receivedAt: new Date().toISOString(),
    content: {
      kind: "mixed",
      text: sensitiveText,
      attachments: [
        {
          attachmentId: randomUUID(),
          kind: "audio",
          mimeType: "audio/wav",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
          uri: sensitiveUri,
        },
      ],
    },
  };
  const accepted = await request(baseUrl, "/v1/messages", {
    method: "POST",
    token: ownerToken,
    body: message,
  });
  assert.equal(accepted.status, 202);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.duplicate, false);
  assert.equal(acceptedBody.job.status, "NEW");

  const duplicate = await request(baseUrl, "/v1/messages", {
    method: "POST",
    token: ownerToken,
    body: message,
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const uppercaseUuidReplay = await request(baseUrl, "/v1/messages", {
    method: "POST",
    token: ownerToken,
    body: { ...message, messageId: message.messageId.toUpperCase() },
  });
  assert.equal(uppercaseUuidReplay.status, 200);
  assert.equal((await uppercaseUuidReplay.json()).duplicate, true);

  const runner = await enrollRunner(baseUrl);
  const runnerId = runner.runnerId;
  const register = {
    protocolVersion: "1",
    envelopeId: randomUUID(),
    kind: "register",
    runnerId,
    sentAt: new Date().toISOString(),
    payload: {
      displayName: "Mac mini",
      version: "0.2.1",
      capabilities: ["orchestration"],
      workspaces: ["demo"],
      shellExecution: false,
    },
  };
  const registered = await signedRunnerRequest(baseUrl, "/v1/runners/register", register, runner.privateKeyPem);
  assert.equal(registered.status, 202);

  const heartbeat = {
    protocolVersion: "1",
    envelopeId: randomUUID(),
    kind: "heartbeat",
    runnerId,
    sentAt: new Date().toISOString(),
    payload: { status: "online", activeJobs: 0 },
  };
  const heartbeatResponse = await signedRunnerRequest(
    baseUrl,
    `/v1/runners/${runnerId}/heartbeat`,
    heartbeat,
    runner.privateKeyPem,
  );
  assert.equal(heartbeatResponse.status, 202);

  const eventsResponse = await request(baseUrl, "/v1/events", { token: ownerToken });
  const eventsBody = await eventsResponse.json();
  assert.deepEqual(
    eventsBody.events.map((event) => event.sequence),
    [1, 2, 3],
  );
  assert.ok(eventsBody.events.every((event) => /^[0-9a-f]{64}$/.test(event.hash)));
  const acceptedEvent = eventsBody.events.find((event) => event.type === "message.accepted");
  assert.deepEqual(Object.keys(acceptedEvent.payload).sort(), ["job", "messageDigest", "messageId"]);
  assert.equal(acceptedEvent.payload.messageId, messageId);
  assert.match(acceptedEvent.payload.messageDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(eventsBody).includes(sensitiveText), false);
  assert.equal(JSON.stringify(eventsBody).includes(sensitiveUri), false);

  const sqliteBytes = await Promise.all(
    ["friday.sqlite", "friday.sqlite-shm", "friday.sqlite-wal"].map(async (name) => {
      try {
        return await readFile(join(stateDir, name));
      } catch (error) {
        if (error.code === "ENOENT") return Buffer.alloc(0);
        throw error;
      }
    }),
  );
  const durableBytes = Buffer.concat(sqliteBytes);
  assert.equal(durableBytes.includes(sensitiveText), false);
  assert.equal(durableBytes.includes(sensitiveUri), false);

  const jobId = acceptedBody.job.jobId;
  await friday.stop();

  restored = await createFridayServer(config(stateDir));
  const restoredAddress = await restored.start();
  baseUrl = `http://${restoredAddress.host}:${restoredAddress.port}`;

  const restoredJob = await request(baseUrl, `/v1/jobs/${jobId}`, { token: ownerToken });
  assert.equal(restoredJob.status, 200);
  assert.equal((await restoredJob.json()).job.sourceMessageId, messageId);

  const restoredRunners = await request(baseUrl, "/v1/runners", { token: ownerToken });
  assert.equal(restoredRunners.status, 200);
  assert.equal((await restoredRunners.json()).runners[0].nodeId, runnerId);
});

test("an enrolled Runner interoperates with fridayd while unsigned and legacy-token requests fail closed", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "fridayd-device-auth-"));
  const runnerStateDir = join(stateDir, "runner");
  const friday = await createFridayServer(config(stateDir));
  t.after(async () => {
    await friday.stop();
    await rm(stateDir, { recursive: true, force: true });
  });
  const address = await friday.start();
  const baseUrl = `http://${address.host}:${address.port}`;
  const unsigned = {
    protocolVersion: "1",
    envelopeId: randomUUID(),
    kind: "register",
    runnerId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: {
      displayName: "Untrusted",
      version: "0.2.1",
      capabilities: ["orchestration"],
      workspaces: [],
      shellExecution: false,
    },
  };
  const rejected = await request(baseUrl, "/v1/runners/register", {
    method: "POST",
    token: "obsolete-shared-runner-token",
    body: unsigned,
  });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).error.code, "RUNNER_DEVICE_AUTH_REQUIRED");

  const issued = await request(baseUrl, "/v1/runners/enrollment-tokens", {
    method: "POST",
    token: ownerToken,
    body: {},
  });
  assert.equal(issued.status, 201);
  const enrollment = await issued.json();
  const runner = new FridayRunner(
    loadRunnerConfig({
      FRIDAY_HUB_URL: baseUrl,
      FRIDAY_RUNNER_STATE_DIR: runnerStateDir,
      FRIDAY_RUNNER_ID: enrollment.runnerId,
      FRIDAY_RUNNER_ENROLLMENT_TOKEN: enrollment.enrollmentToken,
      FRIDAY_RUNNER_NAME: "Integrated runner",
    }),
  );
  const registered = await runner.register();
  assert.equal(registered.accepted, true);
  assert.equal(registered.duplicate, false);
  const heartbeat = await runner.heartbeat();
  assert.equal(heartbeat.accepted, true);
  assert.equal(heartbeat.duplicate, false);

  const restartedRunner = new FridayRunner(
    loadRunnerConfig({
      FRIDAY_HUB_URL: baseUrl,
      FRIDAY_RUNNER_STATE_DIR: runnerStateDir,
      FRIDAY_RUNNER_ID: enrollment.runnerId,
      FRIDAY_RUNNER_NAME: "Integrated runner",
    }),
  );
  const replay = await restartedRunner.register();
  assert.equal(replay.accepted, true);
  assert.equal(replay.duplicate, false);
  const revoked = await request(baseUrl, `/v1/runners/${enrollment.runnerId}/revoke`, {
    method: "POST",
    token: ownerToken,
    body: {},
  });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).duplicate, false);
  const revokedReplay = await request(baseUrl, `/v1/runners/${enrollment.runnerId}/revoke`, {
    method: "POST",
    token: ownerToken,
    body: {},
  });
  assert.equal(revokedReplay.status, 200);
  assert.equal((await revokedReplay.json()).duplicate, true);
  await assert.rejects(() => restartedRunner.heartbeat(), /RUNNER_DEVICE_AUTH_REQUIRED/);
});

test("fridayd validates the full schema and deduplicates concurrent delivery", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "fridayd-concurrency-test-"));
  const friday = await createFridayServer(config(stateDir));
  t.after(async () => {
    await friday.stop();
    await rm(stateDir, { recursive: true, force: true });
  });
  const address = await friday.start();
  const baseUrl = `http://${address.host}:${address.port}`;

  const invalid = await request(baseUrl, "/v1/messages", {
    method: "POST",
    token: ownerToken,
    body: {
      protocolVersion: "1",
      messageId: randomUUID(),
      channel: "smtp",
      senderId: "owner",
      conversationId: "main",
      authStrength: "strong",
      receivedAt: "not-a-date",
      content: { kind: "text", text: "invalid" },
      unexpectedAuthority: true,
    },
  });
  assert.equal(invalid.status, 400);

  const disabledChannel = await request(baseUrl, "/v1/messages", {
    method: "POST",
    token: ownerToken,
    body: {
      protocolVersion: "1",
      messageId: randomUUID(),
      channel: "telegram",
      senderId: "owner",
      conversationId: "telegram-main",
      authStrength: "channel",
      receivedAt: new Date().toISOString(),
      content: { kind: "text", text: "valid protocol shape, disabled M0 transport" },
    },
  });
  assert.equal(disabledChannel.status, 400);
  assert.equal((await disabledChannel.json()).error.code, "CHANNEL_NOT_ENABLED");

  const message = {
    protocolVersion: "1",
    messageId: randomUUID(),
    channel: "web",
    senderId: "owner",
    conversationId: "concurrent-main",
    authStrength: "strong",
    receivedAt: new Date().toISOString(),
    content: { kind: "text", text: "deliver exactly once" },
  };
  const responses = await Promise.all(
    Array.from({ length: 20 }, () =>
      request(baseUrl, "/v1/messages", {
        method: "POST",
        token: ownerToken,
        body: message,
      }),
    ),
  );
  const bodies = await Promise.all(responses.map((response) => response.json()));

  assert.equal(responses.filter((response) => response.status === 202).length, 1);
  assert.equal(responses.filter((response) => response.status === 200).length, 19);
  assert.equal(new Set(bodies.map((body) => body.job.jobId)).size, 1);

  const conflictingReplay = await request(baseUrl, "/v1/messages", {
    method: "POST",
    token: ownerToken,
    body: {
      ...message,
      content: { kind: "text", text: "same id but different content" },
    },
  });
  assert.equal(conflictingReplay.status, 409);
  assert.equal((await conflictingReplay.json()).error.code, "MESSAGE_ID_CONFLICT");

  const events = await request(baseUrl, "/v1/events", { token: ownerToken });
  const eventBody = await events.json();
  assert.equal(eventBody.events.filter((event) => event.type === "message.accepted").length, 1);
});

test("fridayd rehydrates legacy full-message events without writing that shape for new messages", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "fridayd-legacy-message-test-"));
  let friday;
  t.after(async () => {
    await friday?.stop();
    await rm(stateDir, { recursive: true, force: true });
  });

  const message = {
    protocolVersion: "1",
    messageId: randomUUID(),
    channel: "web",
    senderId: "owner",
    conversationId: "legacy-main",
    authStrength: "strong",
    receivedAt: new Date().toISOString(),
    content: { kind: "text", text: "legacy event content" },
  };
  const job = {
    jobId: randomUUID(),
    sourceMessageId: message.messageId,
    status: "NEW",
    createdAt: new Date().toISOString(),
  };
  const store = new JsonlEventStore(join(stateDir, "events.jsonl"));
  await store.open();
  await store.append("message.accepted", { message, job });
  await store.close();

  friday = await createFridayServer(config(stateDir));
  const address = await friday.start();
  const baseUrl = `http://${address.host}:${address.port}`;
  const restoredJob = await request(baseUrl, `/v1/jobs/${job.jobId}`, { token: ownerToken });
  assert.equal(restoredJob.status, 200);
  assert.deepEqual((await restoredJob.json()).job, job);

  const duplicate = await request(baseUrl, "/v1/messages", {
    method: "POST",
    token: ownerToken,
    body: message,
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
});

test("fridayd fails closed when a summarized message event has an invalid digest or shape", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "fridayd-invalid-message-summary-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const messageId = randomUUID();
  const job = {
    jobId: randomUUID(),
    sourceMessageId: messageId,
    status: "NEW",
    createdAt: new Date().toISOString(),
  };
  const store = new JsonlEventStore(join(stateDir, "events.jsonl"));
  await store.open();
  await store.append("message.accepted", {
    messageId,
    messageDigest: "not-a-sha256-digest",
    job,
  });
  await store.close();

  await assert.rejects(
    () => createFridayServer(config(stateDir)),
    /payload\.messageDigest must be a lowercase SHA-256 digest/,
  );
});
