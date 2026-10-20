import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [credentialPath, hubOrigin, runnerName, serviceUser, releaseId] = process.argv.slice(2);
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, ...options });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (process.platform !== "linux" || major < 22 || (major === 22 && minor < 19)) throw new Error("Linux and Node.js >=22.19.0 are required");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(serviceUser ?? "") || !/^[a-f0-9]{16}$/.test(releaseId ?? "") || !runnerName || runnerName.length > 128 || /[\x00-\x1f\x7f]/.test(runnerName)) throw new Error("Invalid installation options");
  const hub = new URL(hubOrigin);
  if ((hub.protocol !== "https:" && !(hub.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(hub.hostname))) || hub.origin !== hubOrigin || hub.username || hub.password) throw new Error("Hub must be an HTTPS origin or loopback HTTP");
  const credential = JSON.parse(readFileSync(credentialPath, "utf8"));
  if (!/^[0-9a-f-]{36}$/i.test(credential.runnerId ?? "") || typeof credential.enrollmentToken !== "string" || !credential.enrollmentToken || !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) throw new Error("Enrollment credential is invalid or expired");
  const root = process.getuid() === 0;
  const currentUser = run("id", ["-un"]).trim();
  if (!root && currentUser !== serviceUser) throw new Error("Run as the selected service user, or use sudo");
  const uid = Number(run("id", ["-u", serviceUser]).trim());
  const gid = Number(run("id", ["-g", serviceUser]).trim());
  const home = process.env.HOME;
  if (!home || !home.startsWith("/")) throw new Error("HOME is required");
  const installRoot = root ? "/opt/friday-agent" : join(home, ".local/share/friday-agent");
  const state = root ? "/var/lib/friday-runner" : join(home, ".local/share/friday-runner");
  const configDirectory = root ? "/etc/friday-runner" : join(home, ".config/friday-runner");
  const current = join(installRoot, "current");
  if (existsSync(join(state, "runner-device.json"))) throw new Error("This user already has a Runner identity; refusing duplicate enrollment");
  if (existsSync(current)) throw new Error("A Runner release already exists; use the upgrade command");
  let mode = "system";
  let docker;
  if (!root) {
    try {
      run("systemctl", ["--user", "show-environment"]);
      if (run("loginctl", ["show-user", serviceUser, "-p", "Linger"]).trim() !== "Linger=yes") run("loginctl", ["enable-linger", serviceUser]);
      if (run("loginctl", ["show-user", serviceUser, "-p", "Linger"]).trim() !== "Linger=yes") throw new Error("Persistent user services require linger");
      mode = "user";
    }
    catch {
      mode = "docker";
      docker = existsSync("/var/packages/ContainerManager/target/usr/bin/docker") ? "/var/packages/ContainerManager/target/usr/bin/docker" : "docker";
      run(docker, ["info", "--format", "{{.ServerVersion}}"]);
      try { run(docker, ["container", "inspect", "friday-runner"]); throw new Error("A friday-runner container already exists"); }
      catch (error) { if (error.message === "A friday-runner container already exists") throw error; }
      run(docker, ["pull", "node:22.22.0-bookworm-slim"], { timeout: 300_000 });
    }
  }
  if (root) run("systemctl", ["--version"]);
  const source = dirname(fileURLToPath(import.meta.url));
  const release = join(installRoot, "releases", releaseId);
  mkdirSync(dirname(release), { recursive: true, mode: 0o755 });
  cpSync(source, release, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  const normalize = (directory) => {
    chmodSync(directory, 0o755);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) normalize(path);
      else if (entry.isFile()) chmodSync(path, 0o644);
    }
  };
  normalize(release);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  if (root) chownSync(state, uid, gid);
  const tokenFile = join(state, "enrollment-token");
  writeFileSync(tokenFile, credential.enrollmentToken + "\n", { mode: 0o600, flag: "wx" });
  if (root) chownSync(tokenFile, uid, gid);
  const environment = { FRIDAY_HUB_URL: hub.origin, FRIDAY_RUNNER_NAME: runnerName, FRIDAY_RUNNER_STATE_DIR: state, FRIDAY_RUNNER_ID: credential.runnerId, FRIDAY_RUNNER_ENROLLMENT_FILE: tokenFile };
  const runner = join(release, "apps/runner/dist/index.js");
  const assignments = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
  if (root) run("runuser", ["-u", serviceUser, "--", "env", ...assignments, process.execPath, runner, "--once"]);
  else run(process.execPath, [runner, "--once"], { env: { ...process.env, ...environment } });
  if (existsSync(tokenFile)) throw new Error("Enrollment was not consumed");
  delete environment.FRIDAY_RUNNER_ENROLLMENT_FILE;
  delete environment.FRIDAY_RUNNER_ID;
  symlinkSync(`releases/${releaseId}`, current);
  if (mode === "docker") {
    const metadataMounts = ["/etc/os-release", "/etc.defaults/VERSION"].filter((path) => existsSync(path)).flatMap((path) => ["--mount", `type=bind,src=${path},dst=/host${path},readonly`]);
    run(docker, ["run", "-d", "--name", "friday-runner", "--restart", "unless-stopped", "--user", `${uid}:${gid}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--mount", `type=bind,src=${release},dst=/app,readonly`, "--mount", `type=bind,src=${state},dst=/state`, ...metadataMounts, "--env", "FRIDAY_RUNNER_CONTAINER=1", "--env", "FRIDAY_HOST_METADATA_ROOT=/host", "--env", `FRIDAY_HUB_URL=${hub.origin}`, "--env", `FRIDAY_RUNNER_NAME=${runnerName}`, "--env", "FRIDAY_RUNNER_STATE_DIR=/state", "--entrypoint", "node", "node:22.22.0-bookworm-slim", "/app/apps/runner/dist/index.js"]);
  } else {
    const envFile = join(configDirectory, `${serviceUser}.env`);
    writeFileSync(envFile, Object.entries(environment).map(([key, value]) => `${key}=${quote(value)}\n`).join(""), { mode: 0o600 });
    const unitDirectory = root ? "/etc/systemd/system" : join(home, ".config/systemd/user");
    mkdirSync(unitDirectory, { recursive: true, mode: 0o755 });
    const unitName = root ? `friday-runner@${serviceUser}.service` : "friday-runner.service";
    const unit = root
      ? readFileSync(join(release, "friday-runner-managed@.service"), "utf8").replace("/usr/bin/env node", JSON.stringify(process.execPath))
      : ["[Unit]", "Description=Friday outbound Runner", "After=network-online.target", "[Service]", "Type=simple", `EnvironmentFile=${envFile}`, `ExecStart=${JSON.stringify(process.execPath)} ${JSON.stringify(runner)}`, "Restart=always", "RestartSec=5", "UMask=0077", "NoNewPrivileges=yes", "[Install]", "WantedBy=default.target", ""].join("\n");
    writeFileSync(join(unitDirectory, root ? "friday-runner@.service" : unitName), unit, { mode: 0o644 });
    const prefix = root ? [] : ["--user"];
    run("systemctl", [...prefix, "daemon-reload"]);
    run("systemctl", [...prefix, "enable", "--now", unitName]);
    run("systemctl", [...prefix, "is-active", "--quiet", unitName]);
  }
  rmSync(credentialPath);
  console.log(JSON.stringify({ installed: true, runnerId: credential.runnerId, mode, outboundOnly: true }));
} catch (error) {
  console.error(`Runner installation failed: ${error.message}`);
  if (error.stderr) console.error(String(error.stderr).slice(0, 2000));
  process.exitCode = 1;
}
