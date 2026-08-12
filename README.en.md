# Friday Agent

English | [中文](README.md)

Friday Agent is a single-owner, self-hosted steward for private devices. You talk to it through the Web UI, WeChat iLink, or Telegram. The Hub owns identity, policy, audit, and scheduling; lightweight Runners execute approved jobs on managed nodes. Models never receive general SSH, root, the Docker socket, or long-lived provider credentials.

> Current release: `v0.2.1`, intended for early adopters who are comfortable self-hosting and reviewing security boundaries. The first release exposes only the Web UI, WeChat iLink, and Telegram Bot as user-facing channels.

## What it does

- Provides a Web console for chat, devices, jobs, diffs, artifacts, and clearance requests.
- Accepts text, images, and short videos, plus continuous browser speech recognition, read-aloud replies, and barge-in where supported.
- Sends and receives paired private chats through WeChat iLink and one-owner Telegram Bots. When a remote task completes, fails, or is cancelled, the Gateway durably retries delivery of its terminal state and bounded result summary.
- Selects an enrolled, online, capability-matched node. The general Remote Agent gets a per-Job runtime directory, while Codex, Pi, and Claude Code get isolated Git worktrees; both enter a no-network sandbox.
- Exposes bounded web search to the Hub. MCP, Skills, and Procedures remain disabled until their source, version, capabilities, and replay evidence are approved.
- Allows an external model to propose Pi upgrades and architecture changes, but only as isolated patches with test evidence. Networked installs, restarts, deployments, credentials, root access, and deletion require an R2/R3 clearance that explains context, risk, and rollback.

## Trust model

- **One Owner:** this is not a multi-tenant service or group-chat bot.
- **The Hub is the control root:** it stores policy, approvals, device identity, conversations, and audit state, and listens only on `127.0.0.1:4310`.
- **Runners are outbound-only:** SSH is used only for initial installation and upgrades; Friday opens no management port on a node.
- **Execution is sandboxed:** a worktree alone is not a sandbox. Real tools enter a content-pinned container through root-owned `friday-sandboxd`.
- **General agent capability:** the Remote Agent plans with reusable system, process, service, journal, network, and bounded file tools. The Hub classifies and signs every call instead of hard-coding diagnostic scenarios.
- **Credentials stay on the Hub:** a Runner receives a short-lived model token bound to the current signed job, never the long-lived provider key.
- **Failure is closed:** incomplete configuration, offline devices, mismatched capabilities, expired leases, invalid signatures, and missing clearance all stop execution.

## Recommended deployment: Tailscale

Join the Hub and managed nodes to one tailnet. The Hub stays on loopback while Tailscale Serve provides tailnet-only HTTPS. Runners connect outbound to that URL. Friday never enables Funnel and does not require public access to port `4310`, Runner RPC, or the sandbox socket.

The Hub needs Linux, Docker Engine, Docker Compose v2, OpenSSL, curl, and a connected Tailscale client:

```sh
git clone https://github.com/JimiZhou/friday-agent.git
cd friday-agent
sudo ./deploy/hub/install-hub.sh \
  --origin https://friday-hub.example-tailnet.ts.net \
  --network tailscale
```

The installer creates a low-privilege service account and private state, generates scoped credentials, starts the loopback Hub and Channel Gateway, configures Tailscale Serve without Funnel, and prints the Web URL plus one-time Owner credentials. Open the Web console to bind WeChat iLink by QR code.

### Telegram

Get a Bot Token from `@BotFather` and your numeric Telegram user ID. Keep the token out of shell history:

```sh
read -r -s FRIDAY_TELEGRAM_BOT_TOKEN
export FRIDAY_TELEGRAM_BOT_TOKEN
export FRIDAY_TELEGRAM_OWNER_ID='123456789'
sudo --preserve-env=FRIDAY_TELEGRAM_BOT_TOKEN,FRIDAY_TELEGRAM_OWNER_ID \
  ./deploy/hub/configure-telegram.sh
unset FRIDAY_TELEGRAM_BOT_TOKEN FRIDAY_TELEGRAM_OWNER_ID
```

The Gateway accepts only that Owner's private chat and rejects groups, all other senders, and replays.

## Enroll a managed node

The machine running `fridayctl` needs Node.js `>=22.19.0`. A target node needs Linux/systemd, Node.js `>=22.19.0`, an existing service user, and root or non-interactive `sudo`.

