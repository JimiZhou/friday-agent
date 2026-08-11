import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLAUDE_CLI_VERSION,
  CODEX_CLI_VERSION,
  PI_CLI_VERSION,
  createAgentLaunchPlan,
  startContainerModelRelay,
} from "../apps/sandboxd/dist/agent-wrapper.js";

test("Agent wrapper uses pinned non-interactive Codex, Pi, and Claude launch contracts", () => {
  const plans = {
    codex: createAgentLaunchPlan("codex", "edit the isolated worktree", "codex-model", 34123, "/tmp/home", "/usr/local/bin:/usr/bin:/bin"),
    pi: createAgentLaunchPlan("pi", "edit the isolated worktree", "pi-model", 34123, "/tmp/home", "/usr/local/bin:/usr/bin:/bin"),
    claude: createAgentLaunchPlan("claude", "edit the isolated worktree", "claude-model", 34123, "/tmp/home", "/usr/local/bin:/usr/bin:/bin"),
  };
  assert.equal(plans.codex.expectedVersion, CODEX_CLI_VERSION);
  assert.equal(plans.pi.expectedVersion, PI_CLI_VERSION);
  assert.equal(plans.claude.expectedVersion, CLAUDE_CLI_VERSION);

  assert.deepEqual(plans.codex.args.slice(0, 2), ["exec", "--json"]);
  assert.ok(plans.codex.args.includes("--ephemeral"));
  assert.ok(plans.codex.args.includes("--ignore-user-config"));
  assert.ok(plans.codex.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(plans.codex.args.includes("--skip-git-repo-check"));
  assert.ok(plans.codex.args.includes("model_providers.friday.wire_api=\"responses\""));
  assert.equal(plans.codex.args.includes("app-server"), false);

  assert.ok(plans.pi.args.includes("json"));
  assert.ok(plans.pi.args.includes("--print"));
  assert.equal(plans.pi.args.includes("rpc"), false);
  assert.equal(plans.pi.args.includes("--"), false);
  assert.ok(plans.pi.args.includes("--no-extensions"));
  assert.ok(plans.pi.args.includes("--no-context-files"));

  assert.ok(plans.claude.args.includes("--print"));
  assert.ok(plans.claude.args.includes("--verbose"));
  assert.ok(plans.claude.args.includes("--bare"));
  assert.ok(plans.claude.args.includes("--safe-mode"));
  assert.ok(plans.claude.args.includes("--dangerously-skip-permissions"));
  assert.ok(plans.claude.args.includes('{"mcpServers":{}}'));
  assert.equal(plans.claude.environment.ANTHROPIC_BASE_URL, "http://127.0.0.1:34123/anthropic");

  for (const plan of Object.values(plans)) {
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes("upstream-private"), false);
    assert.equal(serialized.includes("/run/friday-sandboxd"), false);
    assert.equal(plan.environment.NO_PROXY, "127.0.0.1,localhost");
  }
  assert.match(JSON.stringify(plans.codex), /http:\/\/127\.0\.0\.1:34123/);
  assert.match(JSON.stringify(plans.claude), /http:\/\/127\.0\.0\.1:34123/);
});

test("Agent wrapper rejects over-broad launch inputs", () => {
  assert.throws(() => createAgentLaunchPlan("codex", "", "model", 34123, "/tmp/home", "/bin"), /prompt/);
  assert.throws(() => createAgentLaunchPlan("pi", "prompt", "model with spaces", 34123, "/tmp/home", "/bin"), /model/);
  assert.throws(() => createAgentLaunchPlan("claude", "prompt", "model", 80, "/tmp/home", "/bin"), /port/);
});

test("container loopback relay reaches only the mounted Unix model socket", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "friday-agent-relay-"));
  const socketPath = join(directory, "model.sock");
  const received = [];
  const unix = createServer(async (request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += chunk;
    received.push({ path: request.url, authorization: request.headers.authorization, body: raw });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  unix.listen(socketPath);
  await once(unix, "listening");
  const relay = await startContainerModelRelay(socketPath, 0);
  t.after(async () => {
    await relay.close();
    await new Promise((resolve, reject) => unix.close((error) => error === undefined ? resolve() : reject(error)));
    await rm(directory, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${relay.port}/openai/v1/responses`, { method: "POST", headers: { authorization: "Bearer relay-only", "content-type": "application/json" }, body: '{"model":"fixture"}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(received, [{ path: "/openai/v1/responses", authorization: "Bearer relay-only", body: '{"model":"fixture"}' }]);
  const hello = await fetch(`http://127.0.0.1:${relay.port}/anthropic/api/hello`, { method: "HEAD" });
  assert.equal(hello.status, 200);
  assert.equal(received.length, 1);
});
