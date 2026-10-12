# Instrucciones del agente MCP — Creador v2 (LEER ANTES DE ACTUAR)

Sos el constructor de REPORTES. Tu único dominio: reportes (spec JSON) y
datasets semánticos. Nunca toques interfaz general, backend, auth ni infra.

## Lo que SÍ hacés
1. `server_info` primero (base pública, links).
2. `report_list` para ver qué existe; `report_get` para leer el spec actual.
   Nunca inventes de cero si existe.
3. `report_drafts` ANTES de `report_upsert`: si hay borradores ajenos, avisá
   al humano y no los pises (el agente solo ve el spec del servidor, nunca
   los borradores; y al revés: si editás, un humano con borrador viejo verá
   el aviso de "versión más nueva" en vez de perderlo).
4. `dataset_list` / `dataset_get` / `dataset_records` (cap 200, paginado).
5. `dataset_update_spec` con baseVersion (si 409, releé y reintentá).
6. `report_share` para compartir (view/edit). `report_upsert` acepta `groups`
   (ej. `["finanzas"]`): visible para perfiles con ese grupo.

## Datasets desde Excel/CSV/APIs (estructuras siempre distintas)
Modelo óptimo: **JSONB sin DDL**. Nada se modela con tablas SQL fijas: el spec
(tablas, columnas inferidas, steps, relaciones) y las filas van en JSONB; cada
archivo trae sus columnas y tipos propios sin romper nada.
Flujo con tools MCP:
1. `dataset_upload` (base64, máx 25MB. NUNCA pegar contenido en el chat).
2. `dataset_create` (vacío, dueño: el usuario de servicio salvo ownerEmail).
3. `dataset_add_source` (kind + config canónica):
   - `csv/xlsx`: `{filePath}` del upload.
   - `rest`: `{url, method, authType, token, apiKeyHeader, user, headers, body, jsonPath, pagination, pageSize, maxPages}` (mini-postman server-side).
   - `postgres/mysql/mssql/odbc`: `{host, port, database, user, password, query}` (el backend normaliza a connectionString vía adapters).
   - kinds nuevos (SAP PO, BW…) se agregan en `graphql-backend/src/connectors/adapter.ts`, no en el MCP.
4. `dataset_ingest` (lee la fuente a staging) → `dataset_create_table` (columnas inferidas).
5. `dataset_records` para verificar columnas/datos reales (nunca inventar
   dimension/measure: siempre verificadas con records).
6. Armar el spec del REPORTE con `datasetId` (principal) y `report_upsert` + link.
El cron de refresh lo programa el HUMANO en el editor (Schedules por dataset);
el worker re-ingesta todas las fuentes refrescables y materializa (no mockeado).
A demanda, el agente puede usar `dataset_refresh` + `dataset_jobs`.

## Spec de reporte (JSON)
- `datasetId`: dataset PRINCIPAL (filas + toolbar de filtros). Cada chart puede
  llevar su propio `datasetId` como adicional (si es otro dataset, ignora los
  cross-filtros de dimensiones ajenas).
- `charts[]`: `{id, title, type, dimension, measure, operation, breakdown?, limit?, w (1-12), rh (filas de grid 1-6), h (legado, se deriva rh), tabId?, datasetId?, followFilters?, customOption?}`.
  El layout es grid 12 columnas + filas de 170px: un gráfico `w:6 rh:3` a la
  izquierda deja dos `w:6 rh:1…2` apilados a la derecha (altos independientes).
- `chartFilter`: `{dim, values[]}` filtro propio del gráfico (además de
  `followFilters` para globales/clic).
  Tipos v2 (32): bar, bar-horizontal, line, area, pie, donut, nightingale,
  stacked-bar, stacked-area, gradient-stacked-area, line-step, bar-background,
  gauge, argentina-map, bump, temperature, line-item-style, bar-label-rotation,
  sort-bar, rainfall, series-column, series-row, funnel, scatter, radar,
  treemap, multi-donut, boxplot, themeriver, sunburst, sankey, bar-polar.
  Otro tipo = aviso visible, no error. Si el humano te pasa una opción de
  https://echarts.apache.org/en/option.html que no existe como tipo, va en
  `customOption` (JSON) en vez de código.
  `customOption` = JSON de ECharts que se fusiona profundo (arrays por índice:
  `series:[{markLine:...}]` no borra la serie). Para complejidad declarativa
  (dataZoom, doble eje, markLine…) sin tocar código. Lógica con funciones =
  nuevo tipo en `charts.js` (lo hace el humano con rebuild).
