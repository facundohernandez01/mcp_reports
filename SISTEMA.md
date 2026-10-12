# Creador de Reportes v2 — Detalles técnicos

Stack: `astro-frontend` (Astro + React, `:4321` dev / nginx `:80` prod) →
`graphql-backend` (Yoga + Pothos + pg, `:4001/graphql`) → 2 Postgres:
`creador_db` (reportes, drafts, versiones, locks, jobs) y `crud_db` legacy
(datasets, staging, materializadas). MCP (`:4002/mcp`) habla GraphQL con
usuario de servicio. Ver `mcp/AGENT_INSTRUCTIONS.md` (prompt del agente).

## Reportes = JSON, sin builds
El renderer (`ReportView.jsx` + `lib/charts.js`, ECharts por CDN) pinta el
**spec**; no hay compilación por reporte ni efímeros. Spec:
`datasetId` principal + `charts[]` (cada uno puede llevar su propio
`datasetId` adicional) + `kpis[]` (`w` 1-12) + `texts[]` (`w`) +
`tabs[]` (`tabOrientation` horizontal|vertical) + `filters` + `hero*` +
`showTable`. `staticRows` = filas fijas (sin dataset).
Filas del dataset principal se recargan al cambiar `datasetId` en caliente;
al elegir dataset se siembran filtros de texto si no había.

## Publicar = encolar + congelar (multi-usuario OK)
`publishReport` encola en `publish_jobs`; el worker (`SKIP LOCKED`, 1 por vez,
+ intervalo 15s) congela `reports.spec` en `report_versions` y marca
`is_published`. Varios usuarios pueden encolar: se serían solos.
El dock persiste el working (`upsertReport` + `saveDraft`) ANTES de encolar,
si no publicaría la versión vieja. Monitor admin: `/admin/spool`.
Restaurar = `restoreVersion` (pisa spec, no borra historial).

## Locks de edición
Un editor por reporte: `acquireLock` al entrar a `?edit=1`, `heartbeatLock`
cada 60s, `releaseLock` al salir (stale >15min se puede tomar). Si otro lo
tiene, el botón Editar avisa y entrás en solo lectura (banner). Publicar
requiere owner/admin (el lock no bloquea publicar a otro owner/admin).

## Permisos
- Reportes: `report_shares` view|edit (owner/admin otorgan, revocan con
  `reportUnshare`, listan con `reportShares`). Compartir reporte NO da
  dataset.
- Perfiles (`profiles` + `user_profiles`): un perfil otorga permisos sueltos
  (ver Config/Spool/gestión usuarios vía `myPermissions`) + grupos de
  reportes (ej. finanzas). Un reporte con `groups: ["finanzas"]` lo ve quien
  esté en un perfil con ese grupo (además de owner/shares; admin ve todo).
  Grupos se editan en el dock; perfiles, miembros y qué reportes entran en
  cada perfil, en /admin/usuarios (tabs Usuarios/Perfiles).
- Editar reporte: admin, dueño o share `edit` (`myPermission`); el edit-share
  actualiza spec/título pero no flags. Publicar: owner/admin.
- Login: MSAL o propio (scrypt+jose, 12h). Con MSAL OFF el guard exige token
  local igual (sin backdoor en prod). Recupero por email: `authForgot` manda
  link 1h (requiere SMTP en /admin/config: gmail/outlook/custom + test),
  `authReset` lo canjea.
- Datasets: independientes (`dataset_shares` edit). Regla `canEditDataset`:
  admin, owner, edit-share; dataset legacy sin owner = abierto salvo shares.
  `updateDatasetSpec` usa la misma regla (baseVersion optimista, 409 = releer).
- `legacyDatasets` trae `can_edit` por fila para la UI.

## Datasets y GraphQL (cómo verlos)
- `legacyDatasets` → `[{id, slug, name, spec_version, owner_email, can_edit}]`
- `legacyDataset(id)` → `{id, slug, name, spec, specVersion}`
- `legacyRecords(id, tableId?, limit, offset)` → `{rows, total, source}`
  (`source`: staging | materialized | live). Tablas materializadas:
  `ds_<slug>__<tableId>` en `crud_db`.
