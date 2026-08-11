import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PiSupervisor } from "../apps/pi-worker/dist/index.js";

const PI_WORKER_ENTRYPOINT = fileURLToPath(
  new URL("../apps/pi-worker/dist/index.js", import.meta.url),
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function request(operation, { sessionId, payload = null } = {}) {
  return {
    protocolVersion: "1",
    envelopeId: randomUUID(),
    sentAt: new Date().toISOString(),
    ...(sessionId === undefined ? {} : { sessionId }),
    kind: "request",
    requestId: randomUUID(),
    operation,
    payload,
  };
}

function runPiWorker(input, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.FRIDAY_PI_BIN;
    Object.assign(environment, extraEnvironment);

    const child = spawn(process.execPath, [PI_WORKER_ENTRYPOINT], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("pi-worker did not exit after stdin closed"));
    }, 5_000);

    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        finish(
          new Error(
            `pi-worker exited with code ${String(code)} and signal ${String(signal)}: ${stderr}`,
          ),
        );
        return;
      }
      finish(undefined, { stdout, stderr });
    });
    child.stdin.end(input);

    function finish(error, result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(result);
      }
    }
  });
}

function parseJsonl(stdout) {
  assert.notEqual(stdout, "", "worker should emit at least one response");
  assert.equal(stdout.endsWith("\n"), true, "worker output must be LF terminated");
  assert.equal(stdout.includes("\r"), false, "worker output must not contain CR framing");
  return stdout.slice(0, -1).split("\n").map((line) => JSON.parse(line));
}

async function runInProcessPiWorker(inputText, options = {}) {
  const input = Readable.from([inputText]);
  let stdout = "";
  let stderr = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      stdout += chunk.toString();
      callback();
    },
  });
  const errorOutput = new Writable({
    write(chunk, _encoding, callback) {
      stderr += chunk.toString();
      callback();
    },
  });
  const supervisor = new PiSupervisor({ input, output, errorOutput, ...options });
  supervisor.run();
  await once(input, "end");
  await supervisor.idle();
  return { stdout, stderr };
}

function assertResponseEnvelope(response, originalRequest) {
  assert.equal(response.protocolVersion, "1");
  assert.match(response.envelopeId, UUID_RE);
  assert.equal(Number.isNaN(Date.parse(response.sentAt)), false);
  assert.equal(response.kind, "response");
  assert.equal(response.requestId, originalRequest.requestId);
}

