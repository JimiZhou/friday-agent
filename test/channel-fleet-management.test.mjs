import assert from "node:assert/strict";
import test from "node:test";

import { ChannelFleetManagement } from "../apps/fridayd/dist/channel-fleet-management.js";

const runnerId = "018f6f57-51d4-7b48-a3a3-c5e8b194aaf2";

test("IM fleet commands expose status but require enablement and do not repeat enrollment side effects", async () => {
  let issued = 0;
  const disabled = new ChannelFleetManagement({
    enabled: false,
    listRunners: () => [],
    issueEnrollment: async () => { issued += 1; return { runnerId, enrollmentToken: "a".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    checkRevocation: () => undefined,
    revokeRunner: async () => "revoked",
  });

  assert.equal(await disabled.handle("web", "owner", "/runner list"), undefined);
  assert.match(await disabled.handle("telegram", "owner", "/runner list"), /没有登记过节点/);
  assert.match(await disabled.handle("telegram", "owner", "/runner add"), /尚未启用/);
  assert.equal(issued, 0);

  const enabled = new ChannelFleetManagement({
    enabled: true,
    listRunners: () => [{ runnerId, name: "build-node", online: true, activeJobs: 0, enrolled: true, revocationPending: false }],
    issueEnrollment: async () => { issued += 1; return { runnerId, enrollmentToken: "b".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    checkRevocation: () => undefined,
    revokeRunner: async () => "revoked",
  });

  const listing = await enabled.handle("telegram", "owner", "/runner list");
  assert.match(listing, new RegExp(runnerId));
  assert.match(listing, /在线/);
  const enrollment = await enabled.handle("telegram", "owner", "/runner add");
  assert.match(enrollment, new RegExp("b".repeat(43)));
  assert.equal(issued, 1);
  assert.match(await enabled.handle("telegram", "owner", "/runner add", Date.now(), false), /没有重复执行/);
  assert.equal(issued, 1);
});

test("IM Runner revocation is sender-bound, expires, checks active jobs, and runs once under concurrent confirmation", async () => {
  let blocked = undefined;
  let revocations = 0;
  const manager = new ChannelFleetManagement({
    enabled: true,
    listRunners: () => [],
    issueEnrollment: async () => ({ runnerId, enrollmentToken: "c".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    checkRevocation: () => blocked,
    revokeRunner: async () => {
      revocations += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "revoked";
    },
  });

  const now = Date.now();
  assert.match(await manager.handle("telegram", "owner", `/runner revoke ${runnerId}`, now), /两分钟内/);
  assert.equal(manager.isPendingRevocation(runnerId), true);
  assert.match(await manager.handle("telegram", "other", `/runner confirm revoke ${runnerId}`, now + 1), /没有匹配/);
  assert.equal(manager.isPendingRevocation(runnerId), true);

  blocked = "节点仍有未完成任务";
  assert.equal(await manager.handle("telegram", "owner", `/runner confirm revoke ${runnerId}`, now + 2), blocked);
  assert.equal(manager.isPendingRevocation(runnerId), false);
  blocked = undefined;

  assert.match(await manager.handle("telegram", "owner", `/runner revoke ${runnerId}`, now + 3), /两分钟内/);
  const confirmation = `/runner confirm revoke ${runnerId}`;
  const results = await Promise.all([
    manager.handle("telegram", "owner", confirmation, now + 4),
    manager.handle("telegram", "owner", confirmation, now + 4),
  ]);
  assert.equal(results.filter((result) => result === "revoked").length, 1);
  assert.equal(results.filter((result) => /执行中/.test(result)).length, 1);
  assert.equal(revocations, 1);
  assert.equal(manager.isPendingRevocation(runnerId), false);

  const expiring = new ChannelFleetManagement({
    enabled: true,
    listRunners: () => [],
    issueEnrollment: async () => ({ runnerId, enrollmentToken: "d".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    checkRevocation: () => undefined,
    revokeRunner: async () => "revoked",
  });
  const expiredAt = Date.now() - 120_001;
  assert.match(await expiring.handle("telegram", "owner", `/runner revoke ${runnerId}`, expiredAt), /两分钟内/);
  assert.equal(expiring.isPendingRevocation(runnerId), false);
  assert.match(await expiring.handle("telegram", "owner", `/runner confirm revoke ${runnerId}`, expiredAt + 120_001), /没有匹配/);
});
