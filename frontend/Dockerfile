# Creador v2 · frontend estático (Astro build → nginx). Cero Node por usuario:
# el browser baja HTML/JS fijos y habla GraphQL por mismo origen.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY astro-frontend/package.json astro-frontend/pnpm-lock.yaml astro-frontend/pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.1.2 && pnpm install --frozen-lockfile
COPY astro-frontend/ ./
ARG PUBLIC_GRAPHQL_URL=/graphql
ARG PUBLIC_MSAL_ENABLED=ON
ARG PUBLIC_AZURE_CLIENT_ID=""
ARG PUBLIC_AZURE_TENANT_ID=""
ENV PUBLIC_GRAPHQL_URL=$PUBLIC_GRAPHQL_URL \
    PUBLIC_MSAL_ENABLED=$PUBLIC_MSAL_ENABLED \
    PUBLIC_AZURE_CLIENT_ID=$PUBLIC_AZURE_CLIENT_ID \
    PUBLIC_AZURE_TENANT_ID=$PUBLIC_AZURE_TENANT_ID
RUN pnpm run build

FROM nginx:alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
