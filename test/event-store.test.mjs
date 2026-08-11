import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlEventStore } from "../apps/fridayd/dist/event-store.js";

test("JsonlEventStore rejects a second writer and detects tampering", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-event-store-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const eventPath = join(stateDir, "events.jsonl");

  const first = new JsonlEventStore(eventPath);
  await first.open();
  await first.append("test.created", { value: "original" });

  const second = new JsonlEventStore(eventPath);
  await assert.rejects(() => second.open(), /locked by another fridayd instance/);
  await first.close();

  const original = await readFile(eventPath, "utf8");
  await writeFile(eventPath, original.replace("original", "tampered"), "utf8");

  const tampered = new JsonlEventStore(eventPath);
  await assert.rejects(() => tampered.open(), /content hash mismatch/);
});
