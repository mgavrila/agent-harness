# syntax=docker/dockerfile:1
#
# The files worker: untrusted document parsing with pdftotext, pdftoppm and tesseract, in a
# process that holds no key, no database URL and no provider credential, on a Compose network
# that routes nowhere. Only the two packages the worker needs are copied; pnpm's frozen install
# accepts a workspace copy that omits the rest. Build context is the repository root.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-eng \
      poppler-utils \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.4.0 && npm cache clean --force

WORKDIR /srv/agent-harness
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY harness/shared ./harness/shared
COPY harness/files ./harness/files
RUN pnpm install --frozen-lockfile && chmod -R a+rX /srv/agent-harness

# The base image's uid-1000 "node" user, which is the storage volume's owner (HERMES_UID=1000).
USER node
CMD ["pnpm", "--filter", "@harness/files", "start"]
