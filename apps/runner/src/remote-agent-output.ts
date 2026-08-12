import type { JsonValue, NodeToolNameV1, RemoteAgentActionV1 } from "@friday/protocol";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const NODE_TOOLS = new Set([
  "system.snapshot", "process.list", "service.status", "journal.read", "network.sockets",
  "file.read", "file.search", "file.write", "file.delete", "process.signal", "service.restart", "command.exec",
]);

/** Extract the final assistant text from Pi JSON lines, then validate Friday's action schema. */
export function parseRemoteAgentOutput(stdout: string): RemoteAgentActionV1 {
  if (Buffer.byteLength(stdout, "utf8") > 2 * 1_048_576) throw new Error("Remote Agent output is too large");
  const candidates: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { continue; }
    collectAssistantText(value, candidates);
  }
  const raw = candidates.at(-1) ?? stdout.trim();
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new Error("Remote Agent did not return one JSON action"); }
  if (!isRecord(value)) throw new Error("Remote Agent action must be an object");
  if (value.type === "finish") {
    if (Object.keys(value).sort().join(",") !== "summary,type" || typeof value.summary !== "string" || value.summary.trim() === "" || Buffer.byteLength(value.summary, "utf8") > 64 * 1024) throw new Error("Remote Agent finish action is invalid");
    return { type: "finish", summary: value.summary.trim() };
  }
  if (value.type !== "tool_call" || Object.keys(value).sort().join(",") !== "arguments,callId,name,reason,type" || typeof value.callId !== "string" || !UUID_PATTERN.test(value.callId) || typeof value.name !== "string" || !NODE_TOOLS.has(value.name) || !isRecord(value.arguments) || !isJsonRecord(value.arguments) || Buffer.byteLength(JSON.stringify(value.arguments), "utf8") > MAX_ARGUMENT_BYTES || typeof value.reason !== "string" || value.reason.trim() === "" || Buffer.byteLength(value.reason, "utf8") > 2_048) throw new Error("Remote Agent tool action is invalid");
  return { type: "tool_call", callId: value.callId.toLowerCase(), name: value.name as NodeToolNameV1, arguments: value.arguments as Record<string, JsonValue>, reason: value.reason.trim() };
}

function collectAssistantText(value: unknown, output: string[]): void {
  if (!isRecord(value)) return;
  for (const key of ["text", "content", "message", "response", "result"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().startsWith("{")) output.push(candidate.trim());
    else if (Array.isArray(candidate)) for (const item of candidate) collectAssistantText(item, output);
    else collectAssistantText(candidate, output);
  }
}

function isJsonRecord(value: Record<string, unknown>): boolean { return Object.values(value).every(isJsonValue); }
function isJsonValue(value: unknown): value is JsonValue { return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) && value.every(isJsonValue)) || (isRecord(value) && Object.values(value).every(isJsonValue)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
