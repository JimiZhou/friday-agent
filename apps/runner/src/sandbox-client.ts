import { createConnection } from "node:net";
import type { JobSpecV2, RunnerModelAccessGrantV2 } from "@friday/protocol";

export interface SandboxExecutionResult {
  readonly ok: boolean;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
  readonly executorImageId?: string;
}

/** The Runner has no Docker API access: all execution is a single bounded Unix-socket request. */
export async function requestSandboxExecution(socketPath: string, spec: JobSpecV2, worktreePath: string, timeoutMs: number, modelAccess?: RunnerModelAccessGrantV2): Promise<SandboxExecutionResult> {
  if (!socketPath.startsWith("/")) throw new Error("FRIDAY_SANDBOX_SOCKET must be an absolute Unix socket path");
  return new Promise<SandboxExecutionResult>((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    const timer = setTimeout(() => { socket.destroy(new Error("Sandbox request timed out")); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(JSON.stringify({ spec, worktreePath, ...(modelAccess === undefined ? {} : { modelAccess }) })));
    socket.on("data", (chunk: string) => { output += chunk; if (Buffer.byteLength(output) > 1_048_576) socket.destroy(new Error("Sandbox response too large")); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("end", () => { clearTimeout(timer); try { const result = JSON.parse(output) as SandboxExecutionResult; if (typeof result !== "object" || result === null || typeof result.ok !== "boolean" || (result.ok && !/^sha256:[a-f0-9]{64}$/.test(result.executorImageId ?? ""))) throw new Error("Sandbox response is invalid"); resolvePromise(result); } catch (error) { reject(error); } });
  });
}