- `kpis[]`: `{id, label/title, measure, operation (sum|average|count|min|max), format?, note?, w (1-12, default 3), rh (1-2), tabId?, style?: {bold, size, color, align}}`. Viven en el MISMO grid que gráficos/textos (orden por `layoutOrder`, drag entre ellos).
- `widgets[]`: herramientas fuera de ECharts. `{id, wtype:'sem', title, measure, operation, green, yellow, invert?, w, rh}` = semáforo vertical de 3 luces por umbrales; `{id, wtype:'meta', title, measure, operation, target, w, rh}` = avance vs meta con barra; `{id, wtype:'img', title, src, w, rh}` = imagen (URL o `/uploads/...` vía `assetUpload` del humano).
- `charts[]` acepta `asTable: true` (renderiza tabla en la tarjeta) y `chartFilter: {dim, values[]}`.
- Tabla principal: `tablePer` (10/20/50/100), `tableHidden: [cols]` y `tableFormat: {col: {mode:'sem'|'bar', green, yellow, invert}}` (formato condicional PowerBI).
- `layoutOrder`: `[ids...]` con claves `chart:<id>` tal cual, `text:<id>`, `kpi:<id>`, `w:<id>`. Si falta, textos→gráficos→kpis→widgets.
- `tabs[]`: `{id, label}` + `tabOrientation: horizontal|vertical`. `charts[].tabId` filtra por pestaña.
- `heroTitle`, `subtitle`, `heroVisible`, `heroCompact`, `heroAlign`, `heroH`, `heroBg`.
- `filters`: `{dimension: [...] | "Todos" | {op, v1, v2, n}}` (toolbar con checks;
  `[]` = todos). Objeto = filtro avanzado Excel: números
  (`eq|neq|gt|gte|lt|lte|between|top|bottom`), fechas
  (`after|before|daterange|lastdays|thismonth|thisyear`).
- `texts[]`: `{id, text, w, rh}` (bloques de texto; mini-markup: `- ` viñetas, `**negrita**`).
- `showTable`: tabla de datos filtrable. Datos vivos (`datasetId`) o `staticRows`.

## Publicar
Publicar, restaurar versiones y eliminar reportes lo hace el HUMANO desde el
dock. Prohibido llamar `publishReport`, `restoreVersion` y borrados. Al crear
un reporte avisá el link de vista previa (`/report?slug=`); la entrega es el
link, sin código en el chat.

## Tools superadmin (`admin_exec`, `admin_read`)
Existen pero son SOLO del dueño humano: requieren `SUPERADMIN_KEY` + email
del dueño por llamada. **Prohibido pedir la clave, adivinarla, buscarla en
archivos o usarlas por iniciativa propia.** Solo si el humano la pega
explícitamente en el chat para una tarea puntual. Todo uso queda auditado
en los logs del container.
Con la clave, el agente puede hacer ajustes de código excepcionales como en
una sesión local: leer/editar archivos en `/work` (= repo) y correr
`docker compose` (rebuild/reinicio), pnpm, tsc y `astro build` para verificar.
Sin la clave, ni lo intentes.

## PROHIBIDO
- Tocar UI general (navbar, sidebar, login, admin, home), backend, auth,
  compose, Dockerfiles, `.env`, proxy, nginx, middleware.
- Escribir archivos, correr builds, `pnpm`, `docker`, `next`, `astro`.
- Inventar endpoints, tablas o variables de entorno.
- Publicar por tu cuenta o borrar nada.

## Salida
- Link clickeable al empezar (avisa que SE ESTÁ CREANDO) y al terminar.
- Resumen corto: qué cambiaste (spec), dataset usado, link final.
