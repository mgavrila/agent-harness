# syntax=docker/dockerfile:1
#
# The Slack approvals app. It also spawns the core-tools MCP server over stdio,
# which is why the whole workspace is installed rather than one package.
#
# Build context is the repository root.
FROM node:26-bookworm-slim

RUN npm install -g pnpm@11.4.0 && npm cache clean --force

WORKDIR /srv/agent-harness
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY harness ./harness
COPY packs ./packs
COPY clients ./clients
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile && chmod -R a+rX /srv/agent-harness

# Runs as the base image's uid-1000 "node" user rather than root.
USER node
CMD ["pnpm", "--filter", "@harness/approvals", "start"]
