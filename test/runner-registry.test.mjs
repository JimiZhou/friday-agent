import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runnerRequestSignaturePayload } from "../packages/protocol/dist/index.js";
import {
  RUNNER_ENROLLMENT_TTL_MS,
  SqliteRunnerRegistry,
} from "../apps/fridayd/dist/runner-registry.js";

function keyPair() {
  const keys = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

test("Runner enrollment is one-time, key-bound, and idempotent after a lost response", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-runner-registry-"));
  const registry = new SqliteRunnerRegistry(join(stateDir, "friday.sqlite"));
  t.after(async () => {
    registry.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  registry.open();
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const enrollment = registry.issueEnrollment(now);
  assert.match(enrollment.runnerId, /^[0-9a-f-]{36}$/);
  assert.match(enrollment.enrollmentToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(enrollment.expiresAt, new Date(now + RUNNER_ENROLLMENT_TTL_MS).toISOString());

  const device = keyPair();
  assert.deepEqual(
    registry.consumeEnrollment(enrollment.runnerId, enrollment.enrollmentToken, device.publicKeyPem, now + 1),
    { outcome: "enrolled", duplicate: false },
  );
  assert.deepEqual(
    registry.consumeEnrollment(
      enrollment.runnerId,
      enrollment.enrollmentToken,
      device.publicKeyPem,
      now + RUNNER_ENROLLMENT_TTL_MS + 1,
    ),
    { outcome: "enrolled", duplicate: true },
  );
  assert.deepEqual(
    registry.consumeEnrollment(enrollment.runnerId, enrollment.enrollmentToken, keyPair().publicKeyPem, now + 2),
    { outcome: "consumed" },
  );
  assert.deepEqual(
    registry.consumeEnrollment(enrollment.runnerId, "not-a-valid-token", device.publicKeyPem, now + 2),
    { outcome: "invalid" },
  );
  assert.deepEqual(
    registry.consumeEnrollment(enrollment.runnerId, enrollment.enrollmentToken, "not a public key", now + 2),
    { outcome: "invalid_key" },
  );

  const pending = registry.issueEnrollment(now, randomUUID());
  assert.deepEqual(
    registry.consumeEnrollment(
      pending.runnerId,
      pending.enrollmentToken,
      keyPair().publicKeyPem,
      now + RUNNER_ENROLLMENT_TTL_MS + 1,
    ),
    { outcome: "expired" },
  );
});

test("Runner device signatures are bound to HTTP method, path, and exact JSON bytes", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-runner-signature-"));
  const registry = new SqliteRunnerRegistry(join(stateDir, "friday.sqlite"));
  t.after(async () => {
    registry.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  registry.open();
  const enrollment = registry.issueEnrollment();
  const device = keyPair();
  assert.deepEqual(
    registry.consumeEnrollment(enrollment.runnerId, enrollment.enrollmentToken, device.publicKeyPem),
    { outcome: "enrolled", duplicate: false },
  );
  const path = "/v1/runners/register";
  const body = '{"protocolVersion":"1","kind":"register"}';
  const signature = sign(
    null,
    Buffer.from(runnerRequestSignaturePayload("POST", path, body)),
    device.privateKeyPem,
  ).toString("base64url");
  assert.equal(registry.verifyRequest(enrollment.runnerId, signature, "POST", path, body), true);
  assert.equal(registry.verifyRequest(enrollment.runnerId, signature, "POST", "/v1/runners/other/heartbeat", body), false);
  assert.equal(registry.verifyRequest(enrollment.runnerId, signature, "POST", path, `${body} `), false);
  assert.equal(registry.verifyRequest(enrollment.runnerId, signature, "GET", path, body), false);
  assert.equal(registry.verifyRequest(enrollment.runnerId, undefined, "POST", path, body), false);
  assert.deepEqual(registry.revokeDevice(enrollment.runnerId), { outcome: "revoked" });
  assert.equal(registry.verifyRequest(enrollment.runnerId, signature, "POST", path, body), false);
  assert.deepEqual(registry.revokeDevice(enrollment.runnerId), { outcome: "already_revoked" });
  assert.deepEqual(registry.revokeDevice(randomUUID()), { outcome: "not_found" });
});
