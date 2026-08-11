import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  ConversationMediaRegistry,
  MAX_CONVERSATION_IMAGE_BYTES,
} from "../apps/fridayd/dist/conversation-media.js";
import { createFridayServer } from "../apps/fridayd/dist/server.js";

const ownerToken = "conversation-media-owner-token";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);

async function upload(base, bytes, mimeType, sourceMediaId) {
  const response = await fetch(`${base}/v4/media`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ownerToken}`,
      "content-type": mimeType,
      ...(sourceMediaId === undefined ? {} : { "x-friday-source-media-id": sourceMediaId }),
    },
    body: bytes,
  });
  return { response, body: await response.json() };
}

test("conversation media registry validates signatures, permissions, frame binding, and expiry", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-conversation-media-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const directory = join(stateDir, "media");
  const registry = new ConversationMediaRegistry(join(stateDir, "friday.sqlite"), directory);
  registry.open();
  t.after(() => registry.close());

  const image = registry.save(png, "image/png", 60);
  const video = registry.save(mp4, "video/mp4", 60);
  const frame = registry.save(jpeg, "image/jpeg", 60, video.id);
  assert.equal(image.kind, "image");
  assert.equal(video.kind, "video");
  assert.equal(frame.role, "video_frame");
  assert.equal(frame.sourceMediaId, video.id);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, `${image.id}.bin`))).mode & 0o777, 0o600);
  assert.deepEqual(registry.resolve([video.id, frame.id]).map((item) => item.id), [video.id, frame.id]);
  assert.throws(() => registry.resolve([frame.id]), /source video/);
  assert.throws(() => registry.save(Buffer.from("<svg/>"), "image/png"), /invalid/);
  assert.throws(() => registry.save(Buffer.alloc(MAX_CONVERSATION_IMAGE_BYTES + 1), "image/png"), /invalid/);
  assert.equal(registry.remove(video.id), true);
  assert.equal(registry.read(frame.id), undefined, "removing a video also removes its representative frames");
});

test("Owner media API carries image bytes to Pi while retaining video for private playback", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-conversation-media-api-"));
  const agent = {
    calls: [],
    async runTurn(turn) { this.calls.push(turn); return JSON.stringify({ reply: "我看到了红色测试图和视频代表帧。" }); },
    async close() {},
  };
  const friday = await createFridayServer(
    { host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576 },
    { conversationAgent: agent },
  );
  const address = await friday.start();
  const base = `http://${address.host}:${address.port}`;
  t.after(async () => { await friday.stop(); await rm(stateDir, { recursive: true, force: true }); });

  const image = await upload(base, png, "image/png");
  assert.equal(image.response.status, 201);
  const video = await upload(base, mp4, "video/mp4");
  assert.equal(video.response.status, 201);
  const frame = await upload(base, jpeg, "image/jpeg", video.body.media.id);
  assert.equal(frame.response.status, 201);

  const submitted = await fetch(`${base}/v4/conversations/main/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      messageId: randomUUID(),
      channel: "web",
      text: "",
      mediaIds: [image.body.media.id, video.body.media.id, frame.body.media.id],
    }),
  });
  const result = await submitted.json();
  assert.equal(submitted.status, 201);
  assert.equal(result.turn.attachments.length, 3);
  assert.equal(agent.calls.length, 1);
  assert.deepEqual(agent.calls[0].images.map((item) => item.mimeType), ["image/png", "image/jpeg"]);
  assert.equal(agent.calls[0].images[0].data, png.toString("base64"));
  assert.match(agent.calls[0].prompt, /"role":"video_frame"/);

  const range = await fetch(`${base}/v4/media/${video.body.media.id}`, {
    headers: { authorization: `Bearer ${ownerToken}`, range: "bytes=4-11" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 4-11/${mp4.byteLength}`);
  assert.equal(Buffer.from(await range.arrayBuffer()).toString(), "ftypisom");

  const removed = await fetch(`${base}/v4/media/${image.body.media.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { deleted: true });
});
