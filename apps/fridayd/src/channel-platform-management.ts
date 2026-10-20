import { isPrivateChannel, type PrivateChannelV1 } from "@friday/protocol";

export interface PlatformTaskSummary {
  readonly jobId: string;
  readonly runnerId: string;
  readonly status: string;
  readonly operation: string;
}

export interface ChannelPlatformOptions {
  readonly enabled: boolean;
  readonly hubOrigin?: string;
  readonly status: () => Promise<string>;
  readonly tasks: () => readonly PlatformTaskSummary[];
  readonly channels: () => Promise<string>;
  readonly stopTask: (jobId: string, channel: PrivateChannelV1, senderId: string) => Promise<string>;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function platformMenu(hubOrigin?: string): string {
  return [
    "Friday 平台操作菜单",
    "发送以下 / 命令进行操作：",
    "• /status — 平台总览",
    "• /devices — 表格查看设备状态、系统与硬件配置",
    "• /runner add — 生成一条可直接在目标节点执行的纳管命令",
    "• /tasks — 查看最近任务及执行状态",
    "• /stop <任务ID> — 停止任务，执行前需确认",
    "• /confirm stop <任务ID> — 确认停止指定任务",
    "• /channels — 查看 IM 渠道状态和配置入口",
    "• /runner revoke <设备名称> — 撤销纳管，执行前需确认",
    "• /runner confirm revoke <设备名称> — 确认撤销指定设备",
    "• /cancel — 取消待确认操作",
    "• /menu — 再次显示此菜单（发送 / 也可以）",
    "你也可以说「检查所有设备」「在某台设备上排查故障」「新增纳管」「查看任务」。Friday 会结合全局状态安排执行。",
    "子节点主动连接 Hub 接收任务，无需开放入站端口。",
    ...(hubOrigin === undefined ? [] : [`设备与渠道配置：${hubOrigin}/#devices`, `任务与授权：${hubOrigin}/#clearance`]),
  ].join("\n\n");
}

export class ChannelPlatformManagement {
  readonly #pending = new Map<string, { jobId: string; expiresAt: number }>();
  constructor(readonly options: ChannelPlatformOptions) {}

  async handle(channel: string, senderId: string, text: string, now = Date.now(), allowSideEffects = true): Promise<string | undefined> {
    if (!isPrivateChannel(channel)) return undefined;
    const command = text.trim().toLowerCase();
    const owner = `${channel}:${senderId}`;
    for (const [key, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(key);
    if (["/", "/menu", "/help", "/start", "菜单", "操作菜单", "平台菜单", "帮助", "你能做什么", "平台管理"].includes(command)) return platformMenu(this.options.hubOrigin);
    if (["/status", "平台状态", "平台总览", "查看平台状态", "系统状态"].includes(command)) return this.options.status();
    if (["/channels", "消息渠道", "查看渠道", "渠道状态", "查看渠道状态", "配置消息渠道"].includes(command)) return this.options.channels();
    if (["/tasks", "查看任务", "任务列表", "最近任务", "查看任务状态"].includes(command)) {
      const tasks = this.options.tasks().slice(0, 20);
      if (tasks.length === 0) return "当前没有任务。可以直接告诉我需要在哪台设备上做什么。";
      return ["最近任务：", ...tasks.map((job) => `${job.operation} · ${job.status}\n任务 ID：${job.jobId}\n节点：${job.runnerId}`)].join("\n\n");
    }
    if (["/cancel", "取消操作", "取消待确认操作"].includes(command)) {
      if (allowSideEffects) this.#pending.delete(owner);
      return undefined;
    }
    const stop = command.match(new RegExp(`^(?:/stop|停止任务|取消任务)\\s+(${UUID})$`, "i"));
    const confirm = command.match(new RegExp(`^(?:/confirm stop|确认停止任务)\\s+(${UUID})$`, "i"));
    if (stop === null && confirm === null) {
      if (command.startsWith("/") && !command.startsWith("/runner") && !["/devices", "/nodes"].includes(command)) return "未识别这条命令。\n\n" + platformMenu(this.options.hubOrigin);
      return undefined;
    }
    if (!allowSideEffects) return "这条指令已处理，没有重复停止任务。";
    if (!this.options.enabled) return "IM 平台写操作尚未启用；请在 Hub 设置 FRIDAY_CHANNEL_FLEET_MANAGEMENT_ENABLE=1。";
    const jobId = (stop?.[1] ?? confirm?.[1]) as string;
    const job = this.options.tasks().find((task) => task.jobId === jobId);
    if (job === undefined) return "找不到该任务，请发送 /tasks 查看完整任务 ID。";
    if (TERMINAL.has(job.status)) { this.#pending.delete(owner); return "该任务已经结束，无需停止。"; }
    if (stop !== null) {
      if (this.#pending.size >= 32) this.#pending.delete(this.#pending.keys().next().value as string);
      this.#pending.set(owner, { jobId, expiresAt: now + 120_000 });
      return `将停止任务 ${jobId}（${job.operation}，节点 ${job.runnerId}）。停止不撤回已完成的修改。请在两分钟内回复：\n\n/confirm stop ${jobId}\n\n发送 /cancel 取消。`;
    }
    const pending = this.#pending.get(owner);
    this.#pending.delete(owner);
    if (pending?.jobId !== jobId) return "没有匹配的待确认停止操作，请重新发送 /stop <任务ID>。";
    return this.options.stopTask(jobId, channel, senderId);
  }
}
