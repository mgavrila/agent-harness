# The document pipeline shells out to tesseract and pdftoppm, so the image
# needs them. Keep this in step with the "Document pipeline prerequisites"
# section of README.md.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-eng \
      poppler-utils \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY harness ./harness
COPY identities ./identities
COPY packs ./packs
COPY evals ./evals
RUN pnpm install --frozen-lockfile

# The stdio MCP server, for the MCP inspector and the eval runner on an operator's machine, so
# there is no port. The host embeds core-tools in-process and does not use this image.
WORKDIR /app/harness/core-tools
CMD ["pnpm", "start"]
