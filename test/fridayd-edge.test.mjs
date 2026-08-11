import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../apps/fridayd/dist/config.js";
import { createFridayServer } from "../apps/fridayd/dist/server.js";

const OWNER_TOKEN = "owner-token-for-edge-tests";

function directConfig(stateDir, port = 0) {
  return {
    host: "127.0.0.1",
    port,
    stateDir,
    ownerId: "owner",
    ownerToken: OWNER_TOKEN,
    maxBodyBytes: 1_048_576,
  };
}

function get(port, path, { hostHeader = "localhost", token } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        agent: false,
        headers: {
          host: hostHeader,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.once("end", () => {
          resolve({ status: response.statusCode, body });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function closeTcpServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

test("fridayd configuration rejects unsafe hosts, credentials, and owner ids", () => {
  const valid = {
    FRIDAY_OWNER_TOKEN: "o".repeat(32),
  };

  for (const host of ["0.0.0.0", "::", "localhost", "private-hub.example"]) {
    assert.throws(
      () => loadConfig({ ...valid, FRIDAY_HOST: host }),
      /only supports loopback/,
    );
  }

  for (const [name, value] of [
    ["FRIDAY_OWNER_TOKEN", ""],
    ["FRIDAY_OWNER_TOKEN", " ".repeat(16)],
    ["FRIDAY_OWNER_TOKEN", "too-short"],
    ["FRIDAY_OWNER_TOKEN", "x".repeat(513)],
  ]) {
    assert.throws(
      () => loadConfig({ ...valid, [name]: value }),
      new RegExp(`${name} must contain 16-512 non-whitespace characters`),
    );
  }

  assert.throws(
    () => loadConfig({ ...valid, FRIDAY_WEB_PASSWORD: "a-long-web-password" }),
    /requires FRIDAY_PUBLIC_ORIGIN/,
  );
  assert.throws(
    () => loadConfig({ ...valid, FRIDAY_PUBLIC_ORIGIN: "https://friday.example.test", FRIDAY_WEB_PASSWORD: "too-short" }),
    /12-256 characters/,
  );
  assert.equal(
    loadConfig({ ...valid, FRIDAY_PUBLIC_ORIGIN: "https://friday.example.test", FRIDAY_WEB_PASSWORD: "a-long-web-password" }).webPassword,
    "a-long-web-password",
  );

  assert.throws(
    () => loadConfig({ ...valid, FRIDAY_RUNNER_TOKEN: "obsolete-shared-token" }),
    /FRIDAY_RUNNER_TOKEN is no longer supported/,
  );

  for (const ownerId of ["", "../owner", "owner/secondary", "x".repeat(129)]) {
    assert.throws(
      () => loadConfig({ ...valid, FRIDAY_OWNER_ID: ownerId }),
      /FRIDAY_OWNER_ID must be a non-empty identifier/,
    );
  }

  for (const port of ["-1", "65536", "4310junk", " 4310", "1.5"]) {
    assert.throws(
      () => loadConfig({ ...valid, FRIDAY_PORT: port }),
      /Invalid FRIDAY_PORT/,
    );
  }

  assert.throws(
    () => loadConfig({ ...valid, FRIDAY_CONVERSATION_ENABLE: "1" }),
    /requires Pi Worker script, binary, base URL, model, and API key/,
  );
  const conversation = loadConfig({
    ...valid,
    FRIDAY_CONVERSATION_ENABLE: "1",
    FRIDAY_PI_NODE_BIN: process.execPath,
    FRIDAY_PI_WORKER_SCRIPT: "/app/apps/pi-worker/dist/index.js",
    FRIDAY_PI_BIN: "/opt/friday-pi/bin/pi",
    FRIDAY_PI_BASE_URL: "https://models.example.test/v1/",
    FRIDAY_PI_MODEL: "private/model",
    FRIDAY_PI_API_KEY: "private-model-key-long-enough",
  }).conversationAgent;
  assert.equal(conversation.workerScriptPath, "/app/apps/pi-worker/dist/index.js");
  assert.equal(conversation.baseUrl.toString(), "https://models.example.test/v1/");

  assert.throws(
    () => loadConfig({ ...valid, FRIDAY_RUNNER_OPENAI_BASE_URL: "https://models.example.test/v1/" }),
    /requires base URL, API key, Codex model, and Pi model together/,
  );
  assert.throws(
    () => loadConfig({ ...valid, FRIDAY_RUNNER_OPENAI_BASE_URL: "http://models.example.test/v1/", FRIDAY_RUNNER_OPENAI_API_KEY: "private-runner-key-long-enough", FRIDAY_RUNNER_CODEX_MODEL: "codex", FRIDAY_RUNNER_PI_MODEL: "pi" }),
    /HTTPS base URL/,
  );
  const runnerProxy = loadConfig({
    ...valid,
    FRIDAY_RUNNER_OPENAI_BASE_URL: "https://models.example.test/v1/",
    FRIDAY_RUNNER_OPENAI_API_KEY: "private-runner-key-long-enough",
    FRIDAY_RUNNER_CODEX_MODEL: "codex/model",
    FRIDAY_RUNNER_PI_MODEL: "pi/model",
    FRIDAY_RUNNER_ANTHROPIC_BASE_URL: "https://anthropic.example.test/v1/",
    FRIDAY_RUNNER_ANTHROPIC_API_KEY: "private-anthropic-key-long-enough",
    FRIDAY_RUNNER_CLAUDE_MODEL: "claude/model",
  }).runnerModelProxy;
  assert.equal(runnerProxy.openai.codexModel, "codex/model");
  assert.equal(runnerProxy.anthropic.claudeModel, "claude/model");
  assert.equal(runnerProxy.tokenTtlSeconds, 300);
});

test("programmatic server construction cannot bypass the loopback config boundary", async () => {
  await assert.rejects(
    () => createFridayServer({ ...directConfig("/tmp/fridayd-must-not-open"), host: "0.0.0.0" }),
    /only supports loopback/,
  );
  await assert.rejects(
    () => createFridayServer({ ...directConfig("/tmp/fridayd-must-not-open"), ownerToken: "short" }),
    /FRIDAY_OWNER_TOKEN must contain/,
  );
});

test("malicious and malformed Host headers cannot poison routing or crash fridayd", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "fridayd-host-edge-test-"));
  let friday;
  t.after(async () => {
    if (friday !== undefined) {
      await friday.stop();
    }
    await rm(stateDir, { recursive: true, force: true });
  });

  friday = await createFridayServer(directConfig(stateDir));
  const address = await friday.start();

  for (const hostHeader of [
    "attacker.invalid:65535",
    "[::1",
    "user@attacker.invalid",
    "localhost:bad-port",
  ]) {
    const response = await get(address.port, "/health", { hostHeader });
    assert.equal(response.status, 200, `unexpected response for Host: ${hostHeader}`);
    assert.equal(JSON.parse(response.body).status, "ok");
  }

  const authenticated = await get(address.port, "/v1/info", {
    hostHeader: "attacker.invalid",
    token: OWNER_TOKEN,
  });
  assert.equal(authenticated.status, 200);
  assert.equal(JSON.parse(authenticated.body).ownerId, "owner");

  const stillHealthy = await get(address.port, "/health");
  assert.equal(stillHealthy.status, 200);
});

test("a TCP bind failure releases the event-store lock before a clean restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "fridayd-bind-edge-test-"));
  const occupied = createTcpServer();
  let failedFriday;
  let restartedFriday;
  t.after(async () => {
    if (restartedFriday !== undefined) {
      await restartedFriday.stop();
    }
    if (failedFriday !== undefined) {
      await failedFriday.stop();
    }
    await closeTcpServer(occupied);
    await rm(stateDir, { recursive: true, force: true });
  });

  occupied.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    occupied.once("listening", resolve);
    occupied.once("error", reject);
  });
  const occupiedAddress = occupied.address();
  assert.notEqual(occupiedAddress, null);
  assert.equal(typeof occupiedAddress, "object");

  const config = directConfig(stateDir, occupiedAddress.port);
  failedFriday = await createFridayServer(config);
  await assert.rejects(
    failedFriday.start(),
    (error) => error instanceof Error && error.code === "EADDRINUSE",
  );
  await assert.rejects(access(join(stateDir, "events.jsonl.lock")), { code: "ENOENT" });

  await closeTcpServer(occupied);
  restartedFriday = await createFridayServer(config);
  const restartedAddress = await restartedFriday.start();
  assert.equal(restartedAddress.port, occupiedAddress.port);

  const health = await get(restartedAddress.port, "/health");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).status, "ok");
});
