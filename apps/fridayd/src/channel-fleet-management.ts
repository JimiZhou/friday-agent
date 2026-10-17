import type { RunnerEnrollment } from "./runner-registry.js";

const RUNNER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVOCATION_CONFIRMATION_TTL_MS = 2 * 60_000;
const MAX_PENDING_CONFIRMATIONS = 32;

export type PrivateChannel = "telegram" | "wechat_ilink";

export interface ChannelRunnerSummary {
  readonly runnerId: string;
  readonly name: string;
  readonly online: boolean;
  readonly activeJobs: number;
  readonly enrolled: boolean;
  readonly revocationPending: boolean;
}

interface PendingRevocation {
  readonly runnerId: string;
  readonly expiresAt: number;
  confirming: boolean;
}

export interface ChannelFleetManagementOptions {
  readonly enabled: boolean;
  readonly hubOrigin?: string;
  readonly listRunners: () => readonly ChannelRunnerSummary[];
  readonly issueEnrollment: (channel: PrivateChannel, senderId: string) => Promise<RunnerEnrollment>;
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
    if (channel !== "telegram" && channel !== "wechat_ilink") return undefined;
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
    if (command.type === "cancel") return pending?.confirming === true ? "撤销已进入执行阶段，无法取消。" : "已取消待确认的节点撤销操作。";
    if (!this.#options.enabled) return "IM 纳管操作尚未启用；请在 Hub 设置 `FRIDAY_CHANNEL_FLEET_MANAGEMENT_ENABLE=1`。";
    if (command.type === "add") return formatEnrollment(await this.#options.issueEnrollment(privateChannel, senderId), this.#options.hubOrigin);
    if (command.type === "revoke") return this.#requestRevocation(ownerKey, command.runnerId, now);
    if (command.type === "confirm") return this.#confirmRevocation(ownerKey, command.runnerId, privateChannel, senderId, now);
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
    return `撤销会立即断开这台节点的管理连接；当前没有未完成任务。若确定，请在两分钟内原样回复：\n\n**确认撤销节点 ${id}**`;
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
  | { readonly type: "help" | "list" | "add" | "cancel" }
  | { readonly type: "revoke" | "confirm"; readonly runnerId: string }
  | undefined {
  const normalized = text.trim();
  const command = normalized.toLocaleLowerCase("zh-CN");
  if (["/runner help", "节点管理帮助", "节点管理命令"].includes(command)) return { type: "help" };
  if (["/runner list", "节点列表", "查看节点"].includes(command)) return { type: "list" };
  if (["/runner add", "添加纳管节点", "新增纳管节点", "纳管新节点"].includes(command)) return { type: "add" };
  if (["/runner cancel", "取消撤销"].includes(command)) return { type: "cancel" };

  const revoke = normalized.match(/^(?:\/runner revoke |(?:撤销|删除)(?:纳管)?节点\s+)([0-9a-f-]+)$/i);
  if (revoke?.[1] !== undefined && RUNNER_ID_PATTERN.test(revoke[1])) return { type: "revoke", runnerId: revoke[1] };
  const confirm = normalized.match(/^(?:\/runner confirm revoke |确认撤销节点\s+)([0-9a-f-]+)$/i);
  if (confirm?.[1] !== undefined && RUNNER_ID_PATTERN.test(confirm[1])) return { type: "confirm", runnerId: confirm[1] };
  return undefined;
}

function managementHelp(): string {
  return [
    "节点管理命令（仅限已配对的私聊）：",
    "- `/runner list`：查看节点 ID、在线状态和任务数。",
    "- `/runner add`：签发十分钟有效的一次性纳管凭据。",
    "- `/runner revoke <runnerId>`：发起撤销；需要在两分钟内发送精确确认语。",
    "- `/runner cancel`：取消待确认的撤销。",
  ].join("\n");
}

function formatRunnerList(runners: readonly ChannelRunnerSummary[]): string {
  if (runners.length === 0) return "当前还没有登记过节点。";
  return runners.map((runner) => {
    const enrollment = runner.revocationPending
      ? "撤销确认中"
      : runner.enrolled
        ? "已纳管"
        : "已撤销";
    const availability = runner.online ? "在线" : "离线";
    return `- ${runner.name}（${enrollment}，${availability}，未完成任务 ${runner.activeJobs}）\n  ID：\`${runner.runnerId}\``;
  }).join("\n");
}

function formatEnrollment(enrollment: RunnerEnrollment, hubOrigin: string | undefined): string {
  const origin = hubOrigin ?? "<Hub HTTPS origin>";
  return [
    "已签发十分钟有效的一次性纳管凭据。它只显示这一次，请仅保存在私密的 0600 JSON 文件中，不要转发或发到群聊。",
    "在有 SSH 权限的运维机上使用 `fridayctl runner bootstrap`；该命令会复用此凭据，不会再签发第二个。CLI 仍需通过 `FRIDAY_OWNER_TOKEN` 验证节点上线状态。",
    "保存以下内容为 JSON 文件并设置权限 `chmod 600 <file>`：",
    "```json",
    JSON.stringify(enrollment, null, 2),
    "```",
    `命令模板：\`fridayctl runner bootstrap <user@host> --hub-url ${origin} --runner-name <name> --service-user <user> --enrollment-file <file>\``,
  ].join("\n\n");
}
