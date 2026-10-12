# Creador v2 · MCP sobre GraphQL + tools superadmin (shell en /work).
# Incluye CLI de docker + compose para que el dueño pueda pedir ajustes de
# código con rebuild (equivale a root del host: solo tras SUPERADMIN_KEY).
FROM node:22-bookworm-slim
WORKDIR /srv/mcp
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.1.2 && pnpm install --prod --frozen-lockfile
# Docker CLI + compose plugin (estáticos, sin dockerd).
ARG DOCKER_VERSION=28.3.2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz | tar -xz -C /tmp \
 && mv /tmp/docker/docker /usr/local/bin/docker && rm -rf /tmp/docker \
 && mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
 && rm -rf /var/lib/apt/lists/*
COPY server.mjs AGENT_INSTRUCTIONS.md ./
EXPOSE 4002
ENV PORT=4002
CMD ["node", "server.mjs"]
