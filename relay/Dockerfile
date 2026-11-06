# Build from the repo root: the relay reuses the owner page's checks.
FROM node:22.18.0-slim
ENV NODE_ENV=production
WORKDIR /app
COPY relay/package.json relay/package-lock.json relay/
RUN cd relay && npm ci --include=dev --legacy-peer-deps
COPY relay/src relay/src
COPY relay/tsconfig.json relay/tsconfig.json
COPY owner-page/package.json owner-page/package.json
COPY owner-page/src/approval.ts owner-page/src/approval.ts
COPY owner-page/src/approval-v2.ts owner-page/src/approval-v2.ts
# approval.ts imports viem, resolved from the parent directory.
RUN ln -s /app/relay/node_modules /app/node_modules
WORKDIR /app/relay
# Fly mounts the state volume as root at start, so ownership is fixed then, before dropping to node.
CMD ["sh", "-c", "chown -R node:node /data && exec su node -s /bin/sh -c 'exec npx tsx src/main.ts'"]
