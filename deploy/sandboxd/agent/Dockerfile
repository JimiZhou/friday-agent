FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ENV NODE_ENV=production \
    PATH=/opt/friday-agent/node_modules/.bin:/usr/local/bin:/usr/bin:/bin

WORKDIR /opt/friday-agent
COPY agent/package.json agent/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && test "$(codex --version)" = "codex-cli 0.145.0" \
    && pi --version | grep -Eq '(^|[^0-9])0\.84\.1([^0-9]|$)' \
    && claude --version | grep -Eq '(^|[^0-9])2\.1\.227([^0-9]|$)'

COPY apps/sandboxd/dist/agent-wrapper.js /usr/local/lib/friday-agent/agent-wrapper.js
COPY agent/verify-agent-contracts.mjs /usr/local/lib/friday-agent/verify-agent-contracts.mjs
RUN chmod 0555 /usr/local/lib/friday-agent/agent-wrapper.js \
    /usr/local/lib/friday-agent/verify-agent-contracts.mjs \
    && ln -s /usr/local/lib/friday-agent/agent-wrapper.js /usr/local/bin/friday-agent-wrapper \
    && mkdir -p /workspace \
    && chown 65532:65532 /workspace

USER 65532:65532
WORKDIR /workspace
RUN node /usr/local/lib/friday-agent/verify-agent-contracts.mjs
ENTRYPOINT ["friday-agent-wrapper"]
