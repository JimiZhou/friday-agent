# Changelog

All notable changes to Friday Agent are documented here.

## 0.2.1 - 2026-08-12

### Changed

- Remove the obsolete `diagnostic` Job tool and its historical compatibility path. Existing runtime history is intentionally not migrated; deploy a clean runtime database when upgrading.
- Bump the Hub, Gateway, Runner, Sandbox, and protocol release to `0.2.1` so the strict Job contract cannot be mixed with `v0.2.0` components.

## 0.2.0 - 2026-08-12

### Added

- Replace production diagnostic fixtures with a general Remote Agent loop that repeatedly plans, invokes structured node tools, observes real results, and returns an evidence-based conclusion.
- Add Hub-derived per-call R0-R3 policy, exact signed tool authority, durable Web clearance, and independent iLink/Telegram clearance notifications.
- Add restart-safe Agent checkpoints with bounded observation history, monotonic event recovery, non-Git node runtimes, and signed Runner-to-Hub resume reconciliation.

### Security

- Reject expired approval leases without executing the old call; redispatch the Agent under a fresh lease to re-plan.
- The `diagnostic` fixture path is removed from the release; deployments must start from a clean runtime history.
- Remove the obsolete `fixture-app-server` image from the public deployment tree so it cannot be mistaken for a production Agent runtime.
- Deny process environments, credential/private-key paths, and sensitive service configuration from file tools; bound recursive search and redact credential-shaped output.

## 0.1.1 - 2026-08-12

### Fixed

- Persist channel-bound task completion and failure notifications in the Hub, then deliver and acknowledge them through the WeChat iLink or Telegram gateway with restart-safe retries.
- Preserve iLink reply context privately when available while retaining upgrade-safe delivery without historical context, reject non-zero provider `errcode` responses, and make provider retries idempotent without executing a replayed inbound task twice.

## 0.1.0 - 2026-08-12

Initial public release.

### Added

- Single-Owner Hub with password Web sessions, CSRF/Origin protection, SQLite WAL recovery, hash-chain audit events, and R0-R3 policy gates.
- Responsive Web console for chat, managed devices, jobs, artifacts, clearance, WeChat iLink QR pairing, image/video input, and browser talk.
- Telegram Bot and WeChat iLink private-chat gateways with scoped ingest credentials, sender pairing, replay rejection, and provider replies.
- Outbound-only per-device Runner enrollment, deterministic multi-node scheduling, private workspace registry, and isolated Git worktrees.
- Root-owned Sandbox Supervisor with content-pinned Codex, Pi, and Claude Code adapters plus lease-bound short-lived model access.
- `fridayctl` bootstrap, in-place Runner upgrade, Sandbox installation, dry-run plans, host-key pinning, public-key-only SSH, and activation rollback.
- Bounded Pi Conversation Orchestrator, web search, media lifecycle, MCP/Skill/Procedure registries, and Self Improvement evidence/clearance gates.
- Tailscale-first Hub installer, private-HTTPS alternative, Chinese/English READMEs, CI, public-release scanning, and Apache-2.0 licensing.

### Security defaults

- Hub and Gateway control listeners remain loopback-only.
- Tailscale Serve is supported; Funnel is never enabled by the installer.
- SSH password and keyboard-interactive authentication are disabled in `fridayctl`.
- Long-lived model and channel credentials are excluded from Runner state and Git.
- High-risk changes require an authenticated Web clearance bound to an immutable manifest.
