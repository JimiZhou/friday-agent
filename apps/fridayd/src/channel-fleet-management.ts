import { isPrivateChannel, type PrivateChannelV1, type RunnerSystemInfoV1 } from "@friday/protocol";

const RUNNER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVOCATION_CONFIRMATION_TTL_MS = 2 * 60_000;
const MAX_PENDING_CONFIRMATIONS = 32;

export type PrivateChannel = PrivateChannelV1;

export interface ChannelRunnerSummary {
  readonly runnerId: string;
  readonly name: string;
  readonly online: boolean;
  readonly activeJobs: number;
  readonly enrolled: boolean;
  readonly revocationPending: boolean;
  readonly systemInfo?: RunnerSystemInfoV1;
}

interface PendingRevocation {
  readonly runnerId: string;
  readonly expiresAt: number;
  confirming: boolean;
}

export interface ChannelInstallRequest {
  readonly runnerName?: string;
  readonly serviceUser?: string;
  readonly sshTarget?: string;
}

export interface ChannelInstallCommand {
  readonly command: string;
  readonly expiresAt: string;
}

export type ChannelInstallResult =
  | { readonly ok: true; readonly install: ChannelInstallCommand }
  | { readonly ok: false; readonly message: string };

export interface ChannelFleetManagementOptions {
  readonly enabled: boolean;
  readonly hubOrigin?: string;
  readonly listRunners: () => readonly ChannelRunnerSummary[];
  readonly issueInstallCommand: (channel: PrivateChannel, senderId: string, request: ChannelInstallRequest) => Promise<ChannelInstallResult>;
  readonly checkRevocation: (runnerId: string) => string | undefined;
  readonly revokeRunner: (runnerId: string, channel: PrivateChannel, senderId: string) => Promise<string>;
}

export class ChannelFleetManagement {
  readonly #options: ChannelFleetManagementOptions;
  readonly #pendingByOwner = new Map<string, PendingRevocation>();
  readonly #pendingRunnerIds = new Set<string>();

  constructor(options: ChannelFleetManagementOptions) {
    this.#options = options;
  }

  isPendingRevocation(runnerId: string): boolean {
    this.#purgeExpired(Date.now());
    return this.#pendingRunnerIds.has(runnerId.toLowerCase());
  }

  checkRevocation(runnerId: string): string | undefined {
    return this.#options.checkRevocation(runnerId);
  }

  async handle(channel: string, senderId: string, text: string, now = Date.now(), allowSideEffects = true): Promise<string | undefined> {
    if (!isPrivateChannel(channel)) return undefined;
    const privateChannel = channel as PrivateChannel;
    const command = parseCommand(text);
    const ownerKey = `${privateChannel}:${senderId}`;
    const pending = this.#pendingByOwner.get(ownerKey);

    this.#purgeExpired(now);
    if (allowSideEffects && command?.type !== "confirm" && pending !== undefined && !pending.confirming) this.#clearPending(ownerKey, pending);
    if (command === undefined) return undefined;

    if (command.type === "help") return managementHelp();
    if (command.type === "list") return formatRunnerList(this.#options.listRunners());
    if (!allowSideEffects) return "这条指令已处理；我没有重复执行纳管操作。";
    if (command.type === "cancel") return pending?.confirming === true ? "撤销已进入执行阶段，无法取消。" : "已取消待确认操作。";
    if (!this.#options.enabled) return "IM 纳管操作尚未启用；请在 Hub 设置 `FRIDAY_CHANNEL_FLEET_MANAGEMENT_ENABLE=1`。";
    if (command.type === "add") {
      if (command.invalid === true) return addUsage();
      const result = await this.#options.issueInstallCommand(privateChannel, senderId, {
        ...(command.runnerName === undefined ? {} : { runnerName: command.runnerName }),
        ...(command.serviceUser === undefined ? {} : { serviceUser: command.serviceUser }),
        ...(command.sshTarget === undefined ? {} : { sshTarget: command.sshTarget }),
      });
      return result.ok ? formatInstallCommand(result.install) : result.message;
    }
    if (command.type === "revoke" || command.type === "confirm") {
      const matches = this.#options.listRunners().filter((runner) => runner.name === command.runnerId);
      if (matches.length > 1) return "设备名称重复，请在 Web 设备管理中选择具体设备操作。";
      const runnerId = RUNNER_ID_PATTERN.test(command.runnerId) ? command.runnerId : matches[0]?.runnerId;
      if (runnerId === undefined) return "找不到该设备，请发送 /devices 查看设备名称。";
      return command.type === "revoke" ? this.#requestRevocation(ownerKey, runnerId, now) : this.#confirmRevocation(ownerKey, runnerId, privateChannel, senderId, now);
    }
    return undefined;
  }

