# Security Policy

Friday Agent controls private devices and may execute approved code, so security reports are treated as high priority.

## Supported versions

Security fixes are provided for the latest `0.1.x` release and the current default branch. Pre-release branches and older snapshots may receive fixes only when needed to prepare the next release.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: open the **Security** tab, choose **Advisories**, then **Report a vulnerability**. Do not file a public issue for an unpatched vulnerability.

Include:

- affected version or commit;
- the trust boundary that was crossed;
- minimal reproduction steps;
- expected and observed impact;
- any suggested mitigation.

Never include live Owner tokens, model keys, Telegram Bot Tokens, iLink credentials, SSH private keys, real Tailnet names, public IPs, or private repository content. Replace them with synthetic values and rotate anything that may have been exposed.

## Security boundary

The intended release boundary is:

- one self-hosted Owner;
- loopback-only Hub and Gateway control listeners;
- tailnet/private HTTPS access, with no Tailscale Funnel by default;
- browser-native single-Owner Basic Auth, with fixed-Origin and custom-header checks on every Web mutation;
- outbound-only per-device Runner identity;
- public-key or Tailscale SSH onboarding, never password authentication in `fridayctl`;
- root-owned Sandbox supervision and content-pinned Agent images;
- long-lived model credentials on the Hub only;
- explicit R2/R3 clearance for external side effects and privileged actions.

Reports that demonstrate bypass of these controls, cross-workspace access, credential disclosure, signature/lease replay, clearance confusion, or unsafe rollback are in scope.

## Operational incidents

If a production credential may be exposed, rotate or revoke it first, then preserve redacted logs and audit evidence. A Git history rewrite does not revoke a secret. For a compromised Runner, revoke that device at the Hub and do not reuse its private state directory.
