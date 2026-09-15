# syntax=docker/dockerfile:1
#
# Hermes Agent plus the harness code it runs as an MCP child.
#
# The official image is used unchanged as the base. Two things are added and
# nothing is modified: pnpm, because the image deliberately ships only npm
# ("No corepack: Node unbundled it upstream ... no build step shells out to
# yarn or pnpm" — upstream Dockerfile), and the repository, because the
# core-tools MCP server is a workspace package that Hermes spawns over stdio
# and there is no `cwd` key on an MCP server entry.
#
# Build context is the repository root.
ARG HERMES_TAG=v2026.9.14
FROM nousresearch/hermes-agent:${HERMES_TAG}

USER root
RUN npm install -g pnpm@11.4.0 && npm cache clean --force

# Baked in, so `pnpm install` never runs at container start and the native
# builds match this image's platform. packs/ and clients/ are bind-mounted over
# these copies at run time, so skills and config are editable without a rebuild.
WORKDIR /srv/agent-harness
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY harness ./harness
COPY packs ./packs
COPY clients ./clients
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile && chmod -R a+rX /srv/agent-harness

# Hand the image back exactly as it was: /init stays PID 1 through the
# unmodified ENTRYPOINT, and the working directory is the one it expects.
WORKDIR /opt/hermes