  #requestRevocation(ownerKey: string, runnerId: string, now: number): string {
    const id = runnerId.toLowerCase();
    const problem = this.#options.checkRevocation(id);
    if (problem !== undefined) return problem;
    if (this.#pendingRunnerIds.has(id)) return "这台节点已有待确认的撤销操作；请先完成或取消它。";

    while (this.#pendingByOwner.size >= MAX_PENDING_CONFIRMATIONS) {
      const oldest = this.#pendingByOwner.entries().next().value as [string, PendingRevocation] | undefined;
      if (oldest === undefined) break;
      this.#clearPending(oldest[0], oldest[1]);
    }
    const expiresAt = now + REVOCATION_CONFIRMATION_TTL_MS;
    const pending = { runnerId: id, expiresAt, confirming: false };
    this.#pendingByOwner.set(ownerKey, pending);
    this.#pendingRunnerIds.add(id);
    const runner = this.#options.listRunners().find((item) => item.runnerId === id);
    const selector = runner !== undefined && this.#options.listRunners().filter((item) => item.name === runner.name).length === 1 ? runner.name : id;
    return `撤销会立即断开这台节点的管理连接；当前没有未完成任务。若确定，请在两分钟内原样回复：\n\n/runner confirm revoke ${selector}\n\n发送 /cancel 取消。`;
  }

  async #confirmRevocation(
    ownerKey: string,
    runnerId: string,
    channel: PrivateChannel,
    senderId: string,
    now: number,
  ): Promise<string> {
    const pending = this.#pendingByOwner.get(ownerKey);
    if (pending === undefined) return "没有匹配的待确认撤销操作；如仍需要，请重新发起。";
    if (pending.confirming) return "这台节点的撤销已在执行中，请稍候。";
    if (pending.expiresAt <= now) {
      this.#clearPending(ownerKey, pending);
      return "撤销确认已过期，我没有执行。请重新发起。";
    }
    if (pending.runnerId !== runnerId.toLowerCase()) {
      this.#clearPending(ownerKey, pending);
      return "确认的节点 ID 与待撤销节点不一致，我没有执行。";
    }
    const problem = this.#options.checkRevocation(pending.runnerId);
    if (problem !== undefined) {
      this.#clearPending(ownerKey, pending);
      return problem;
    }
    pending.confirming = true;
    try {
      return await this.#options.revokeRunner(pending.runnerId, channel, senderId);
    } finally {
      this.#clearPending(ownerKey, pending);
    }
  }

  #clearPending(ownerKey: string, pending: PendingRevocation): void {
    this.#pendingByOwner.delete(ownerKey);
    this.#pendingRunnerIds.delete(pending.runnerId);
  }

  #purgeExpired(now: number): void {
    for (const [ownerKey, pending] of this.#pendingByOwner) {
      if (!pending.confirming && pending.expiresAt <= now) this.#clearPending(ownerKey, pending);
    }
  }
}

