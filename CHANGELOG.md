# Changelog

All notable changes to Friday Agent are documented here.

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
