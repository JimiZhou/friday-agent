# M3 受控扩展与自我改进

M3 不把“可扩展”变成模型可自行安装的插件市场。MCP、适配器、Procedure、Skill 与任何产生外部副作用的变更仍需 Owner Web/Owner Token 显式操作；只有无外部副作用、通过绑定测试证据的低风险自我补丁可以由 Hub 自动采纳为下一次受控发布候选。Channel Gateway 没有这些接口的凭据。

## MCP / Search

`/v3/mcp` 持久化名称、SemVer、HTTPS 来源、Schema SHA-256 和网络/文件/Secret/时限预算。重新登记会自动禁用旧定义；必须再显式 `enable`。

`McpBroker` 的生产 transport 是独立 `mcp-broker` 容器的 Unix socket，不是 Hub 内的 fetch。Broker 没有 Hub 数据库、Owner Token、模型 Key、代理认证或 Hub 环境文件；它只接受固定定义和普通文本输入，且自己的 `FRIDAY_MCP_BROKER_ALLOWED_ORIGINS` 必须包含目标的精确 HTTPS Origin。它禁用 cookie、重定向和 Secret 引用，并将响应长度、单次请求和超时再次限制在登记预算内。调用前后都核算预算，所有结果都带有 `trust: "untrusted"`、固定来源与 Schema hash。停止 Broker 时 `POST /v3/mcp/invoke` 失败关闭，不影响 M1 Job 闭环。

要开放真实 MCP，部署者必须另行提供经审计的、网络和文件系统隔离的 transport，并将它的出站规则、Secret reference 兑换器和资源限制与此定义一并验证。不得把模型输出、MCP 输出或网页指令作为安装/启用权限。

## 适配器与 Runner

`/v3/runner-adapters` 仅能给**已登记、未吊销**的 Runner 固定 `remote-agent`、`codex-app-server`、`pi-rpc` 或 `claude-code` 兼容能力名及不可变 `sha256:` 镜像 ID。`remote-agent` 是通用规划运行时，通过 Hub 逐次授权的 Node Tool Call 操作目标节点；其余三项是专业执行器。登记后默认禁用，Owner 显式 enable。生产调度不再接受 diagnostic fixture。

该记录是对现有 root-owned `friday-sandboxd` 的额外准入清单，不给 Runner Docker socket、Root 或宿主机执行权限。没有经过验证的镜像、隔离后端和私有模型凭据时，执行仍必须拒绝。Agent 镜像在构建时会实际启动三个精确版本 CLI，并用受控模型 fixture 验证 Codex `/responses`、Pi `/chat/completions` 与 Claude `/v1/messages` 请求。每个新部署仍需用自己的私有 Provider 配置完成只读 Remote Agent E2E，不能用 Registry enable 或 build fixture 代替。

## Procedure / Skill

设置 `FRIDAY_PROCEDURE_OWNER_PUBLIC_KEY` 为 Owner Ed25519 公钥后，Hub 才开放 `/v3/procedures`。每个 Procedure 的 payload（ID、版本、能力、manifest hash）必须通过该公钥验签，随后使用不可变的 sandbox 回放证据 SHA-256 调用版本 `/verify`。未验证版本不能 enable；回滚只能指向已回放验证的前一个版本。

设置 `FRIDAY_SKILL_OWNER_PUBLIC_KEY` 后，`/v3/skills` 使用同一生命周期登记独立的 Skill：ID、SemVer、精确 HTTPS 来源、内容 SHA-256、能力清单和 Owner Ed25519 签名。每个版本需要 `/verify` 写入 Sandbox 回放证据后才能 `enable`，`rollback` 仅能回到已验证的旧版本。Skill Registry 不下载、安装或执行 Skill；它只是给已审核的 Sandbox Procedure 绑定不可变内容摘要。模型不能调用 Registry 安装、更新或扩大权限。

## Friday 自补丁

`/v3/self-patches` 只保存以 `friday/self/<name>` 分支命名、以 `diff --git` 开头的受限 Patch 摘要。状态只能按下列顺序前进：

```text
DRAFT --test evidence--> TESTED --low risk--> ADOPTED (next controlled release candidate)
                             |
                             +--material effect / R2-R3--> WAIT_APPROVAL
                                   --matching clearance--> CLEARED
                                   --canary id-----------> CANARY --success--> DEPLOYED
                                                               --failure--> ROLLED_BACK
```

Registry 不会改写运行中的 `main`、不会自动 Push，也不会部署 Canary。低风险记录进入 `ADOPTED` 后只进入下一次受控发布候选队列，不等于上线。`self-patch-worktree` 提供的操作员侧原语只会创建 `friday/self/*` 分支的隔离 worktree、以 `git apply --check` 校验 Diff，并且仅在该 worktree 内应用已校验补丁；测试覆盖了 live `main` 不发生变化。涉及联网/依赖、服务重启、Canary、Git Push、Policy/凭据/Root、删除或生产切换时，操作员仍必须审阅 Diff、用 Owner Web 完成 R2/R3 clearance，并以已知 Canary 标识记录结果；失败则记录 `ROLLED_BACK`。每次操作应保留测试日志/制品的 SHA-256 作为证据。

操作员可用 `friday-self-patch prepare <repository-root> <state-directory> <id> <friday/self/branch> <patch-file>` 创建并校验 worktree；只有显式 `apply-test` 才会在该隔离 worktree 内应用补丁并运行固定的 `npm test`。这两个命令均不会对 live `main` 执行 checkout、reset、commit 或 push。
