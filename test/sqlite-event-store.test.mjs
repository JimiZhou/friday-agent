import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonlEventStore } from "../apps/fridayd/dist/event-store.js";
import { SqliteEventStore } from "../apps/fridayd/dist/sqlite-event-store.js";

async function temporaryState(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function paths(stateDir) {
  return {
    database: join(stateDir, "friday.sqlite"),
    legacy: join(stateDir, "events.jsonl"),
  };
}

test("SqliteEventStore uses WAL, preserves the hash chain, and has one active owner", async (t) => {
  const stateDir = await temporaryState("friday-sqlite-store-");
  const { database, legacy } = paths(stateDir);
  const first = new SqliteEventStore(database, legacy);
  const second = new SqliteEventStore(database, legacy);
  t.after(async () => {
    await second.close();
    await first.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  await first.open();
  const input = { nested: { value: "original" } };
  const event = await first.append("test.created", input);
  input.nested.value = "caller-mutated";

  assert.equal(event.sequence, 1);
  assert.equal(event.payload.nested.value, "original");
  assert.ok(Object.isFrozen(event));
  assert.ok(Object.isFrozen(event.payload));
  assert.ok(Object.isFrozen(event.payload.nested));
  await assert.rejects(() => second.open(), /locked by another fridayd instance/);
  await first.close();

  const rawDatabase = new DatabaseSync(database);
  try {
    const journalMode = rawDatabase.prepare("PRAGMA journal_mode").get();
    assert.equal(journalMode.journal_mode, "wal");
    assert.equal(rawDatabase.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(rawDatabase.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
  } finally {
    rawDatabase.close();
  }

  const restored = new SqliteEventStore(database, legacy);
  t.after(() => restored.close());
  await restored.open();
  assert.equal(restored.list().length, 1);
  assert.equal(restored.list()[0].payload.nested.value, "original");
});

test("SqliteEventStore fails closed when a persisted row no longer matches its hash", async (t) => {
  const stateDir = await temporaryState("friday-sqlite-tamper-");
  const { database, legacy } = paths(stateDir);
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const seed = new SqliteEventStore(database, legacy);
  await seed.open();
  await seed.append("test.created", { value: "original" });
  await seed.close();

  const rawDatabase = new DatabaseSync(database);
  try {
    rawDatabase.prepare("UPDATE events SET payload_json = ? WHERE sequence = 1").run('{"value":"tampered"}');
  } finally {
    rawDatabase.close();
  }

  const tampered = new SqliteEventStore(database, legacy);
  await assert.rejects(() => tampered.open(), /Event content hash mismatch at sequence 1/);
  await tampered.close();
});

test("SqliteEventStore imports a verified M0 JSONL chain exactly once", async (t) => {
  const stateDir = await temporaryState("friday-sqlite-migration-");
  const { database, legacy } = paths(stateDir);
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const jsonl = new JsonlEventStore(legacy);
  await jsonl.open();
  const first = await jsonl.append("test.first", { value: 1 });
  const second = await jsonl.append("test.second", { value: 2 });
  await jsonl.close();
  const originalBytes = await readFile(legacy);

  const migrated = new SqliteEventStore(database, legacy);
  await migrated.open();
  assert.deepEqual(migrated.list(), [first, second]);
  await migrated.close();
  assert.deepEqual(await readFile(legacy), originalBytes, "migration must preserve the legacy source file");

  const reopened = new SqliteEventStore(database, legacy);
  await reopened.open();
  try {
    assert.deepEqual(reopened.list(), [first, second]);
  } finally {
    await reopened.close();
  }
});