- `datasetSources(id)` → fuentes + `sample_rows` (preview real).
- `datasetSchedules(id)` / `datasetAddSchedule(id, cron)` / `datasetDeleteSchedule`.
- Mutaciones: `datasetCreate`, `datasetCreateTable`, `datasetIngest`,
  `datasetMaterialize`, `datasetUploadCsv` (25MB, `/srv/uploads`),
  `datasetReplaceFile`, `datasetShare/Unshare`, `datasetDelete`,
  `updateDatasetSpec`, `datasetAddSource`.
- Editor: canvas Access (drag = solo layout, se persiste con 💾 Guardar en
  `spec.layout`), relaciones con 🔗, query builder (filtros/dropColumn),
  auto-guardado por acción con `vN`.

## Conectores (adapters, nada mockeado)
`graphql-backend/src/connectors/`: `catalog.ts` (form data-driven: label +
fields incl. `query` SQL, auth/headers/body/paginación REST) + `test.ts`
(`connectorTest`: SELECT 1 / HTTP real) + **`adapter.ts` (registro)**:
agregar un kind (SAP PO, cubo BW…) = entrada en catálogo + adapter
`{normalize, read, refreshable}`. `datasetAddSource` guarda config
**canónica** (connectionString/query, auth anidada). Lectura real:
`pg` directo, `mysql2`, `tedious` (MSSQL), `odbc` nativo (unixODBC en
imagen), `fetch` REST (GET/POST/PUT/PATCH/DELETE, bearer/basic/apiKey,
headers kv, jsonPath, paginación offset/page/cursor), python+pandas
(csv/xlsx). `csv` no es refrescable (se sube nueva versión).

## Refresh programado (real)
`refresh_schedules(dataset_id, cron, next_run_at)` — cron simple
`*/N * * * *` o `cada N min` (mín 5). Cada 30s (`datasetWorkerTick`):
`enqueueDueRefreshes` encola `rebuild` → `runDatasetJob` **re-ingesta TODAS
las fuentes refrescables** y luego `materializeDataset` (swap
`__new`→prod, `current_data_version+1`). Errores por fuente quedan en
`last_status` sin voltear el job. Ver estado en el editor (Schedules) y
cola en `/admin/spool`.

## Admin y config
`/admin/usuarios` (roles, clave local), `/admin/spool` (jobs + versiones +
restaurar), `/admin/config` (`systemStatus`: conteos, MSAL/local, uptime —
solo lectura, secretos en `.env` del backend, nunca al browser).

## Auth
MSAL ON (ID token, `redirectUri` = origin) convive con login propio
(scrypt+jose, `JWT_SECRET`, 12h). Guard: `creador.token` o sesión MSAL.
MCP usa login propio con retry. `dev@local` solo existe si se crea.

## Paquetes: pnpm
Los 3 paquetes usan **pnpm 11** (`packageManager` + `pnpm-lock.yaml`;
`allowBuilds` solo `esbuild`/`odbc`). Dockerfiles instalan con
`pnpm install --frozen-lockfile`. No hay `package-lock.json`.

## MCP y superadmin
MCP en `/mcp` (mismo dominio que el frontend vía nginx) con `MCP_API_KEY`.
Tools superadmin `admin_exec`/`admin_read` (repo en `/work`): solo dueño,
doble llave (`SUPERADMIN_EMAIL` + `SUPERADMIN_KEY` en `.env`), auditoría en
logs. La key nunca va en la config del agente.

## Modelos de datos: dónde vive cada cosa y cómo se guarda

Dos Postgres con roles distintos. **Nada se conecta directo a PG salvo el
backend**: frontend, MCP y scripts hablan siempre GraphQL (`:4001`).

### creador_db — reportes y gobierno (todo JSONB + relacional)

