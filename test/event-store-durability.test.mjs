import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, appendFile, mkdtemp, open as openFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { JsonlEventStore } from "../apps/fridayd/dist/event-store.js";

const eventStoreModuleUrl = new URL("../apps/fridayd/dist/event-store.js", import.meta.url).href;

async function tempStateDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForPath(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("append is durable before resolve and does not expose mutable event references", async () => {
  const stateDir = await tempStateDir("friday-event-immutable-");
  const eventPath = join(stateDir, "events.jsonl");
  const store = new JsonlEventStore(eventPath);

  try {
    await store.open();
    const input = { nested: { value: "original" } };
    const event = await store.append("test.created", input);
    input.nested.value = "caller-mutated";

    assert.equal(event.sequence, 1);
    assert.equal(event.payload.nested.value, "original");
    assert.ok(Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.payload));
    assert.ok(Object.isFrozen(event.payload.nested));
    assert.throws(() => {
      event.payload.nested.value = "mutated-through-return-value";
    }, TypeError);
    assert.equal(store.list()[0].payload.nested.value, "original");

    const bytes = await readFile(eventPath);
    assert.equal(bytes.at(-1), 0x0a);
    assert.equal(bytes.toString("utf8").trim().split("\n").length, 1);

    await store.close();
    const restored = new JsonlEventStore(eventPath);
    await restored.open();
    try {
      assert.equal(restored.list().length, 1);
      assert.equal(restored.list()[0].payload.nested.value, "original");
      assert.ok(Object.isFrozen(restored.list()[0].payload.nested));
    } finally {
      await restored.close();
    }
  } finally {
    await store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("startup quarantines only an unterminated EOF tail and truncates to the last complete line", async () => {
  const stateDir = await tempStateDir("friday-event-tail-");
  const eventPath = join(stateDir, "events.jsonl");
  const store = new JsonlEventStore(eventPath);

  try {
    await store.open();
    await store.append("test.first", { value: 1 });
    await store.append("test.second", { value: 2 });
    await store.close();

    const completeBytes = await readFile(eventPath);
    const partialTail = Buffer.from('{"sequence":3,"eventId":"truncated', "utf8");
    await appendFile(eventPath, partialTail);

    const restored = new JsonlEventStore(eventPath);
    await restored.open();
    try {
      assert.deepEqual(
        restored.list().map((event) => event.sequence),
        [1, 2],
      );
      assert.deepEqual(await readFile(eventPath), completeBytes);
      const quarantineNames = (await readdir(stateDir)).filter((name) =>
        name.startsWith("events.jsonl.quarantine-"),
      );
      assert.equal(quarantineNames.length, 1);
      assert.deepEqual(await readFile(join(stateDir, quarantineNames[0])), partialTail);
    } finally {
      await restored.close();
    }
  } finally {
    await store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an otherwise valid event without its terminating newline is treated as an incomplete tail", async () => {
  const stateDir = await tempStateDir("friday-event-no-newline-");
  const eventPath = join(stateDir, "events.jsonl");
  const seed = new JsonlEventStore(eventPath);

  try {
    await seed.open();
    await seed.append("test.seed", { value: true });
    await seed.close();
    const completeLine = await readFile(eventPath);
    const withoutNewline = completeLine.subarray(0, completeLine.length - 1);
    await writeFile(eventPath, withoutNewline);

    const restored = new JsonlEventStore(eventPath);
    await restored.open();
    try {
      assert.equal(restored.list().length, 0);
      assert.equal((await readFile(eventPath)).length, 0);
      const quarantineNames = (await readdir(stateDir)).filter((name) =>
        name.startsWith("events.jsonl.quarantine-"),
      );
      assert.equal(quarantineNames.length, 1);
      assert.deepEqual(await readFile(join(stateDir, quarantineNames[0])), withoutNewline);
    } finally {
      await restored.close();
    }
  } finally {
    await seed.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("complete-line JSON, shape, and hash corruption all fail closed without retaining the lock", async (t) => {
  const cases = [
    {
      name: "json",
      mutate: () => Buffer.from("{not-json}\n", "utf8"),
      message: /Invalid event JSON at line 1/,
    },
    {
      name: "shape",
      mutate: () => Buffer.from(`${JSON.stringify({ sequence: 1 })}\n`, "utf8"),
      message: /Invalid event record at line 1/,
    },
    {
      name: "hash",
      mutate: (validBytes) => {
        const event = JSON.parse(validBytes.toString("utf8"));
        event.payload = { changed: true };
        return Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
      },
      message: /Event content hash mismatch at sequence 1/,
    },
  ];

  for (const corruption of cases) {
    await t.test(corruption.name, async () => {
      const stateDir = await tempStateDir(`friday-event-corrupt-${corruption.name}-`);
      const eventPath = join(stateDir, "events.jsonl");
      const seed = new JsonlEventStore(eventPath);
      try {
        await seed.open();
        await seed.append("test.seed", { value: "valid" });
        await seed.close();
        const validBytes = await readFile(eventPath);
        await writeFile(eventPath, corruption.mutate(validBytes));

        const firstAttempt = new JsonlEventStore(eventPath);
        await assert.rejects(firstAttempt.open(), corruption.message);
        const secondAttempt = new JsonlEventStore(eventPath);
        await assert.rejects(secondAttempt.open(), corruption.message);
      } finally {
        await seed.close();
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test("a real append I/O failure makes the open store fail closed until restart", async () => {
  const stateDir = await tempStateDir("friday-event-unhealthy-");
  const eventPath = join(stateDir, "events.jsonl");
  const store = new JsonlEventStore(eventPath);
  const probe = await openFile(join(stateDir, "probe"), "w");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  const originalDatasync = fileHandlePrototype.datasync;
  await probe.close();

  try {
    await store.open();
    let injected = false;
    fileHandlePrototype.datasync = async function datasyncWithInjectedFailure() {
      if (!injected) {
        injected = true;
        const failure = new Error("injected datasync failure");
        failure.code = "EIO";
        throw failure;
      }
      return originalDatasync.call(this);
    };

    await assert.rejects(store.append("test.maybe-written", { value: 1 }), /Event store is unhealthy/);
    fileHandlePrototype.datasync = originalDatasync;
    await assert.rejects(store.append("test.must-not-write", { value: 2 }), /Event store is unhealthy/);
    assert.equal(store.list().length, 0);
    await store.close();

    const restored = new JsonlEventStore(eventPath);
    await restored.open();
    try {
      assert.equal(restored.list().length, 1);
      assert.equal(restored.list()[0].type, "test.maybe-written");
    } finally {
      await restored.close();
    }
  } finally {
    fileHandlePrototype.datasync = originalDatasync;
    await store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a pre-write serialization error does not poison later durable appends", async () => {
  const stateDir = await tempStateDir("friday-event-serialization-");
  const eventPath = join(stateDir, "events.jsonl");
  const store = new JsonlEventStore(eventPath);

  try {
    await store.open();
    const circular = {};
    circular.self = circular;
    await assert.rejects(store.append("test.invalid", circular), /circular|cyclic/i);

    const valid = await store.append("test.valid", { recovered: true });
    assert.equal(valid.sequence, 1);
    assert.equal(store.list().length, 1);
  } finally {
    await store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an unpublished partial candidate is harmless and a failed contender cannot disturb a live owner", async () => {
  const stateDir = await tempStateDir("friday-event-lock-publish-");
  const eventPath = join(stateDir, "events.jsonl");
  const orphanCandidate = `${eventPath}.lock.candidate-orphan`;
  const owner = new JsonlEventStore(eventPath);

  try {
    // A crash before hard-link publication can leave only a uniquely named
    // candidate. It must never be mistaken for the well-known lock.
    await writeFile(orphanCandidate, "");
    await owner.open();
    const lockBefore = await readFile(`${eventPath}.lock`);

    const contender = new JsonlEventStore(eventPath);
    await assert.rejects(contender.open(), /locked by another fridayd instance/);
    assert.deepEqual(await readFile(`${eventPath}.lock`), lockBefore);

    await owner.append("test.owner-still-healthy", { value: true });
    assert.equal(owner.list().length, 1);
  } finally {
    await owner.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a crash-stale lock is reclaimed once and concurrent contenders never overwrite the winner", async () => {
  const stateDir = await tempStateDir("friday-event-stale-lock-");
  const eventPath = join(stateDir, "events.jsonl");

  try {
    const childCode = `
      import { JsonlEventStore } from ${JSON.stringify(eventStoreModuleUrl)};
      const store = new JsonlEventStore(process.argv[1]);
      await store.open();
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childCode, eventPath], {
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);

    const contenders = Array.from({ length: 32 }, () => new JsonlEventStore(eventPath));
    const results = await Promise.allSettled(contenders.map((store) => store.open()));
    const winners = results.flatMap((result, index) => (result.status === "fulfilled" ? [index] : []));
    assert.equal(winners.length, 1);

    const winner = contenders[winners[0]];
    await winner.append("test.after-crash", { recovered: true });
    await Promise.all(contenders.map((store) => store.close()));

    const finalStore = new JsonlEventStore(eventPath);
    await finalStore.open();
    try {
      assert.equal(finalStore.list().length, 1);
      assert.equal(finalStore.list()[0].type, "test.after-crash");
    } finally {
      await finalStore.close();
    }

    const leftovers = (await readdir(stateDir)).filter(
      (name) => name.includes(".candidate-") || name.includes(".takeover-") || name.includes(".stale-"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a crash-stale takeover claim advances to a successor without deleting a live claim", async () => {
  const stateDir = await tempStateDir("friday-event-stale-claim-");
  const eventPath = join(stateDir, "events.jsonl");
  const markerPath = join(stateDir, "takeover-claim-acquired");
  let takeoverChild;

  try {
    const leaveMainLockCode = `
      import { JsonlEventStore } from ${JSON.stringify(eventStoreModuleUrl)};
      const store = new JsonlEventStore(process.argv[1]);
      await store.open();
      process.exit(0);
    `;
    const initialOwner = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", leaveMainLockCode, eventPath],
      { encoding: "utf8" },
    );
    assert.equal(initialOwner.status, 0, initialOwner.stderr);

    const staleMainRecord = JSON.parse(await readFile(`${eventPath}.lock`, "utf8"));
    const claimPath = `${eventPath}.lock.takeover-${staleMainRecord.lockId}`;
    const stallAfterClaimCode = `
      import { existsSync, writeFileSync } from "node:fs";
      import { open } from "node:fs/promises";
      import { JsonlEventStore } from ${JSON.stringify(eventStoreModuleUrl)};
      const eventPath = process.argv[1];
      const claimPath = process.argv[2];
      const markerPath = process.argv[3];
      const probe = await open(eventPath + ".probe", "w");
      const prototype = Object.getPrototypeOf(probe);
      const originalReadFile = prototype.readFile;
      await probe.close();
      prototype.readFile = async function controlledReadFile(...args) {
        if (existsSync(claimPath)) {
          writeFileSync(markerPath, "claimed");
          setInterval(() => {}, 1_000);
          await new Promise(() => {});
        }
        return originalReadFile.apply(this, args);
      };
      const store = new JsonlEventStore(eventPath);
      await store.open();
    `;
    takeoverChild = spawn(
      process.execPath,
      ["--input-type=module", "--eval", stallAfterClaimCode, eventPath, claimPath, markerPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let childStderr = "";
    takeoverChild.stderr.setEncoding("utf8");
    takeoverChild.stderr.on("data", (chunk) => {
      childStderr += chunk;
    });
    await waitForPath(markerPath);
    assert.equal(takeoverChild.exitCode, null, childStderr);

    const liveClaimBytes = await readFile(claimPath);
    const blockedContender = new JsonlEventStore(eventPath);
    await assert.rejects(blockedContender.open(), /Could not acquire event store lock/);
    assert.deepEqual(await readFile(claimPath), liveClaimBytes);
    assert.equal(takeoverChild.exitCode, null, childStderr);

    takeoverChild.kill("SIGKILL");
    await once(takeoverChild, "exit");
    takeoverChild = undefined;

    const recovered = new JsonlEventStore(eventPath);
    await recovered.open();
    await recovered.append("test.after-claim-crash", { recovered: true });
    await recovered.close();

    // The dead ancestor is harmless after the main generation changes; a
    // completely new instance can acquire the normal lock immediately.
    const finalStore = new JsonlEventStore(eventPath);
    await finalStore.open();
    try {
      assert.equal(finalStore.list().length, 1);
      assert.equal(finalStore.list()[0].type, "test.after-claim-crash");
    } finally {
      await finalStore.close();
    }
  } finally {
    if (takeoverChild !== undefined && takeoverChild.exitCode === null) {
      takeoverChild.kill("SIGKILL");
      await once(takeoverChild, "exit");
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("many dead takeover claims use deterministic fixed-length successor paths", async () => {
  const stateDir = await tempStateDir("friday-event-claim-chain-");
  const eventPath = join(stateDir, "events.jsonl");
  const lockPath = `${eventPath}.lock`;
  const stalePid = 99_999_999;

  try {
    const mainLockId = randomUUID();
    await writeFile(
      lockPath,
      `${JSON.stringify({ lockId: mainLockId, pid: stalePid, openedAt: new Date().toISOString() })}\n`,
    );

    const baseClaimPath = `${lockPath}.takeover-${mainLockId}`;
    let claimPath = baseClaimPath;
    const claimPaths = [];
    for (let depth = 0; depth < 12; depth += 1) {
      const claimId = randomUUID();
      await writeFile(
        claimPath,
        `${JSON.stringify({ lockId: claimId, pid: stalePid, openedAt: new Date().toISOString() })}\n`,
      );
      claimPaths.push(claimPath);
      claimPath = `${baseClaimPath}.successor-${sha256(`${claimPath}\n${claimId}`)}`;
    }

    assert.ok(claimPaths.every((path) => basename(path).length <= 255));
    assert.equal(new Set(claimPaths.map((path) => basename(path).length)).size <= 2, true);

    const recovered = new JsonlEventStore(eventPath);
    await recovered.open();
    try {
      await recovered.append("test.after-deep-claim-chain", { recovered: true });
      assert.equal(recovered.list().length, 1);
    } finally {
      await recovered.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
