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

# The base image's own default user is already root, so this restates it
# rather than escalating, and there is nothing to restore afterwards. Root at
# image level is required, not a leftover: the s6-overlay entrypoint does the
# UID remap, the data-volume chown and the config seeding as root, and
# main-wrapper.sh then drops to the `hermes` user with `s6-setuidgid` before it
# execs the command. Pinning a USER here (or `docker run --user`) skips that
# bootstrap, and both entrypoint-dispatch.sh and stage2-hook.sh refuse to start
# on an arbitrary non-root uid.
USER root
RUN npm install -g pnpm@11.4.0 && npm cache clean --force

# Baked in, so `pnpm install` never runs at container start and the native
# builds match this image's platform. packs/ and clients/ are bind-mounted over
# these copies at run time, so skills and config are editable without a rebuild.
WORKDIR /srv/agent-harness
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY harness ./harness
# The identity plug-in HARNESS_IDENTITY names, a workspace dependency of @harness/core-tools.
COPY identities ./identities
COPY packs ./packs
COPY clients ./clients
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile && chmod -R a+rX /srv/agent-harness

# Hand the image back exactly as it was: the ENTRYPOINT is unmodified, /init
# stays PID 1 through it, and the working directory is the one it expects. The
# image-level user is root because that is what the base image declares and
# what the entrypoint needs; the process that actually runs `gateway run` is
# the `hermes` user, remapped to HERMES_UID/HERMES_GID (1000 in compose, 10000
# unset). Verified through the real entrypoint:
#
#   $ docker run --rm -e HERMES_UID=1000 -e HERMES_GID=1000 harness-hermes sh -c id
#   uid=1000(hermes) gid=1000(hermes) groups=1000(hermes)
WORKDIR /opt/hermes
