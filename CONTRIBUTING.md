# Contributing to Friday Agent

Friday Agent sits on a sensitive boundary: it accepts untrusted model and channel input, then may operate private devices. Changes should preserve fail-closed behavior, single-Owner identity, explicit clearance, and rollback evidence.

## Before opening a pull request

```sh
nvm use
npm ci --ignore-scripts
npm run release:check
```

Please keep changes focused, explain the affected trust boundary, and add negative tests for rejected input as well as positive tests. Never include real hosts, Tailnet names, IPs, user names, model credentials, channel tokens, SSH keys, private prompts, or production logs.

For Runner, Sandbox, policy, credential, or deployment changes, include:

- the capability being added or changed;
- why the existing boundary is insufficient;
- the expected risk level;
- rollback behavior;
- evidence that failure remains closed.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.
