# GitHub 同类项目调研

> 核验日期：2026-07-30
> 目的：判断 Friday 应复用哪些现成部件，而不是选择另一个大而全框架。

## 核验快照

本轮通过 GitHub Git 端点读取各仓库默认分支 `HEAD`，因此下列结论可回溯到具体提交，而不是依赖会持续变化的项目首页：

| 项目 | 默认分支 | 核验提交 |
| --- | --- | --- |
| `earendil-works/pi` | `main` | `bb226f9c1f38d3c029156a690e97bbfc602336b9` |
| `nanocoai/nanoclaw` | `main` | `4e83a0a05fb67e7a33617f2072946a19c25fa8c5` |
| `sipeed/picoclaw` | `main` | `49183d7e8daed0dba89ddbb6fcb60089401d9680` |
| `zeroclaw-labs/zeroclaw` | `master` | `bec32b3eaad34bd111441a16c7c2e4c85b42d6c0` |
| `jacobaraujo7/remote_pi` | `main` | `28cefd5c9f9800f7cd5a2e82ccb2ea59086a6a58` |
| `coder/agentapi` | `main` | `9ff117e231822f670305254ef24f6389f75953f4` |
| `rohitg00/tailclaude` | `main` | `cac0bdf7a581b01eeba86860a6de58a08a4a8a11` |

Pi 的版本号另从上述提交的 `packages/coding-agent/package.json` 读取，确认为 `@earendil-works/pi-coding-agent` `0.83.0`。这些提交只用于固定本次调研证据；Friday 真正集成时仍需单独固定源码或 npm 制品、lockfile 与 SHA-256。

## 结论

在本次列出的项目和 2026-07-30 核验快照中，没有一个项目同时满足 Friday 的核心约束：单 Owner、Pi 作为可替换推理层、跨机器持久 Job、Hub/Runner 双重策略、Tailscale 优先、IM/语音仅作边缘入口，以及人工控制升级。这不是对 GitHub 全部项目的穷尽性证明。

因此不建议 Fork OpenClaw 或任何“全功能替代品”。更稳妥的路线是保留 Friday 自己的小型控制面与协议，只在清晰边界后复用成熟部件。下面项目更适合作为设计样本或 Runner 内部适配器，而不是 Friday Core。

## 对比

| 项目 | 已验证的定位 | 值得借鉴 | 不直接采用的原因 |
| --- | --- | --- | --- |
| [earendil-works/pi](https://github.com/earendil-works/pi) | Pi Agent Harness；包含 coding agent、agent core 和多模型 API。核验快照中的 coding-agent 包为 `0.83.0` | RPC/Agent 生命周期、模型抽象、Session 与 Compaction | 官方明确说明自身不提供文件、进程、网络或凭据权限隔离；必须放在 Friday Policy 与 Sandbox 后面 |
| [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) | 面向个人的容器化消息 Agent，强调小代码库和按需 Skill | 宿主路由与容器分离、显式挂载、渠道按需安装、SQLite 单写者 | 核心路径原生偏向 Claude Agent SDK，并鼓励通过修改用户 Fork 自定义；Friday 更需要稳定协议、可回滚升级和跨机器 Job 对账 |
| [sipeed/picoclaw](https://github.com/sipeed/picoclaw) | Go 单二进制的低资源个人助手，覆盖渠道、MCP、模型路由和 Web UI | NAS/小主机低占用、跨架构制品、能力接口 | README 明确标注仍处于快速早期开发且不建议生产部署；产品面已在快速扩展，不能解决用户最在意的升级稳定性 |
| [zeroclaw-labs/zeroclaw](https://github.com/zeroclaw-labs/zeroclaw) | Rust 单二进制 Agent Runtime，集成大量渠道、Provider、工具、Memory 与安全模式 | 本机 Sandbox、风险分级、工具回执、可裁剪构建 | 30+ 渠道与大量内建能力仍是大一统 Runtime；Friday 不应把渠道、推理、策略和远程执行重新耦合在一个发布节奏里 |
| [jacobaraujo7/remote_pi](https://github.com/jacobaraujo7/remote_pi) | 手机经 WebSocket Relay 控制本机 Pi；QR 配对、Ed25519 和自托管 Relay | 手机配对体验、短时 QR、设备密钥、远程 Pi Session UX | 当前 Relay 消息不是端到端加密，且主要解决“远程聊天到 Pi”，没有 Friday 所需的持久 Job、审批摘要和目标机策略复核 |
| [coder/agentapi](https://github.com/coder/agentapi) | 用统一 HTTP/SSE 接口控制 Codex、Claude Code 等多种 Coding Agent | 可作为 Runner 的兼容适配器；统一消息、状态和事件 API | 实现依赖内存终端与 TUI 输出解析，上游界面变化可能破坏解析；Friday 首选官方结构化接口，只把它作为显式兼容后端 |
| [rohitg00/tailclaude](https://github.com/rohitg00/tailclaude) | 经 Tailscale Serve/Funnel 提供 Claude Code Web UI 和流式 Session | Tailnet 内 HTTPS、二维码入口、SSE 重连、移动端交互 | 面向单机 Claude 进程与 Web 代理，不是多 Runner 的授权、租约、幂等和故障对账控制面；Funnel 也不应成为 Friday 默认暴露方式 |

## 对 Friday 的直接影响

1. **Pi 只做推理。** 按 Pi 自己声明的权限边界，`pi-worker` 必须是独立进程或容器，不能让 Pi 直接持有 SSH、Owner home 或长期 Secret。
2. **借 NanoClaw 的隔离思路，不借它的演进方式。** Friday 使用显式挂载与按需 Sidecar，但核心行为通过版本化协议和配置扩展，不依赖 Agent 随时重写运行中的控制面。
3. **借 PicoClaw 的低占用目标，不复制功能数量。** Hub 保持单进程、SQLite 和少量 Sidecar；渠道与 Provider 不进入核心二进制。
4. **把 AgentAPI 当兼容层。** Runner 优先使用固定版本、可非交互运行并有 HTTP 合约 fixture 的 Codex/Pi/Claude CLI；只有没有稳定输出模式的工具才允许使用 PTY/TUI 解析，并通过契约测试隔离上游变化。
5. **借 Remote Pi 与 TailClaude 的入口体验。** QR 配对、Tailnet HTTPS、移动端流式交互都可复用其思路，但请求进入 Friday 后必须转换为持久 Job，不能直接等同于终端输入。

因此目标态 Friday 的最小稳定内核应只包含：Owner Gate、Job/Policy/Approval、EventStore、Runner Registry 和签名协议。M1–M3 已在此内核上增加 SQLite WAL、一次性登记、设备签名与吊销、受控 Pi RPC、Coding Agent sandbox、IM/语音 sidecar、独立 MCP Broker 与签名 Procedure；外部凭据和镜像仍由 Owner 在私有环境文件中显式启用，缺失时保持禁用。