```sh
npm ci --ignore-scripts
npm run build

npm run fridayctl -- runner bootstrap node-user@managed-node.example-tailnet.ts.net \
  --hub-url https://friday-hub.example-tailnet.ts.net \
  --runner-name managed-node-01 \
  --service-user node-user \
  --workspace node=/srv/friday-nodes/node \
  --identity-file "$HOME/.ssh/friday_agent" \
  --dry-run
```

After reviewing the plan, export `FRIDAY_OWNER_TOKEN` and rerun without `--dry-run`. The token is never accepted as a command-line value. A Runner-only node reports status but cannot execute jobs.

To run Codex, Pi, or Claude Code, the target also needs Docker. The following R2 operation performs a networked, pinned Agent image build and restarts managed services; always review the dry-run first:

```sh
npm run fridayctl -- runner sandbox install node-user@managed-node.example-tailnet.ts.net \
  --hub-url https://friday-hub.example-tailnet.ts.net \
  --service-user node-user \
  --identity-file "$HOME/.ssh/friday_agent" \
  --dry-run
```

The image pins and validates `@openai/codex@0.145.0`, `@earendil-works/pi-coding-agent@0.84.1`, and `@anthropic-ai/claude-code@2.1.227`. Activation rolls back on failure. `fridayctl runner upgrade` preserves the existing device identity, Hub pin, and workspace registry.

`node` is a local capability label for that managed node; its path only needs to be an existing controlled directory and does not need Git. Source workspaces sent to Codex, Pi, or Claude must still be Git repository roots. The Remote Agent plans with reusable structured tools, cannot claim completion before receiving a real node observation, and can treat an individual tool failure as evidence before re-planning. An R1-R3 call durably checkpoints the bounded observation history, notifies iLink/Telegram, and waits for exact Web clearance. If the lease expires first, Friday never executes the old call and instead asks the Agent to re-plan under a fresh lease.

## Without Tailscale

This is supported with stricter prerequisites:

- Keep the Hub on `127.0.0.1:4310` behind an existing private HTTPS reverse proxy. Do not map Friday's port directly to the public Internet.
- Browsers and every Runner must reach the same valid HTTPS `FRIDAY_PUBLIC_ORIGIN`.
- Provision SSH public keys and `known_hosts` before onboarding. `fridayctl` forces `BatchMode=yes`, `PasswordAuthentication=no`, and `KbdInteractiveAuthentication=no`; username/password SSH is unsupported.

```sh
sudo ./deploy/hub/install-hub.sh \
  --origin https://friday.internal.example \
  --network private-https
```

Install SSH keys through your cloud console, image initialization, or another trusted admin path. If a password is unavoidable for the one-time `ssh-copy-id`, disable server-side password login afterwards. Friday Agent never stores or enters SSH passwords.

## Models and tools

The Hub fails closed until model settings are complete. See [`deploy/hub/hub.env.example`](deploy/hub/hub.env.example) for Conversation Pi, Runner OpenAI-compatible Codex/Pi, Runner Anthropic-compatible Claude, and private STT/TTS settings. Long-lived keys belong only in the Hub's root-owned mode-`0600` `deploy/hub/hub.env`, never in Git or on a Runner.

## Development

```sh
nvm use
npm ci --ignore-scripts
npm test
npm audit --audit-level=moderate
git diff --check
```

More detail:

- [Deployment and rollback](deploy/README.md)
- [Architecture and trust boundaries](docs/architecture.md)
- [M3 operating boundaries](docs/m3-operations.md)
- [Security policy](SECURITY.md)

## Status and license

The validated core covers Web/iLink/Telegram message boundaries, multi-Runner scheduling, image/video input, browser talk, a general Remote Agent with per-call Node Tool policy, sandbox HTTP contracts for pinned Codex/Pi/Claude CLIs, a multi-step loop with real node tools, short-lived credential proxying, and Self Improvement test evidence with R2/R3 clearance and canary gates. Public tests use a controlled model fixture; every production deployment must still complete a read-only Remote Agent E2E with its own provider.

`v0.2.1` does not promise macOS/Windows installers, self-hosted WebRTC audio, an open plugin marketplace, multi-tenancy, unattended production changes, or autonomous root administration. Self Improvement never pushes `main` automatically.

Licensed under the [Apache License 2.0](LICENSE). Friday Agent is not affiliated with or endorsed by WeChat, Telegram, OpenAI, Anthropic, or the Pi project; external services remain subject to their own terms.