- `reports`: `slug/title/owner_email/is_published/is_template/groups` +
  **`spec` JSONB** (el modelo del reporte: `datasetId`, `charts[]`, `kpis[]`,
  `texts[]`, `tabs`, `filters`, `hero*`, `layoutOrder`, `w/rh`, `customOption`…).
  El spec es el "documento" del reporte: crearlo/modificarlo es un UPDATE al
  JSON, nunca archivos ni builds.
- `report_drafts (slug, user_email, state)`: borrador por usuario (autosave
  3s + botón Borrador). Al entrar a `?edit=1` se retoma el propio; si el
  servidor es más nuevo, aviso con Usar servidor / Seguir con mi borrador.
- `report_versions (id, slug, snapshot, created_by, created_at)`: fotos
  congeladas del spec al publicar. Restaurar = pisar `spec` con el snapshot.
- `report_shares / dataset_shares / profiles / user_profiles / users`:
  permisos (ver sección Permisos).
- `report_locks / publish_jobs / report_opens / mail_config /
  password_resets`: edición concurrente, cola de publish, métricas, email.

**Guardar un reporte** = `saveDraft` (borrador propio) y/o `upsertReport`
(persiste `spec` + flags con lock optimista implícito por `updated_at`).
**Publicar** = `publishReport` encola → worker (`SKIP LOCKED`) congela
`spec` en `report_versions` + `is_published = true`. El dock persiste el
working ANTES de encolar para no publicar lo viejo.

### crud_db (legacy) — datasets y datos

- `datasets`: `spec` JSONB (tablas, columnas inferidas, steps, relaciones,
  `layout` del canvas) + `spec_version` (lock optimista, 409 = releer) +
  `current_data_version`.
- `data_sources`: fuentes con **config canónica** (connectionString/query,
  auth anidada REST, paginación) vía adapters.
- `dataset_staging (dataset_id, table_id, row_idx, data JSONB)`: última
  ingesta cruda por tabla. `table_id = '__default'` = huérfana (se migró al
  crear la primera tabla).
- Tablas materializadas `ds_<slug>__<tableId>`: lo que leen los reportes
  (swap `__new`→prod, transaccional). Se regeneran con `datasetMaterialize`.
- `refresh_schedules / dataset_jobs`: cron (`*/N`, horario, diario, semanal)
  + ejecuciones con estado/error.

### Actualizar SOLO datos (sin tocar el modelo)

El spec del reporte y el spec del dataset **no se tocan**: el flujo es
fuente → staging → materializar → los reportes ven lo nuevo solos:

1. Manual: editor → Ingestar (fuente a staging) → Materializar (staging a
   `ds_*`, `current_data_version + 1`). CSV: Reemplazar archivo + lo mismo.
2. Programado: `refresh_schedules` → cada 30s el worker encola `rebuild` →
   **re-ingesta TODAS las fuentes refrescables** y materializa (no mockeado;
   errores por fuente en `last_status`, historial en `dataset_jobs`).
3. A demanda: `datasetRefreshNow` (editor ▶, MCP `dataset_refresh`).

### Cómo lee un reporte (orden de resolución)

`legacyRecords(id, tableId?, limit, offset)`:
1. Si `current_data_version > 0` y existe `ds_<slug>__<table>` → **materialized**.
2. Si no → **staging** + steps del spec aplicados (filtros/dropColumn).
Límite 5000 (defensa anti-colapso); la UI pagina en cliente (20/pág default).

### Qué rol juega GraphQL

Yoga + Pothos code-first (`graphql-backend/src/schema.ts`) es **la única
puerta de datos**: valida auth (MSAL/local), permisos (owner/shares/
perfiles/grupos), versionado optimista y serializa jobs/SSE. La info vive
en JSONB en PG; GraphQL no duplica nada, solo la expone tipada
(`legacyDatasets`, `legacyRecords`, `report`, `reportVersions`,
`datasetJobs…`) y muta (`upsertReport`, `updateDatasetSpec`,
`datasetIngest/Materialize…`). El renderer nunca toca la BD: pide filas por
GraphQL y pinta el spec.