test("pi-worker handles the stub session lifecycle over LF JSONL", async () => {
  const sessionId = randomUUID();
  const requests = [
    request("ping"),
    request("start", { payload: { sessionId } }),
    request("prompt", { sessionId, payload: { text: "Inspect the failing build" } }),
    request("get_state", { sessionId }),
    request("close", { sessionId }),
  ];

  const { stdout, stderr } = await runPiWorker(
    `${requests.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  assert.equal(stderr, "");

  const responses = parseJsonl(stdout);
  assert.equal(responses.length, requests.length);
  responses.forEach((response, index) => {
    assertResponseEnvelope(response, requests[index]);
    assert.equal(response.ok, true);
  });

  assert.deepEqual(responses[0].payload, {
    alive: true,
    mode: "stub",
    piProxyConfigured: false,
    protocolVersion: "1",
  });
  assert.equal(Object.hasOwn(responses[0], "sessionId"), false);

  assert.equal(responses[1].sessionId, sessionId);
  assert.equal(responses[1].payload.state.phase, "ready");
  assert.equal(responses[1].payload.state.promptCount, 0);

  assert.equal(responses[2].sessionId, sessionId);
  assert.equal(responses[2].payload.accepted, true);
  assert.equal(responses[2].payload.state.promptCount, 1);

  assert.equal(responses[3].sessionId, sessionId);
  assert.equal(responses[3].payload.state.phase, "ready");
  assert.equal(responses[3].payload.state.promptCount, 1);

  assert.equal(responses[4].sessionId, sessionId);
  assert.equal(responses[4].payload.closed, true);
  assert.equal(responses[4].payload.state.phase, "closed");
});

test("pi-worker returns the cached response for a canonical request replay", async () => {
  const sessionId = randomUUID();
  const start = request("start", { payload: { sessionId } });
  const prompt = request("prompt", {
    sessionId,
    payload: { text: "Run the diagnostics once" },
  });
  const reorderedPrompt = {
    payload: { text: "Run the diagnostics once" },
    operation: prompt.operation,
    requestId: prompt.requestId,
    kind: prompt.kind,
    sessionId: prompt.sessionId,
    sentAt: prompt.sentAt,
    envelopeId: prompt.envelopeId,
    protocolVersion: prompt.protocolVersion,
  };
  const state = request("get_state", { sessionId });

  const { stdout, stderr } = await runPiWorker(
    `${[start, prompt, reorderedPrompt, state].map(JSON.stringify).join("\n")}\n`,
  );
  assert.equal(stderr, "");

  const responses = parseJsonl(stdout);
  assert.equal(responses.length, 4);
  assert.deepEqual(responses[2], responses[1], "a replay must return the original envelope byte-for-byte");
  assert.equal(responses[3].payload.state.promptCount, 1);
});

test("pi-worker caches an error response across later state changes", async () => {
  const sessionId = randomUUID();
  const earlyPrompt = request("prompt", {
    sessionId,
    payload: { text: "Do not run twice" },
  });
  const start = request("start", { payload: { sessionId } });
  const state = request("get_state", { sessionId });
  const requests = [earlyPrompt, earlyPrompt, start, earlyPrompt, state];

  const { stdout, stderr } = await runPiWorker(
    `${requests.map(JSON.stringify).join("\n")}\n`,
  );
  assert.equal(stderr, "");

  const responses = parseJsonl(stdout);
  assert.equal(responses[0].error.code, "SESSION_NOT_FOUND");
  assert.deepEqual(responses[1], responses[0]);
  assert.equal(responses[2].ok, true);
  assert.deepEqual(responses[3], responses[0]);
  assert.equal(responses[4].payload.state.promptCount, 0);
});

test("pi-worker canonicalizes UUID case for replay and session lookup", async () => {
  const sessionId = "e48a1cab-6f8b-4bf7-b547-c2445bfa42e8";
  const start = {
    ...request("start", { payload: { sessionId: sessionId.toUpperCase() } }),
    envelopeId: "1b2b6ea0-3533-47e7-97e2-44efdc4f6681".toUpperCase(),
    requestId: "784cc691-7e64-48d2-9c80-af22a739eed4".toUpperCase(),
  };
  const prompt = request("prompt", {
    sessionId: sessionId.toUpperCase(),
    payload: { text: "Normalize UUIDs" },
  });
  const caseChangedReplay = {
    ...prompt,
    envelopeId: prompt.envelopeId.toUpperCase(),
    requestId: prompt.requestId.toUpperCase(),
    sessionId,
  };
  const state = request("get_state", { sessionId });

  const { stdout, stderr } = await runPiWorker(
    `${[start, prompt, caseChangedReplay, state].map(JSON.stringify).join("\n")}\n`,
  );
  assert.equal(stderr, "");

  const responses = parseJsonl(stdout);
  assert.equal(responses[0].requestId, start.requestId.toLowerCase());
  assert.equal(responses[0].sessionId, sessionId);
  assert.deepEqual(responses[2], responses[1]);
  assert.equal(responses[3].payload.state.promptCount, 1);
});

test("pi-worker rejects changed content that reuses either request identifier", async () => {
  const ping = request("ping");
  const requestConflictSession = randomUUID();
  const requestIdConflict = {
    ...request("start", { payload: { sessionId: requestConflictSession } }),
    requestId: ping.requestId.toUpperCase(),
  };
  const envelopeConflictSession = randomUUID();
  const envelopeIdConflict = {
    ...request("start", { payload: { sessionId: envelopeConflictSession } }),
    envelopeId: ping.envelopeId.toUpperCase(),
  };
  const validRequestConflictSessionStart = request("start", {
    payload: { sessionId: requestConflictSession },
  });
  const validEnvelopeConflictSessionStart = request("start", {
    payload: { sessionId: envelopeConflictSession },
  });

  const requests = [
    ping,
    requestIdConflict,
    requestIdConflict,
    envelopeIdConflict,
    validRequestConflictSessionStart,
    validEnvelopeConflictSessionStart,
  ];
  const { stdout, stderr } = await runPiWorker(
    `${requests.map(JSON.stringify).join("\n")}\n`,
  );
  assert.equal(stderr, "");

  const responses = parseJsonl(stdout);
  for (const response of [responses[1], responses[3]]) {
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "REQUEST_REPLAY_CONFLICT");
    assert.equal(response.error.retryable, false);
  }
  assert.deepEqual(responses[2], responses[1], "the same conflict must return a stable response");
  assert.equal(responses[4].ok, true, "a requestId conflict must not create its requested session");
  assert.equal(responses[5].ok, true, "an envelopeId conflict must not create its requested session");
});

test("pi-worker runtime enforces operation-specific payloads", async () => {
  const sessionId = randomUUID();
  const requests = [
    request("ping", { payload: {} }),
    request("start"),
    request("start", { payload: { sessionId, unexpected: true } }),
    request("prompt", { sessionId, payload: { text: "" } }),
    request("steer", { sessionId, payload: { text: "continue", unexpected: true } }),
    request("compact", { sessionId, payload: {} }),
    request("start", { payload: {} }),
  ];

  const { stdout, stderr } = await runPiWorker(
    `${requests.map(JSON.stringify).join("\n")}\n`,
  );
  assert.equal(stderr, "");

  const responses = parseJsonl(stdout);
  for (const response of responses.slice(0, 6)) {
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "INVALID_PAYLOAD");
  }
  assert.equal(responses[6].ok, true, "start payload {} must remain explicitly valid");
  assert.match(responses[6].sessionId, UUID_RE);
});

test("pi-worker bounds replay memory and fails closed for new ids after saturation", async () => {
  const first = request("ping");
  const blocked = request("start", { payload: { sessionId: randomUUID() } });
  const reorderedBlocked = {
    payload: blocked.payload,
    operation: blocked.operation,
    requestId: blocked.requestId,
    kind: blocked.kind,
    sentAt: blocked.sentAt,
    envelopeId: blocked.envelopeId,
    protocolVersion: blocked.protocolVersion,
  };
  const changedBlocked = {
    ...blocked,
    payload: { sessionId: randomUUID() },
  };
  const firstReplay = {
    payload: first.payload,
    operation: first.operation,
    requestId: first.requestId,
    kind: first.kind,
    sentAt: first.sentAt,
    envelopeId: first.envelopeId,
    protocolVersion: first.protocolVersion,
  };

  const { stdout, stderr } = await runInProcessPiWorker(
    `${[first, blocked, reorderedBlocked, changedBlocked, firstReplay]
      .map(JSON.stringify)
      .join("\n")}\n`,
    { maxReplayEntries: 1 },
  );
  assert.equal(stderr, "");

  const responses = parseJsonl(stdout);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[1].error.code, "REQUEST_REPLAY_CACHE_FULL");
  assert.deepEqual(responses[2], responses[1]);
  assert.equal(responses[3].error.code, "REQUEST_REPLAY_CACHE_FULL");
  assert.deepEqual(responses[4], responses[0]);
});

test("pi-worker rejects CRLF records", async () => {
  const ping = request("ping");
  const { stdout, stderr } = await runPiWorker(`${JSON.stringify(ping)}\r\n`);
  assert.equal(stderr, "");

  const [response] = parseJsonl(stdout);
  assertResponseEnvelope(response, ping);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "LF_REQUIRED");
  assert.match(response.error.message, /CRLF/);
  assert.equal(response.error.retryable, false);
});

test("FRIDAY_PI_BIN launches a bounded Pi RPC bridge only with complete private model configuration", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "friday-pi-boundary-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));

  const fakePi = join(stateDirectory, "fake-pi.mjs");
  await writeFile(
    fakePi,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) { if (!process.env.HOME) process.exit(2); process.stdout.write('0.84.1\\n'); process.exit(0); }",
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const command = JSON.parse(line); process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: { args: process.argv.slice(2), inheritedHubSecret: process.env.FRIDAY_TEST_HUB_SECRET ?? null, receivedImages: command.images ?? null } }) + '\\n'); } });",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await chmod(fakePi, 0o755);

  const ping = request("ping");
  const start = request("start", { payload: { sessionId: randomUUID() } });
  const prompt = request("prompt", { sessionId: start.payload.sessionId, payload: { text: "inspect fixture", images: [{ type: "image", data: "iVBORw==", mimeType: "image/png" }] } });
  const { stdout, stderr } = await runPiWorker(
    `${JSON.stringify(ping)}\n${JSON.stringify(start)}\n${JSON.stringify(prompt)}\n`,
    {
      FRIDAY_PI_BIN: fakePi,
      FRIDAY_PI_BASE_URL: "https://models.example.test/v1/",
      FRIDAY_PI_MODEL: "private/model",
      FRIDAY_PI_API_KEY: "a-very-long-private-key",
      FRIDAY_TEST_HUB_SECRET: "must-not-reach-pi",
    },
  );
  assert.equal(stderr, "");

  const [pingResponse, startResponse, promptResponse] = parseJsonl(stdout);
  assertResponseEnvelope(pingResponse, ping);
  assert.equal(pingResponse.ok, true);
  assert.equal(pingResponse.payload.mode, "rpc");
  assert.equal(pingResponse.payload.piProxyConfigured, true);

  assertResponseEnvelope(startResponse, start);
  assert.equal(startResponse.ok, true);
  assertResponseEnvelope(promptResponse, prompt);
  assert.equal(promptResponse.ok, true);
  assert.deepEqual(promptResponse.payload.piResponse.data.args, [
    "--mode", "rpc",
    "--no-session",
    "--no-approve",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--model", "friday/private/model",
  ]);
  assert.equal(promptResponse.payload.piResponse.data.inheritedHubSecret, null);
  assert.deepEqual(promptResponse.payload.piResponse.data.receivedImages, prompt.payload.images);
});
