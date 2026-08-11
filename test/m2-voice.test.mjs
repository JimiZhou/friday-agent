import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFridayServer } from "../apps/fridayd/dist/server.js";

const ownerToken = "m2-voice-owner-token-with-sufficient-length";

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

test("M2 voice stores expiring media and uses only configured OpenAI-compatible STT/TTS", async (t) => {
  const provider = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer m2-voice-private-key-12345");
    if (request.url === "/v1/audio/transcriptions") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "fixture transcript" }));
      return;
    }
    if (request.url === "/v1/audio/speech") {
      let raw = ""; for await (const part of request) raw += part;
      assert.match(raw, /"model":"fixture-tts"/);
      response.writeHead(200, { "content-type": "audio/mpeg" }).end(Buffer.from("fixture-mp3"));
      return;
    }
    response.writeHead(404).end();
  });
  const providerPort = await listen(provider);
  t.after(() => new Promise((resolve, reject) => provider.close((error) => error === undefined ? resolve() : reject(error))));
  const stateDir = await mkdtemp(join(tmpdir(), "friday-m2-voice-"));
  const friday = await createFridayServer({
    host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576,
    voiceProvider: { baseUrl: new URL(`http://127.0.0.1:${providerPort}/v1/`), sttModel: "fixture-stt", ttsModel: "fixture-tts", apiKey: "m2-voice-private-key-12345" },
  });
  const address = await friday.start();
  t.after(async () => { await friday.stop(); await rm(stateDir, { recursive: true, force: true }); });
  const base = `http://${address.host}:${address.port}`;
  const upload = await fetch(`${base}/v2/voice/media`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "audio/webm", "x-friday-media-ttl-seconds": "60" }, body: Buffer.from("fixture-webm") });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.equal(uploaded.media.mimeType, "audio/webm");
  const media = await fetch(`${base}/v2/voice/media/${uploaded.media.id}`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(media.status, 200);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), Buffer.from("fixture-webm"));
  const transcript = await fetch(`${base}/v2/voice/transcribe`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({ mediaId: uploaded.media.id }) });
  assert.deepEqual(await transcript.json(), { text: "fixture transcript", media: uploaded.media });
  const speech = await fetch(`${base}/v2/voice/synthesize`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({ text: "reply" }) });
  assert.equal(speech.status, 201);
  const generated = await speech.json();
  const generatedMedia = await fetch(`${base}/v2/voice/media/${generated.media.id}`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.deepEqual(Buffer.from(await generatedMedia.arrayBuffer()), Buffer.from("fixture-mp3"));
});

test("M2 voice fails closed when no provider is configured", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "friday-m2-voice-disabled-"));
  const friday = await createFridayServer({ host: "127.0.0.1", port: 0, stateDir, ownerId: "owner", ownerToken, maxBodyBytes: 1_048_576 });
  const address = await friday.start();
  t.after(async () => { await friday.stop(); await rm(stateDir, { recursive: true, force: true }); });
  const response = await fetch(`http://${address.host}:${address.port}/v2/voice/transcribe`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({ mediaId: "a".repeat(32) }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "VOICE_DISABLED");
});
