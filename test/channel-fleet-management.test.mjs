import assert from "node:assert/strict";
import { execFile as callbackExecFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ChannelFleetManagement } from "../apps/fridayd/dist/channel-fleet-management.js";

const runnerId = "018f6f57-51d4-7b48-a3a3-c5e8b194aaf2";
const execFile = promisify(callbackExecFile);

test("IM fleet commands expose status but require enablement and do not repeat install side effects", async (t) => {
  let issued = 0;
  let request;
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const disabled = new ChannelFleetManagement({
    enabled: false,
    listRunners: () => [],
    issueInstallCommand: async () => {
      issued += 1;
      return { ok: true, install: { command: "sh -c 'true'", expiresAt } };
    },
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
    issueInstallCommand: async (_channel, _senderId, value) => {
      issued += 1;
      request = value;
      return { ok: true, install: { command: "sh -c 'set -eu; echo ready'", expiresAt } };
    },
    checkRevocation: () => undefined,
    revokeRunner: async () => "revoked",
  });

  const listing = await enabled.handle("telegram", "owner", "/runner list");
  assert.doesNotMatch(listing, new RegExp(runnerId));
  assert.match(listing, /\| 设备 \| 状态 \| 系统/);
  assert.match(listing, /build-node/);
  assert.match(listing, /待上报/);
  assert.match(listing, /在线/);
  const install = await enabled.handle("telegram", "owner", "/runner add build-node ubuntu hub-ssh");
  assert.deepEqual(request, { runnerName: "build-node", serviceUser: "ubuntu", sshTarget: "hub-ssh" });
  assert.match(install, /一次性纳管命令/);
  assert.match(install, /```sh\nsh -c 'set -eu; echo ready'\n```/);
  const installCommand = install.match(/```sh\n([^\n]+)\n```/)?.[1];
  assert.equal(typeof installCommand, "string");
  assert.doesNotMatch(installCommand, /fridayctl|npm run|enrollmentToken/);
  assert.equal(issued, 1);
  assert.match(await enabled.handle("telegram", "owner", "/runner add", Date.now(), false), /没有重复执行/);
  assert.equal(issued, 1);
  assert.match(await enabled.handle("telegram", "owner", "/runner add a b c d"), /用法/);
  assert.equal(issued, 1);

  const directory = await mkdtemp(join(tmpdir(), "friday-install-command-syntax-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const commandFile = join(directory, "install.sh");
  await writeFile(commandFile, "sh -c 'set -eu; echo ready'\n", { mode: 0o600 });
  await execFile("sh", ["-n", commandFile]);
});

test("IM Runner revocation is sender-bound, expires, checks active jobs, and runs once under concurrent confirmation", async () => {
  let blocked = undefined;
  let revocations = 0;
  const manager = new ChannelFleetManagement({
    enabled: true,
    listRunners: () => [],
    issueInstallCommand: async () => ({ ok: true, install: { command: "sh -c 'true'", expiresAt: new Date(Date.now() + 60_000).toISOString() } }),
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
    issueInstallCommand: async () => ({ ok: true, install: { command: "sh -c 'true'", expiresAt: new Date(Date.now() + 60_000).toISOString() } }),
    checkRevocation: () => undefined,
    revokeRunner: async () => "revoked",
  });
  const expiredAt = Date.now() - 120_001;
  assert.match(await expiring.handle("telegram", "owner", `/runner revoke ${runnerId}`, expiredAt), /两分钟内/);
  assert.equal(expiring.isPendingRevocation(runnerId), false);
  assert.match(await expiring.handle("telegram", "owner", `/runner confirm revoke ${runnerId}`, expiredAt + 120_001), /没有匹配/);
});
