# Friday Agent 部署、验收与回滚

首版生产拓扑由一个 Hub、一个独立 Channel Gateway 和一个或多个 Runner 组成。Hub 始终监听 `127.0.0.1:4310`；Gateway 控制面监听 `127.0.0.1:4311`；Runner 只主动连接 Hub，不开放 Friday 管理端口。

推荐使用 Tailscale：Hub 和 Runner 加入同一 Tailnet，Hub 通过 Tailscale Serve 提供 Tailnet 内 HTTPS，不启用 Funnel。非 Tailscale 模式需要已有私网 HTTPS 反向代理和 SSH 公钥信任，不能把 `4310` 直接映射到公网。

## 1. 发布前验证

```sh
nvm use
npm ci --ignore-scripts
npm test
npm audit --audit-level=moderate
git diff --check
sh -n deploy/hub/install-hub.sh
sh -n deploy/hub/configure-telegram.sh
sh -n deploy/runner/install-managed-runner.sh
sh -n deploy/runner/upgrade-managed-runner.sh
sh -n deploy/sandboxd/install-managed-sandboxd.sh
```

不要把任何已填写的 `.env`、模型 Key、Telegram Bot Token、iLink 凭据、SSH 私钥、Tailnet 真实名称或节点清单放入仓库。

## 2. 网络选择

### 2.1 推荐：Tailscale

在 Hub 和受控节点上安装并登录 Tailscale。ACL 至少允许：

- Owner 设备访问 Hub 的 Tailscale Serve HTTPS；
- Runner 访问同一个 Hub HTTPS Origin；
- 用于首次安装的管理端访问目标节点 SSH。

Friday Agent 不要求管理用电脑加入 Tailnet；只要有另一台已授权设备能访问 Web 控制台即可。Hub 不开启 Funnel，不开放 `4310`、`4311`、Runner RPC 或 Sandbox socket。

### 2.2 替代：现有私网 HTTPS + SSH 公钥

如果不使用 Tailscale：

1. 由现有 VPN、内网或私有反向代理把一个有效 HTTPS Origin 转发到 Hub 的 `127.0.0.1:4310`；
2. 确认所有 Runner 都能访问该 Origin；
3. 通过云控制台、镜像初始化或现有可信运维通道安装 SSH 公钥；
4. 先建立并核对 `known_hosts`，再运行 `fridayctl`。

`fridayctl` 固定使用 `BatchMode=yes`、`PasswordAuthentication=no`、`KbdInteractiveAuthentication=no` 和 `StrictHostKeyChecking=yes`。它不会提示、保存或代填 SSH 密码。

## 3. 一键安装 Hub

要求：Linux、root、Docker Engine、Docker Compose v2、curl、OpenSSL。Tailscale 模式还要求 Hub 已完成 `tailscale up`。

```sh
sudo ./deploy/hub/install-hub.sh \
  --origin https://friday-hub.example-tailnet.ts.net \
  --network tailscale
```

不使用 Tailscale 时：

```sh
sudo ./deploy/hub/install-hub.sh \
  --origin https://friday.internal.example \
  --network private-https
```

安装器执行以下受控变更：

- 创建 `friday-hub` 低权限系统用户；
- 创建 `/var/lib/friday-hub/state` 与 `/var/lib/friday-channel-gateway`，权限 `0700`；
- 生成 `deploy/hub/.env`、`deploy/hub/hub.env` 和 `deploy/gateway/gateway.env`，权限 `0600`；
- 构建 `friday-agent-hub:0.2.0`，启动 Hub 和 Channel Gateway；
- 为 iLink 生成作用域化 ingest token；
- Tailscale 模式执行 `tailscale serve --bg --https=443`，不执行 Funnel；
- 只在终端输出一次 Web 密码与 Owner Token。

如果私有 env 文件已存在，安装器会拒绝覆盖，避免重跑时意外轮换生产凭据。Hub 健康检查：

```sh
curl -fsS http://127.0.0.1:4310/health
docker compose -f deploy/hub/compose.yml ps
```

`FRIDAY_PUBLIC_ORIGIN` 必须与浏览器实际 Origin 完全一致，否则登录和所有带副作用的 Web 请求会被 Origin/CSRF 校验拒绝。

## 4. 模型与凭据

安装器只建立控制面和渠道，不替用户选择模型。编辑 root-owned `deploy/hub/hub.env`，按需启用：

