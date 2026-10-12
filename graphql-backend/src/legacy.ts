// Lectura contra crud_db (stack viejo): specs + filas materializadas/staging.
// El v2 NO duplica datos en fase 1; cuando el motor de ingest se porte,
// escribirá en creador_db y este módulo cambiará de pool.
import pg from 'pg';
import { applySteps } from './semantic/engine.js';
import type { DatasetTable, SemanticModelSpec } from './semantic/types.js';
import { validateSpec, hasErrors } from './semantic/validate.js';

const { Pool } = pg;

export const legacyPool = new Pool({
  user: process.env.LEGACY_DB_USER || process.env.DB_USER || 'postgres',
  host: process.env.LEGACY_DB_HOST || process.env.DB_HOST || 'localhost',
  database: process.env.LEGACY_DB_NAME || 'crud_db',
  password: process.env.LEGACY_DB_PASSWORD || process.env.DB_PASSWORD || '123123',
  port: Number(process.env.LEGACY_DB_PORT || process.env.DB_PORT || 5432),
  max: 5,
});

export interface LegacyDataset {
  id: string;
  slug: string;
  name: string;
  spec: any;
  spec_version: number;
  owner_email: string;
  current_data_version: number;
}

export async function ensureDatasetShares(): Promise<void> {
  await legacyPool.query(`
    CREATE TABLE IF NOT EXISTS dataset_shares (
      dataset_id TEXT NOT NULL,
      shared_with_email TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'view',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (dataset_id, shared_with_email, permission)
    );
  `);
}

// Versiones compatibles con store.getDataset/patchDataset del stack viejo
// (ingest.ts portado las importa con estos nombres).
export async function legacyGetDataset(idOrSlug: string): Promise<any | null> {
  const { rows } = await legacyPool.query('SELECT * FROM datasets WHERE id = $1 OR slug = $1 LIMIT 1', [idOrSlug]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name || ''),
    spec: typeof r.spec === 'string' ? JSON.parse(r.spec) : r.spec || {},
    spec_version: Number(r.spec_version || 1),
    status: String(r.status || 'draft'),
    current_data_version: Number(r.current_data_version || 0),
    created_by: String(r.created_by || ''),
    owner_email: String(r.owner_email || ''),
  };
}

export async function legacyPatchDataset(
  idOrSlug: string,
  baseVersion: number,
  mutate: (spec: SemanticModelSpec) => SemanticModelSpec,
  opts: { skipValidation?: boolean } = {},
): Promise<{ row: any; issues: ReturnType<typeof validateSpec> }> {
  const current = await legacyGetDataset(idOrSlug);
  if (!current) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
  if (Number(baseVersion) !== current.spec_version) {
    throw Object.assign(new Error(`Conflicto de versión (base ${baseVersion}, vigente ${current.spec_version}). Releer antes de escribir.`), { status: 409 });
  }
  const next = mutate(structuredClone(current.spec));
  (next as any).specVersion = current.spec_version + 1;
  (next as any).updatedAt = new Date().toISOString();
  const issues = validateSpec(next);
  if (!opts.skipValidation && hasErrors(issues)) {
    throw Object.assign(new Error(`Spec inválida: ${issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | ')}`), { status: 422, issues });
  }
  const { rows } = await legacyPool.query(
    `UPDATE datasets SET spec = $2, spec_version = $3, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [current.id, JSON.stringify(next), current.spec_version + 1],
  );
  return { row: rows[0], issues };
}

export async function getLegacyDataset(idOrSlug: string): Promise<LegacyDataset | null> {
  const { rows } = await legacyPool.query('SELECT * FROM datasets WHERE id = $1 OR slug = $1 LIMIT 1', [idOrSlug]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    slug: r.slug,
    name: r.name || r.slug,
    spec: typeof r.spec === 'string' ? JSON.parse(r.spec) : r.spec || {},
    spec_version: r.spec_version || 1,
    owner_email: (r.owner_email || '').toLowerCase(),
    current_data_version: r.current_data_version || 0,
  };
}

export interface RecordsOut {
  tableId: string;
  rows: Record<string, unknown>[];
  columns: { id: string; name: string; type: string }[];
  total: number;
  source: 'materialized' | 'staging';
}

// Versión simplificada de readRecords del stack viejo (sin filtros/sort;
// el renderer agrega en cliente). Cap 5000 filas por llamada.
export async function readRecordsSimple(
  idOrSlug: string,
  tableId = '',
  limit = 1000,
  offset = 0,
): Promise<RecordsOut> {
  const ds = await getLegacyDataset(idOrSlug);
  if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
  const tables: DatasetTable[] = ds.spec?.tables || [];
  const table = tables.find((t) => t.id === tableId) || tables[0];
  if (!table) throw Object.assign(new Error('Dataset sin tablas'), { status: 409 });
  const lim = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  const off = Math.max(Number(offset) || 0, 0);
  const slug = ds.slug.replace(/[^a-z0-9_]/g, '_');
  const target = `ds_${slug}__${table.id.replace(/[^a-z0-9_]/g, '_')}`;
  if (ds.current_data_version > 0) {
    const exists = await legacyPool.query('SELECT to_regclass($1) AS t', [`public."${target}"`]);
    if (exists.rows[0]?.t) {
      const r = await legacyPool.query(`SELECT * FROM "${target}" LIMIT $1 OFFSET $2`, [lim, off]);
      const total = await legacyPool.query(`SELECT count(*)::int AS n FROM "${target}"`);
      const cols = table.columns?.length
        ? table.columns
        : Object.keys(r.rows[0] || {}).map((name) => ({ id: name, name, type: 'text' as const }));
      return { tableId: table.id, rows: r.rows, columns: cols, total: total.rows[0]?.n || 0, source: 'materialized' };
    }
  }
  const r = await legacyPool.query(
    'SELECT data FROM dataset_staging WHERE dataset_id = $1 AND table_id = $2 ORDER BY row_idx LIMIT $3 OFFSET $4',
    [ds.id, table.id, 50000, 0],
  );
  const staged = r.rows.map((x) => x.data as Record<string, unknown>);
  const out = applySteps(table, staged, { rowLimit: 50000 });
  return {
    tableId: table.id,
    rows: out.rows.slice(off, off + lim),
    columns: out.columns,
    total: out.rows.length,
    source: 'staging',
  };
}
