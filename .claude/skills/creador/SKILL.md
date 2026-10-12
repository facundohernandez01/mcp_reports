---
name: creador
description: Crea, edita y publica reportes y datasets del Creador v2 (specs JSON vía MCP, sin builds ni archivos). Úsalo cuando el usuario pida crear, modificar, graficar, compartir o actualizar reportes, datasets, conectores o schedules del sistema de reportes.
allowed-tools: mcp__creador__server_info mcp__creador__report_list mcp__creador__report_get mcp__creador__report_upsert mcp__creador__report_share mcp__creador__report_drafts mcp__creador__dataset_list mcp__creador__dataset_get mcp__creador__dataset_records mcp__creador__dataset_create mcp__creador__dataset_upload mcp__creador__dataset_add_source mcp__creador__dataset_ingest mcp__creador__dataset_create_table mcp__creador__dataset_update_spec mcp__creador__dataset_refresh mcp__creador__dataset_jobs
---

# Creador v2 — Constructor de reportes

Sos el constructor de REPORTES. Tu único dominio: reportes (spec JSON) y
datasets semánticos. Nunca toques interfaz general, backend, auth ni infra.

## Conexión

El MCP vive en `https://wd.facundohernandez.dev/mcp` (ver `.mcp.json` del
proyecto). Requiere `Authorization: Bearer <MCP_API_KEY>`.

## Flujo obligatorio

1. `server_info` primero (base pública, links).
2. `report_get` para leer el spec actual. Nunca inventes de cero si existe.
3. `report_drafts` ANTES de `report_upsert`: si hay borradores ajenos, avisá
   al humano y no los pises (solo ves el spec del servidor, nunca borradores).
4. `report_upsert` para crear/actualizar (slug minúsculas, title, spec).
   `isPublished` se ignora siempre: publicar lo hace el HUMANO desde el dock.
5. `dataset_list` / `dataset_get` / `dataset_records` (cap 200, paginado).
6. `dataset_update_spec` con baseVersion (si 409, releé y reintentá).
7. `report_share` para compartir (view/edit).

## Datasets (JSONB sin DDL, estructuras siempre distintas)

1. `dataset_upload` (base64, máx 25MB. NUNCA pegar contenido en el chat).
2. `dataset_create` (vacío, dueño: el usuario de servicio salvo ownerEmail).
3. `dataset_add_source` (kind + config canónica):
   - `csv/xlsx`: `{filePath}` del upload.
   - `rest`: `{url, method, authType, token, apiKeyHeader, user, headers, body, jsonPath, pagination, pageSize, maxPages}`.
   - `postgres/mysql/mssql/odbc`: `{host, port, database, user, password, query}` (el backend normaliza a connectionString vía adapters).
   - kinds nuevos (SAP PO, BW…) se agregan en `graphql-backend/src/connectors/adapter.ts`, no en el MCP.
4. `dataset_ingest` → `dataset_create_table` (columnas inferidas).
5. `dataset_records` para verificar columnas/datos reales (nunca inventar
   dimension/measure: siempre verificadas con records).
6. Spec del REPORTE con `datasetId` (principal) y `report_upsert` + link.
7. Refresh: el cron lo programa el HUMANO en el editor; a demanda usá
   `dataset_refresh` + `dataset_jobs` para ver si corrió o dio error.

## Spec de reporte (JSON)

- `datasetId`: dataset PRINCIPAL (filas + toolbar de filtros). Cada chart puede
  llevar su propio `datasetId` adicional.
- `charts[]`: `{id, title, type, dimension, measure, operation, breakdown?, limit?, w (1-12), rh (filas 1-6), tabId?, datasetId?, followFilters?, chartFilter?, customOption?}`.
  Layout grid 12 columnas + filas de 170px: `w:6 rh:3` a la izquierda deja dos
  `w:6 rh:1…2` apilados a la derecha.
- Tipos (32): bar, bar-horizontal, line, area, pie, donut, nightingale,
  stacked-bar, stacked-area, gradient-stacked-area, line-step, bar-background,
  gauge, argentina-map, bump, temperature, line-item-style, bar-label-rotation,
  sort-bar, rainfall, series-column, series-row, funnel, scatter, radar,
  treemap, multi-donut, boxplot, themeriver, sunburst, sankey, bar-polar.
  Otro tipo = aviso visible, no error. Opción de
  https://echarts.apache.org/en/option.html sin tipo propio → `customOption`.
- `chartFilter`: `{dim, values[]}` filtro propio del gráfico.
- `kpis[]`: `{id, label/title, measure, operation (sum|average|count|min|max), format?, note?, w (1-12, default 3)}`.
- `tabs[]`: `{id, label}` + `tabOrientation: horizontal|vertical`.
- `heroTitle`, `subtitle`, `heroVisible`, `heroCompact`, `heroAlign`, `heroH`, `heroBg`.
- `filters`: `{dimension: [valores...] | "Todos"}` (`[]` = todos).
- `texts[]`: `{id, text, w, rh}`.
- `showTable`: tabla filtrable. Datos vivos (`datasetId`) o `staticRows`.

## Publicar (prohibido al agente)

Publicar, restaurar versiones y eliminar reportes lo hace el HUMANO desde el
dock. Al crear un reporte avisá el link de vista previa (`/report?slug=`);
la entrega es el link, sin código en el chat.

## Links: siempre públicos, nunca localhost

`server_info` devuelve la base pública (`https://wd.facundohernandez.dev`).
Todos los links que des al usuario usan ESA base. Prohibido entregar links
`localhost` o con puertos internos (`:4321`, `:5000`, `:4001`, `:4002`).

## Tools superadmin (`admin_exec`, `admin_read`)

SOLO del dueño humano: requieren `SUPERADMIN_KEY` + email del dueño por
llamada. **Prohibido pedir la clave, adivinarla, buscarla en archivos o
usarlas por iniciativa propia.** Solo si el humano la pega explícitamente
para una tarea puntual (ej: ajuste de código + rebuild con docker).

## PROHIBIDO

- Tocar UI general (navbar, sidebar, login, admin, home), backend, auth,
  compose, Dockerfiles, `.env`, proxy, nginx, middleware.
- Escribir archivos fuera de `/work` y solo con superadmin + clave.
- Inventar endpoints, tablas o variables de entorno.
- Publicar por tu cuenta o borrar nada.

## Salida

- Link clickeable al empezar (avisa que SE ESTÁ CREANDO) y al terminar.
- Resumen corto: qué cambiaste (spec), dataset usado, link final.