```text
# Hub Conversation Pi：必须整组配置
FRIDAY_CONVERSATION_ENABLE=1
FRIDAY_PI_NODE_BIN=/usr/local/bin/node
FRIDAY_PI_WORKER_SCRIPT=/app/apps/pi-worker/dist/index.js
FRIDAY_PI_BIN=/app/node_modules/.bin/pi
FRIDAY_PI_BASE_URL=https://model-provider.example/v1/
FRIDAY_PI_MODEL=conversation-model
FRIDAY_PI_API_KEY=REPLACE_WITH_PRIVATE_KEY

# Runner Codex/Pi：必须整组配置
FRIDAY_RUNNER_OPENAI_BASE_URL=https://model-provider.example/v1/
FRIDAY_RUNNER_OPENAI_API_KEY=REPLACE_WITH_PRIVATE_KEY
FRIDAY_RUNNER_CODEX_MODEL=codex-model
FRIDAY_RUNNER_PI_MODEL=pi-model

# Runner Claude Code：必须整组配置
FRIDAY_RUNNER_ANTHROPIC_BASE_URL=https://api.anthropic.com/v1/
FRIDAY_RUNNER_ANTHROPIC_API_KEY=REPLACE_WITH_PRIVATE_KEY
FRIDAY_RUNNER_CLAUDE_MODEL=claude-model
```

然后重建/重启 Hub：

```sh
sudo chmod 600 deploy/hub/hub.env
docker compose -f deploy/hub/compose.yml up -d --build hub
curl -fsS http://127.0.0.1:4310/health
```

长期 Key 只存在 Hub。Runner 通过签名 Job 和租约向 Hub 申请短时模型 token，Sandbox 通过只读 Unix socket 使用它；Hub 不把长期 Key返回给节点。

## 5. 微信 iLink 与 Telegram

### 5.1 微信 iLink

安装完成后登录 Web 控制台，进入“设备”页面，点击绑定微信 iLink 并扫码。Gateway 原子写入 `wechat-ilink-credentials.json`，权限 `0600`。Hub 在确认时自动把该 iLink user ID 配对为唯一 Owner。

iLink 只接受私聊，拒绝群聊、未配对 sender 和 replay。Gateway 只持有 channel ingest/control 凭据，不能读取 Owner 管理 API 或批准任务。

### 5.2 Telegram Bot

Bot Token 和数字 Owner ID 只能通过环境变量交给配置脚本，不接受命令行参数：

```sh
read -r -s FRIDAY_TELEGRAM_BOT_TOKEN
export FRIDAY_TELEGRAM_BOT_TOKEN
export FRIDAY_TELEGRAM_OWNER_ID='123456789'
sudo --preserve-env=FRIDAY_TELEGRAM_BOT_TOKEN,FRIDAY_TELEGRAM_OWNER_ID \
  ./deploy/hub/configure-telegram.sh
unset FRIDAY_TELEGRAM_BOT_TOKEN FRIDAY_TELEGRAM_OWNER_ID
```

脚本轮换 Telegram ingest token、配对唯一 sender、将 Bot Token 写入 `gateway.env`（`0600`），再重启 Gateway。轮换或更换 Owner 时重新运行；旧 ingest token 立即失效。

## 6. 纳管轻量 Runner

运行 `fridayctl` 的管理机需要 Node.js `>=22.19.0`：

```sh
npm ci --ignore-scripts
npm run build
```

目标机要求：Linux/systemd、Node.js `>=22.19.0`、`runuser`、`sha256sum`、`tar`、已有服务用户，以及 root 或免交互 `sudo`。Remote Agent 的节点能力目录只需是服务用户可访问的受控现有目录；Codex/Pi/Claude 源码 Workspace 必须是 `/srv/friday-workspaces/` 下的 Git 顶层目录。

```sh
npm run fridayctl -- runner bootstrap node-user@managed-node.example-tailnet.ts.net \
  --hub-url https://friday-hub.example-tailnet.ts.net \
  --runner-name managed-node-01 \
  --service-user node-user \
  --workspace node=/srv/friday-nodes/node \
  --identity-file "$HOME/.ssh/friday_agent" \
  --dry-run
```

确认计划后通过环境变量提供 Owner Token，再去掉 `--dry-run`。Token 不接受命令行参数，不进入 SSH 命令、systemd 环境或节点长期文件；目标机只收到十分钟、一次性的 `0600` enrollment 文件，成功后删除。

Runner 生成逐设备 Ed25519 身份并 pin Hub 公钥。日常心跳、任务领取、事件和制品上传全部从节点主动发起。Runner-only 节点没有 `sandbox` capability，不会被调度执行任务。

