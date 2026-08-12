import { createHash, createPublicKey, verify } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";

import {
  JOB_PROTOCOL_VERSION,
  canonicalJsonV2,
  nodeToolAuthorizationProjectionV1,
  nodeToolCallSha256V1,
  type JsonValue,
  type NodeToolAuthorizationV1,
  type NodeToolCallV1,
} from "@friday/protocol";

const execFile = promisify(execFileCallback);
const MAX_RESULT_BYTES = 256 * 1024;

/** Verify Hub authority again at the node, then invoke one named tool. */
export async function invokeAuthorizedNodeTool(call: NodeToolCallV1, authorization: NodeToolAuthorizationV1, hubPublicKeyPem: string): Promise<JsonValue> {
  verifyNodeToolAuthorization(call, authorization, hubPublicKeyPem);
  return invokeNodeTool(call);
}

export function verifyNodeToolAuthorization(call: NodeToolCallV1, authorization: NodeToolAuthorizationV1, hubPublicKeyPem: string, now = new Date()): void {
  if (authorization.protocolVersion !== JOB_PROTOCOL_VERSION || authorization.callId !== call.callId || authorization.jobId !== call.jobId || authorization.runnerId !== call.runnerId || authorization.leaseId !== call.leaseId || authorization.callSha256 !== nodeToolCallSha256V1(call) || Date.parse(authorization.expiresAt) <= now.getTime()) throw new Error("Node tool authorization does not match the exact live call");
  const key = createPublicKey(hubPublicKeyPem);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(canonicalJsonV2(nodeToolAuthorizationProjectionV1(authorization)), "utf8"), key, Buffer.from(authorization.hubSignature, "base64url"))) throw new Error("Node tool authorization signature is invalid");
}

export async function invokeNodeTool(call: NodeToolCallV1): Promise<JsonValue> {
  const args = call.arguments;
  switch (call.name) {
    case "system.snapshot": return systemSnapshot();
    case "process.list": return command("ps", ["-eo", "pid=,ppid=,user=,%cpu=,%mem=,stat=,etimes=,comm=", "--sort=-%cpu"], 5_000, 96 * 1024);
    case "service.status": return serviceStatus(requireUnit(args.unit));
    case "journal.read": return journalRead(requireUnit(args.unit), boundedInteger(args.lines, 100, 1, 500));
    case "network.sockets": return command("ss", ["-lntupH"], 5_000, 96 * 1024);
    case "file.read": return safeFileRead(requireAbsolutePath(args.path), boundedInteger(args.maxBytes, 65_536, 1, 262_144));
    case "file.search": return fileSearch(requirePattern(args.pattern), requireAbsolutePath(args.path));
    case "file.write": throw new Error("R1 file.write execution is not enabled in the first remote Agent runtime");
    case "file.delete": throw new Error("R3 file.delete execution is not enabled");
    case "process.signal": throw new Error("R2 process.signal execution is not enabled");
    case "service.restart": throw new Error("R2 service.restart execution is not enabled");
    case "command.exec": throw new Error("R2 command.exec requires a separately registered command profile");
  }
}

async function systemSnapshot(): Promise<JsonValue> {
  const [uname, uptime, memory, disk, load, osRelease] = await Promise.all([
    command("uname", ["-a"]),
    command("uptime", ["-p"]),
    command("free", ["-b"]),
    command("df", ["-B1", "-x", "tmpfs", "-x", "devtmpfs", "--output=source,fstype,size,used,avail,pcent,target"]),
    safeFileRead("/proc/loadavg", 4_096),
    safeFileRead("/etc/os-release", 16_384),
  ]);
  return { observedAt: new Date().toISOString(), uname, uptime, memory, disk, load, osRelease };
}

async function serviceStatus(unit: string): Promise<JsonValue> {
  const properties = "Id,LoadState,ActiveState,SubState,UnitFileState,Description,MainPID,ExecMainStatus,ActiveEnterTimestamp";
  return command("systemctl", ["show", unit, `--property=${properties}`, "--no-pager"], 5_000, 64 * 1024);
}

async function journalRead(unit: string, lines: number): Promise<JsonValue> {
  return command("journalctl", ["--unit", unit, "--lines", String(lines), "--no-pager", "--output", "short-iso-precise"], 10_000, 192 * 1024);
}

async function fileSearch(pattern: string, root: string): Promise<JsonValue> {
  const canonical = await allowedReadPath(root);
  if (!["/etc", "/var/log", "/srv", "/opt", "/usr/local", "/run"].some((allowed) => canonical === allowed || canonical.startsWith(`${allowed}/`))) throw new Error("file.search root is outside the bounded search allow-list");
  const stats = await stat(canonical);
  if (!stats.isDirectory()) throw new Error("file.search path must be a directory");
  const files = await searchableFiles(canonical);
  if (files.length === 0) return { pattern, root: canonical, matches: [], searchedFiles: 0, truncated: false };
  const result = await command("rg", ["--fixed-strings", "--no-heading", "--line-number", "--max-count", "200", "--max-filesize", "2M", "--", pattern, ...files], 10_000, 192 * 1024, [0, 1]) as Record<string, JsonValue>;
  return { pattern, root: canonical, searchedFiles: files.length, truncated: files.length === MAX_SEARCH_FILES, result };
}

async function safeFileRead(path: string, maxBytes: number): Promise<JsonValue> {
  const canonical = await allowedReadPath(path);
  const stats = await stat(canonical);
  if (!stats.isFile() || stats.size > maxBytes) throw new Error("Requested file is not a bounded regular file");
  const bytes = await readFile(canonical);
  return { path: canonical, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), text: redactSensitiveText(bytes.toString("utf8")) };
}

