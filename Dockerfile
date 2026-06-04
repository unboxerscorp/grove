# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.5.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm install --frozen-lockfile && pnpm build

COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/tsconfig.json web/build.mjs web/index.html ./web/
COPY web/src ./web/src
COPY web/mock ./web/mock
RUN cd web && pnpm install --frozen-lockfile && pnpm build

COPY bridge/pyproject.toml ./bridge/
COPY bridge/src ./bridge/src
RUN python3 -m venv /tmp/build-venv \
  && /tmp/build-venv/bin/pip wheel --wheel-dir /wheels ./bridge

FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    python3-venv \
    tini \
    tmux \
  && rm -rf /var/lib/apt/lists/*

ENV GROVE_HOME=/data/grove-home \
  GROVE_VIEWER_SESSION=grove-container \
  GROVE_WEB_HOST=0.0.0.0 \
  GROVE_WEB_PORT=8765 \
  PATH=/opt/grove-venv/bin:$PATH

WORKDIR /opt/grove
RUN corepack enable && corepack prepare pnpm@11.5.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml README.md LICENSE ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts && pnpm store prune

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/web/dist ./web/dist
COPY scripts/snapshot.sh scripts/restore.sh ./scripts/
COPY --from=builder /wheels /wheels

RUN python3 -m venv /opt/grove-venv \
  && /opt/grove-venv/bin/pip install --no-cache-dir --no-index --find-links=/wheels grove-bridge \
  && rm -rf /wheels \
  && chmod +x /opt/grove/dist/cli.js /opt/grove/scripts/snapshot.sh /opt/grove/scripts/restore.sh \
  && ln -s /opt/grove/dist/cli.js /usr/local/bin/grove \
  && mkdir -p /data/grove-home /workspace /snapshots

WORKDIR /workspace
VOLUME ["/data/grove-home", "/workspace", "/snapshots"]
EXPOSE 8765

ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "exec grove-web --host \"$GROVE_WEB_HOST\" --port \"$GROVE_WEB_PORT\" --session \"$GROVE_VIEWER_SESSION\" --dist-dir /opt/grove/web/dist --board-db-path \"$GROVE_HOME/boards/board.db\""]