### 6.1 原地升级 Runner

```sh
npm run fridayctl -- runner upgrade node-user@managed-node.example-tailnet.ts.net \
  --service-user node-user \
  --identity-file "$HOME/.ssh/friday_agent" \
  --dry-run
```

升级保留设备密钥、Hub pin、Workspace Registry 和私有服务环境。新 release 未保持 active 时，安装器恢复旧 symlink、unit、env 和原 enable/active 状态。旧 release 不自动删除。

## 7. 安装 Agent Sandbox

该步骤需要目标机 Docker，并会联网构建固定 Agent 镜像、运行三个真实 CLI HTTP 合约 fixture、更新 root-owned Sandbox 配置，然后重启 Sandbox/Runner。它属于 R2，必须先审查 dry-run：

```sh
npm run fridayctl -- runner sandbox install node-user@managed-node.example-tailnet.ts.net \
  --hub-url https://friday-hub.example-tailnet.ts.net \
  --service-user node-user \
  --identity-file "$HOME/.ssh/friday_agent" \
  --dry-run
```

固定版本：

- `@openai/codex@0.145.0`
- `@earendil-works/pi-coding-agent@0.84.1`
- `@anthropic-ai/claude-code@2.1.227`

成功结果包含 Sandbox release ID 和 Agent 镜像内容 ID。`friday-sandboxd` 是唯一能调用 Docker 的组件；Runner 没有 Docker socket、Root、SSH Agent 或长期模型 Key。Job 容器使用 `--network none`、非 root、只读根、无 capabilities，只挂载当前 Worktree 和模型 relay socket。旧 diagnostic fixture 已从发布树移除；数据库兼容测试只验证历史记录可审计且绝不再派发。

## 8. 验收

Hub：

```sh
curl -fsS http://127.0.0.1:4310/health
docker compose -f deploy/hub/compose.yml ps
docker compose -f deploy/hub/compose.yml logs --tail=100 hub channel-gateway
```

Runner：

```sh
systemctl is-active friday-runner@node-user.service
systemctl is-active friday-sandboxd.service
journalctl -u friday-runner@node-user.service -n 100 --no-pager
journalctl -u friday-sandboxd.service -n 100 --no-pager
```

端到端至少提交 Codex、Pi、Claude 各一个只读 fixture Job，确认：

- Hub 只签发当前 Job 的短时凭据；
- Runner 上没有长期模型 Key；
- 三种 CLI 到达正确的兼容 Provider 路由；
- Sandbox/Worktree 隔离和制品摘要通过；
- Web 能看到终态、日志摘要和 Diff；
- 由微信 iLink 或 Telegram 发起的任务能在终态后收到回推；短时渠道故障恢复后不会重复执行任务；
- fixture Worktree 保持零非预期改动。

“服务 active”或“adapter enabled”不等于真实 E2E 已验收。

## 9. 备份与回滚

Hub 使用 SQLite WAL。备份必须使用 SQLite 一致性备份，或先停止 Hub 后复制整个 `/var/lib/friday-hub/state`；只复制正在写入的 `friday.sqlite-wal` 不能恢复。升级前保留：

- 一致性状态快照；
- 旧 Hub 镜像 ID；
- 旧 `hub.env` 与 `gateway.env` 的私有备份；
- 当前 Runner/Sandbox release symlink 和镜像内容 ID。

安装器激活失败会自动回滚。激活后人工回滚时，先停止新服务，将 `/opt/friday-agent/current` 或 `/opt/friday-sandboxd/current` 指回保留的旧 release，再恢复旧 env/unit，执行 `systemctl daemon-reload` 并重启。不要删除数据库、设备身份、历史 Job、审计日志或旧镜像来绕过恢复错误。

## 10. M3 与 Self Improvement

MCP、Skill、Procedure 和自补丁 Registry 默认禁用。MCP 只能经独立 Broker Unix socket和精确 HTTPS Origin 白名单；Skill/Procedure 需要 Owner Ed25519 签名和 Sandbox 回放证据。Friday 自身补丁只能来自 `FRIDAY_SELF_WORKSPACE_ID` 并进入 `friday/self/*` 隔离分支。

模型只能提出改进。Runner 测试证据通过后，Hub 才生成绑定 Manifest SHA-256 的 clearance。联网安装、重启和 Canary 为 R2；Policy、凭据、Root、删除和生产切换为 R3。Owner 必须在 Web 中看到背景、收益、风险、回滚和精确动作后授权。当前版本不会自动 Push `main`。
