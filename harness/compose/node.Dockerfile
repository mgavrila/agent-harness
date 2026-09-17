# syntax=docker/dockerfile:1
#
# The approvals host and its messaging adapters. It also spawns the core-tools
# MCP server over stdio, which is why the whole workspace is installed rather
# than one package.
#
# Build context is the repository root.
FROM node:26-bookworm-slim

RUN npm install -g pnpm@11.4.0 && npm cache clean --force

WORKDIR /srv/agent-harness
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY harness ./harness
# The identity plug-in HARNESS_IDENTITY names, a workspace dependency of @harness/core-tools.
COPY identities ./identities
COPY packs ./packs
# The adapters `HARNESS_SURFACES` names. Without them `pnpm install
# --frozen-lockfile` below cannot resolve `@harness/surface-slack`, which
# `@harness/approvals` declares as a workspace dependency, and the build fails
# here rather than the container failing at startup.
COPY surfaces ./surfaces
COPY clients ./clients
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile && chmod -R a+rX /srv/agent-harness

# Runs as the base image's uid-1000 "node" user rather than root.
USER node
CMD ["pnpm", "--filter", "@harness/approvals", "start"]
