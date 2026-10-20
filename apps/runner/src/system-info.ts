import { existsSync } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import type { RunnerSystemInfoV1 } from "@friday/protocol";

const text = (value: string, maximum = 160): string => value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, maximum);

async function metadata(path: string): Promise<string> {
  try { return (await readFile(path, "utf8")).slice(0, 8192); }
  catch { return ""; }
}

export async function collectSystemInfo(stateDir: string, environment = process.env): Promise<RunnerSystemInfoV1> {
  const runtime = environment.FRIDAY_RUNNER_CONTAINER === "1" || existsSync("/.dockerenv") ? "container" : "host";
  const metadataRoot = environment.FRIDAY_HOST_METADATA_ROOT ?? "";
  const [osRelease, synology] = await Promise.all([
    metadata(join(metadataRoot, "/etc/os-release")),
    metadata(join(metadataRoot, "/etc.defaults/VERSION")),
  ]);
  const field = (source: string, key: string) => source.match(new RegExp(`^${key}=["']?([^"'\\r\\n]+)`, "m"))?.[1];
  const major = field(synology, "majorversion");
  const minor = field(synology, "minorversion");
  const osName = major ? `Synology DSM ${major}.${minor ?? "0"}` : field(osRelease, "PRETTY_NAME") ?? `${platform()} ${release()}`;
  const processors = cpus();
  const info: RunnerSystemInfoV1 = {
    observedAt: new Date().toISOString(),
    osName: text(osName),
    osScope: runtime === "host" || (metadataRoot && (osRelease || synology)) ? "host" : "runner",
    kernel: text(release()),
    arch: text(arch(), 32),
    cpuModel: text(processors[0]?.model ?? arch()),
    cpuThreads: Math.max(1, processors.length),
    memoryBytes: totalmem(),
    runtime,
    storageScope: "runner-state",
  };
  try {
    const storage = await statfs(stateDir, { bigint: true });
    const total = Number(storage.blocks * storage.bsize);
    const available = Number(storage.bavail * storage.bsize);
    if (Number.isSafeInteger(total) && Number.isSafeInteger(available) && total >= 0 && available >= 0 && available <= total) {
      info.storageTotalBytes = total;
      info.storageAvailableBytes = available;
    }
  } catch {}
  return info;
}
