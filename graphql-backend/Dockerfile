# Creador v2 · graphql-backend (Yoga + Pothos + pg).
FROM node:22-bookworm-slim
WORKDIR /srv/graphql
ENV PYTHON=python3
# Conectores: python+pandas (csv/xlsx), unixODBC + toolchain (odbc nativo),
# git. Tedious/mysql2 son JS puro.
RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-pip curl ca-certificates unixodbc unixodbc-dev g++ make python3-dev && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir --break-system-packages pandas openpyxl
# Uploads de CSV/XLSX (ingest). Volumen en compose.
RUN mkdir -p /srv/uploads
ENV UPLOADS_DIR=/srv/uploads
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.1.2 && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc -p tsconfig.json && pnpm prune --prod && rm -rf /root/.npm /root/.local/share/pnpm
EXPOSE 4001
ENV PORT=4001 NODE_ENV=production
CMD ["node", "dist/server.js"]
