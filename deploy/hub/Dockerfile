# Pinned Node base: updates are an explicit, reviewed deployment action.
FROM node:22.22.0-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts \
  && npm run build \
  && npm prune --omit=dev

FROM node:22.22.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# npm workspaces are symlinked from node_modules, so retain the protocol
# package target, fridayd, and the inference-only Pi Worker entrypoint.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/fridayd/dist ./apps/fridayd/dist
COPY --from=build /app/apps/fridayd/package.json ./apps/fridayd/package.json
COPY --from=build /app/apps/pi-worker/dist ./apps/pi-worker/dist
COPY --from=build /app/apps/pi-worker/package.json ./apps/pi-worker/package.json
COPY --from=build /app/apps/channel-gateway/dist ./apps/channel-gateway/dist
COPY --from=build /app/apps/channel-gateway/package.json ./apps/channel-gateway/package.json
COPY --from=build /app/packages/protocol ./packages/protocol

USER 10001:10001
EXPOSE 4310

CMD ["node", "--disable-warning=ExperimentalWarning", "--enable-source-maps", "apps/fridayd/dist/index.js"]
