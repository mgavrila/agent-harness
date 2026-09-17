# syntax=docker/dockerfile:1
#
# The host: the runtime, the surfaces and the identity plug-in it loads, with core-tools hosted
# in-process. The whole workspace is installed because the plug-ins are workspace packages.
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
# `@harness/host` declares as a workspace dependency, and the build fails
# here rather than the container failing at startup.
COPY surfaces ./surfaces
# The runtime plug-in `HARNESS_RUNTIME` names, a workspace dependency of @harness/host.
COPY runtimes ./runtimes
COPY clients ./clients
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile && chmod -R a+rX /srv/agent-harness

# The storage volume's layout. Docker seeds a fresh named volume from the image's directory at the
# mount path, ownership included, so the first container to mount `storage` leaves `incoming/` and
# `out/` owned by the uid the host runs as. The image seeds the layout and its ownership; no
# init container is needed.
RUN mkdir -p /srv/harness-storage/incoming /srv/harness-storage/out && chown -R node:node /srv/harness-storage

# Runs as the base image's uid-1000 "node" user rather than root.
USER node
CMD ["pnpm", "--filter", "@harness/host", "start"]