const MAX_SEARCH_FILES = 256;
const MAX_SEARCH_DEPTH = 8;
const MAX_SEARCH_PATH_BYTES = 64 * 1024;

async function searchableFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let pathBytes = 0;
  const pending: Array<{ readonly path: string; readonly depth: number }> = [{ path: root, depth: 0 }];
  while (pending.length > 0 && files.length < MAX_SEARCH_FILES) {
    const current = pending.shift() as { readonly path: string; readonly depth: number };
    const entries = await readdir(current.path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= MAX_SEARCH_FILES) break;
      if (entry.isSymbolicLink() || sensitivePath(joinPath(current.path, entry.name))) continue;
      const candidate = joinPath(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_SEARCH_DEPTH) pending.push({ path: candidate, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const canonical = await allowedReadPath(candidate);
        const metadata = await stat(canonical);
        const candidateBytes = Buffer.byteLength(canonical, "utf8") + 1;
        if (metadata.isFile() && metadata.size <= 2 * 1_048_576 && pathBytes + candidateBytes <= MAX_SEARCH_PATH_BYTES) {
          files.push(canonical);
          pathBytes += candidateBytes;
        }
      } catch {
        // A single inaccessible or denied file does not broaden the search.
      }
    }
  }
  return files;
}

async function allowedReadPath(path: string): Promise<string> {
  if (sensitivePath(path) || (/^\/proc\//.test(path) && !new Set(["/proc/cpuinfo", "/proc/loadavg", "/proc/meminfo", "/proc/mounts", "/proc/uptime", "/proc/version"]).has(path))) throw new Error("Sensitive path is denied");
  const canonical = await realpath(path);
  // On systemd-based distributions /etc/os-release is commonly a symlink to
  // /usr/lib/os-release. It is public host metadata used by system.snapshot,
  // not a general expansion of the readable /usr tree.
  if (path === "/etc/os-release" && canonical === "/usr/lib/os-release") return canonical;
  const safeProcFiles = new Set(["/proc/cpuinfo", "/proc/loadavg", "/proc/meminfo", "/proc/mounts", "/proc/uptime", "/proc/version"]);
  if (canonical.startsWith("/proc/") && !safeProcFiles.has(canonical)) throw new Error("Sensitive or process-specific /proc path is denied");
  const allowedRoots = ["/etc", "/private/etc", "/proc", "/sys", "/var/log", "/srv", "/opt", "/usr/local", "/run"];
  if (!allowedRoots.some((root) => canonical === root || (!relative(root, canonical).startsWith("..") && !isAbsolute(relative(root, canonical))))) throw new Error("Path is outside the node read allow-list");
  if (sensitivePath(canonical)) throw new Error("Sensitive path is denied");
  return canonical;
}

async function command(executable: string, args: readonly string[], timeout = 5_000, maxBuffer = MAX_RESULT_BYTES, accepted = [0]): Promise<JsonValue> {
  try {
    const result = await execFile(executable, [...args], { timeout, maxBuffer, windowsHide: true, env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    return { executable, arguments: args, exitCode: 0, stdout: redactSensitiveText(result.stdout), stderr: redactSensitiveText(result.stderr) };
  } catch (caught) {
    const detail = caught as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    if (typeof detail.code === "number" && accepted.includes(detail.code)) return { executable, arguments: args, exitCode: detail.code, stdout: redactSensitiveText(detail.stdout ?? ""), stderr: redactSensitiveText(detail.stderr ?? "") };
    throw new Error(`${executable} failed: ${(detail.stderr ?? detail.message ?? "unknown error").slice(0, 4096)}`);
  }
}

function requireUnit(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,127}(?:\.service)?$/.test(value)) throw new Error("A valid systemd unit is required");
  return value.includes(".") ? value : `${value}.service`;
}

function requireAbsolutePath(value: JsonValue | undefined): string { if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.length > 4096) throw new Error("An absolute path is required"); return value; }
function requirePattern(value: JsonValue | undefined): string { if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 512 || value.includes("\0")) throw new Error("A bounded search pattern is required"); return value; }
function boundedInteger(value: JsonValue | undefined, fallback: number, minimum: number, maximum: number): number { const result = value === undefined ? fallback : value; if (!Number.isSafeInteger(result) || Number(result) < minimum || Number(result) > maximum) throw new Error("Integer argument is outside its allowed range"); return Number(result); }

function sensitivePath(path: string): boolean {
  return ["/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/environment", "/etc/machine-id", "/private/etc/shadow", "/private/etc/master.passwd", "/private/etc/sudoers"].includes(path) ||
    /\/(?:\.ssh|\.gnupg|\.aws|secrets?|credentials?|systemd\/credentials|systemd\/credential\.secret|NetworkManager\/system-connections|wireguard|openvpn|tailscale|friday)(?:\/|$)/i.test(path) ||
    /\/(?:\.env(?:\.[^/]*)?|[^/]*(?:private[-_.]?key|credential|secret)[^/]*)$/i.test(path) ||
    /\.(?:key|pem|p12|pfx|jks|kdbx)$/i.test(path) ||
    /^\/sys\/(?:kernel\/security|firmware|fs\/pstore)(?:\/|$)/.test(path);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*)(["'])[^\r\n]*?\2/gi, "$1[REDACTED]")
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}

function joinPath(parent: string, name: string): string { return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`; }
