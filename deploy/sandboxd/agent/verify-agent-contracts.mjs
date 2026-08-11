import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const wrapperModule = process.env.FRIDAY_AGENT_WRAPPER_MODULE ?? "/usr/local/lib/friday-agent/agent-wrapper.js";
const workspace = process.env.FRIDAY_AGENT_FIXTURE_WORKSPACE ?? "/workspace";
if (!isAbsolute(wrapperModule) || !isAbsolute(workspace)) throw new Error("Fixture paths must be absolute");
const {
  createAgentLaunchPlan,
  writePiProviderConfig,
} = await import(pathToFileURL(wrapperModule).href);

const EXPECTED_REQUESTS = Object.freeze({
  codex: "/openai/v1/responses",
  pi: "/openai/v1/chat/completions",
  claude: "/anthropic/v1/messages?beta=true",
});
const TOOLS = Object.freeze(["codex", "pi", "claude"]);
const requestedTools = process.env.FRIDAY_AGENT_FIXTURE_TOOLS === undefined
  ? TOOLS
  : process.env.FRIDAY_AGENT_FIXTURE_TOOLS.split(",").filter(Boolean);
if (requestedTools.length === 0 || requestedTools.some((tool) => !TOOLS.includes(tool))) throw new Error("Fixture tool selection is invalid");
const RELAY_AUTHORITY = "friday-job-relay-only";
const MAX_CAPTURE_BYTES = 64 * 1024;

const homeRoot = await mkdtemp(join(tmpdir(), "friday-agent-contracts-"));
const state = { tool: undefined, requests: [] };
const server = createServer(async (request, response) => {
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_CAPTURE_BYTES) {
      response.writeHead(413, { "content-type": "application/json" });
      response.end('{"error":{"message":"fixture request is too large"}}');
      return;
    }
  }
  state.requests.push({
    tool: state.tool,
    method: request.method,
    path: request.url,
    authorization: request.headers.authorization,
    apiKey: request.headers["x-api-key"],
  });
  if (request.method === "HEAD" && request.url?.split("?", 1)[0] === "/anthropic/api/hello") {
    response.writeHead(200, { connection: "close" });
    response.end();
    return;
  }
  const body = state.tool === "claude"
    ? '{"type":"error","error":{"type":"authentication_error","message":"Friday contract fixture"}}'
    : '{"error":{"type":"invalid_request_error","code":"fixture_stop","message":"Friday contract fixture"}}';
  response.writeHead(401, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
  response.end(body);
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Contract fixture did not bind a TCP port");

  for (const tool of requestedTools) {
    state.tool = tool;
    const home = join(homeRoot, tool);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const originalPlan = createAgentLaunchPlan(tool, "Reply with exactly fixture-ok.", `fixture-${tool}`, address.port, home, process.env.PATH ?? "");
    const plan = workspace === "/workspace" || tool !== "codex"
      ? originalPlan
      : { ...originalPlan, args: originalPlan.args.map((argument) => argument === "/workspace" ? workspace : argument) };
    if (tool === "codex") await mkdir(plan.environment.CODEX_HOME, { recursive: true, mode: 0o700 });
    if (tool === "pi") writePiProviderConfig(home, `fixture-${tool}`, address.port);
    const output = await runUntilRejected(plan);
    const requests = state.requests.filter((request) => request.tool === tool);
    const expectedPath = EXPECTED_REQUESTS[tool];
    const match = requests.find((request) => request.method === "POST" && request.path === expectedPath);
    if (match === undefined) {
      throw new Error(`${tool} did not call ${expectedPath}; received ${requests.map((request) => `${request.method} ${request.path}`).join(", ") || "no HTTP requests"}; output: ${output.trim().slice(0, 4096) || "none"}`);
    }
    const credential = tool === "claude" ? match.apiKey : match.authorization;
    if (credential !== (tool === "claude" ? RELAY_AUTHORITY : `Bearer ${RELAY_AUTHORITY}`)) {
      throw new Error(`${tool} did not use the per-container relay authority`);
    }
  }
  process.stdout.write("Verified Codex Responses, Pi Chat Completions, and Claude Messages request contracts.\n");
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
  await rm(homeRoot, { recursive: true, force: true });
}

function runUntilRejected(plan) {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, [...plan.args], {
      cwd: workspace,
      env: plan.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const capture = (chunk) => {
      if (Buffer.byteLength(output) < MAX_CAPTURE_BYTES) output += chunk.toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timeout);
      resolve(output);
    });
  });
}