function parseCommand(text: string):
  | { readonly type: "help" | "list" | "cancel" }
  | { readonly type: "add"; readonly runnerName?: string; readonly serviceUser?: string; readonly sshTarget?: string; readonly invalid?: boolean }
  | { readonly type: "revoke" | "confirm"; readonly runnerId: string }
  | undefined {
  const normalized = text.trim();
  const command = normalized.toLocaleLowerCase("zh-CN");
  if (["/runner help", "节点管理帮助", "节点管理命令"].includes(command)) return { type: "help" };
  if (["/runner list", "/devices", "/nodes", "节点列表", "查看节点", "查看设备", "设备列表", "查看所有设备"].includes(command)) return { type: "list" };
  if (["/runner add", "添加纳管节点", "新增纳管节点", "纳管新节点", "新增纳管", "新增设备", "添加设备", "纳管设备"].includes(command)) return { type: "add" };
  if (["/runner cancel", "/cancel", "取消撤销", "取消操作", "取消待确认操作"].includes(command)) return { type: "cancel" };

  const add = normalized.match(/^\/runner add\s+([^\r\n]+)$/i);
  if (add?.[1] !== undefined) {
    const parts = add[1].trim().split(/\s+/);
    if (parts.length > 3 || parts.some((part) => part === "")) return { type: "add", invalid: true };
    return { type: "add", ...(parts[0] === undefined ? {} : { runnerName: parts[0] }), ...(parts[1] === undefined ? {} : { serviceUser: parts[1] }), ...(parts[2] === undefined ? {} : { sshTarget: parts[2] }) };
  }

  const revoke = normalized.match(/^(?:\/runner revoke |(?:撤销|删除)(?:纳管)?节点\s+)([^\r\n]{1,128})$/i);
  if (revoke?.[1] !== undefined) return { type: "revoke", runnerId: revoke[1].trim() };
  const confirm = normalized.match(/^(?:\/runner confirm revoke |确认撤销节点\s+)([^\r\n]{1,128})$/i);
  if (confirm?.[1] !== undefined) return { type: "confirm", runnerId: confirm[1].trim() };
  return undefined;
}

function managementHelp(): string {
  return [
    "节点管理命令（仅限已配对的私聊）：",
    "- `/runner list`：表格查看设备名称、在线状态、系统和硬件配置。",
    "- `/runner add [设备名] [服务用户] [SSH目标]`：直接返回一条可在目标节点执行的纳管命令。省略参数时使用目标机 hostname 和当前登录用户，SSH 目标取 Hub 配置的默认值。",
    "- `/runner revoke <设备名称>`：发起撤销；需要在两分钟内发送精确确认语。",
    "- `/runner cancel`：取消待确认的撤销。",
  ].join("\n");
}

function addUsage(): string {
  return "用法：`/runner add [设备名] [服务用户] [SSH目标]`\n例如：`/runner add build-node ubuntu hub-ssh`。只填设备名时，服务用户使用目标机当前登录用户。";
}

function formatInstallCommand(install: ChannelInstallCommand): string {
  return [
    "已生成十分钟有效的一次性纳管命令。命令包含一次性凭据，仅当前私聊可见，请勿转发或发到群聊。",
    "在目标节点终端粘贴执行下面这一条命令即可，无需 fridayctl、项目源码或 Owner Token：",
    "```sh\n" + install.command + "\n```",
    "默认在目标节点建立常驻 SSH 隧道并主动连接 Hub，不需要 Tailscale 或开放入站端口。",
  ].join("\n\n");
}

function formatRunnerList(runners: readonly ChannelRunnerSummary[]): string {
  if (runners.length === 0) return "当前还没有登记过节点。";
  const cell = (value: string) => value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n\t]/g, " ").replace(/`/g, "\\`").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const size = (bytes: number) => bytes >= 1024 ** 4 ? (bytes / 1024 ** 4).toFixed(1) + " TiB" : (bytes / 1024 ** 3).toFixed(1) + " GiB";
  const rows = runners.map((runner) => {
    const enrollment = runner.revocationPending
      ? "撤销确认中"
      : runner.enrolled
        ? "已纳管"
        : "已撤销";
    const availability = runner.online ? "在线" : "离线";
    const info = runner.systemInfo;
    const system = info ? `${info.osName} · ${info.arch}${info.osScope === "runner" ? "（运行环境）" : ""}` : "待上报";
    const hardware = info ? `${info.cpuModel} · ${info.cpuThreads} 线程 / ${size(info.memoryBytes)}` : "待上报";
    const storage = info?.storageTotalBytes === undefined ? "待上报" : `${info.storageAvailableBytes === undefined ? "未知" : size(info.storageAvailableBytes)} / ${size(info.storageTotalBytes)}`;
    return "| " + [runner.name, `${availability} · ${enrollment}`, system, hardware, storage, String(runner.activeJobs)].map(cell).join(" | ") + " |";
  });
  return ["| 设备 | 状态 | 系统 | CPU / 内存 | 所在卷可用 / 总量 | 任务 |", "| --- | --- | --- | --- | --- | --- |", ...rows, "", "配置为节点启动时上报；存储指 Runner 数据所在卷，不代表所有硬盘容量或健康状态。"].join("\n");
}
