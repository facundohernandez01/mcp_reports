// Portado de builder/src/lib/... (stack viejo). Ver notas en cada archivo.
// @ts-nocheck
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Pool as PgPool } from 'pg';
import path from 'node:path';
import { legacyPool as pool } from '../legacy.js';
import type { DataSourceConfig, DatasetTable } from './types.js';
import { buildTableSQL } from './engine.js';
import { legacyGetDataset as getDataset, legacyPatchDataset as patchDataset } from '../legacy.js';

const execFileAsync = promisify(execFile);

export const MAX_INGEST_ROWS = 50000;
const PREVIEW_ROWS = 200;

const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;

export async function ensureIngestSchema() {  await pool.query(`
    CREATE TABLE IF NOT EXISTS dataset_staging (
      dataset_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      row_idx INT NOT NULL,
      data JSONB NOT NULL,
      PRIMARY KEY (dataset_id, table_id, row_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_staging_ds ON dataset_staging(dataset_id, table_id);
  `);
}

export interface IngestResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  truncated: boolean;
}

const guessType = (values: unknown[]): string => {
  const vals = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (!vals.length) return 'text';
  if (vals.every((v) => Number.isFinite(Number(String(v).replace(/\./g, '').replace(',', '.'))) || Number.isFinite(Number(v)))) return 'number';
  if (vals.every((v) => !Number.isNaN(Date.parse(String(v))))) return 'date';
  if (vals.every((v) => ['true', 'false', '1', '0', 'sí', 'si', 'no', 'yes'].includes(String(v).toLowerCase()))) return 'boolean';
  return 'text';
};

export function inferColumns(rows: Record<string, unknown>[]): { name: string; type: string }[] {
  const keys: string[] = [];
  for (const r of rows.slice(0, 1000)) {
    for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  }
  return keys.map((k) => ({ name: k, type: guessType(rows.map((r) => r[k])) }));
}

async function runPython(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('python3', args, { cwd, timeout: 300000, maxBuffer: 100 * 1024 * 1024 });
  return stdout;
}

// Lee CSV/XLSX completo (hasta MAX_INGEST_ROWS) vía pandas.
// header: fila de encabezados (0-based, default 0). skiprows: filas a saltear.
// raw: sin header (columnas 0..n) para inspección previa.
export async function readFileSource(filePath: string, sheet?: string | number, header = 0, skiprows = 0, raw = false): Promise<IngestResult> {
  const updir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'archivos_subidos');
  const abs = path.isAbsolute(filePath) ? filePath : path.join(updir, filePath);
  const script = `
import io, json, sys
import pandas as pd
p = sys.argv[1]
sheet = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != '' else 0
header = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != '' else 0
skiprows = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] != '' else 0
raw = sys.argv[5] == '1' if len(sys.argv) > 5 else False
try:
    if p.lower().endswith(('.xlsx', '.xls')):
        df = pd.read_excel(p, sheet_name=sheet, header=None if raw else header, skiprows=skiprows)
    else:
        df = pd.read_csv(p, header=None if raw else header, skiprows=skiprows)
    if isinstance(df, dict):
        df = list(df.values())[0]
except Exception as e:
    print(json.dumps({'error': str(e)})); sys.exit(0)
if raw:
    df.columns = [f'col_{i}' for i in range(len(df.columns))]
# to_json sanea todo lo no-JSON (NaN->null, Timestamp->ISO). to_dict no.
buf = io.StringIO()
df.head(${MAX_INGEST_ROWS}).to_json(buf, orient='records', date_format='iso')
rows = json.loads(buf.getvalue())
print(json.dumps({'rows': rows, 'total': len(df)}))
`;
  const out = await runPython(['-c', script, abs, String(sheet ?? ''), String(header), String(skiprows), raw ? '1' : ''], process.cwd());
  const parsed = JSON.parse(out || '{}') as { error?: string; rows?: Record<string, unknown>[]; total?: number };
  if (parsed.error) throw new Error(`Excel/CSV: ${parsed.error}`);
  const rows = (parsed.rows || []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [String(k), v])));
  return { rows, columns: inferColumns(rows), truncated: (parsed.total || 0) > rows.length };
}

function jsonPathGet(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (part === '*') {
      if (!Array.isArray(cur)) return undefined;
      return cur;
    }
    const m = /^(\w+)\[(\d+)\]$/.exec(part);
    if (m) {
      const rec = cur as Record<string, unknown>;
      const arr = rec[m[1]];
      cur = Array.isArray(arr) ? arr[Number(m[2])] : undefined;
    } else {
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

// REST con paginación offset/page/cursor.
export async function readRestSource(config: DataSourceConfig): Promise<IngestResult> {
  const url = String(config.url || '');
  if (!url) throw new Error('Falta url');
  // Acepta config canónica (adapter) o plana del form viejo.
  const nested = (config.auth || {}) as { type?: string; token?: string; user?: string; headers?: Record<string, string> };
  const flatHeaders = config.headers;
  const headers: Record<string, string> = {
    ...((flatHeaders && typeof flatHeaders === 'object' ? flatHeaders : {}) as Record<string, string>),
    ...(nested.headers || {}),
  };
  const authType = String(nested.type || (config as unknown as { authType?: string }).authType || 'none');
  const token = String(nested.token ?? (config as unknown as { token?: string }).token ?? '');
  const user = String(nested.user ?? (config as unknown as { user?: string }).user ?? '');
  const apiKeyHeader = String((config as unknown as { apiKeyHeader?: string }).apiKeyHeader || 'x-api-key');
  if (authType === 'bearer' && token) headers.Authorization = `Bearer ${token}`;
  else if (authType === 'basic') {
    const t = token;
    const [u, ...rest] = t.includes(':') ? t.split(':') : [user, t];
    headers.Authorization = `Basic ${Buffer.from(`${u}:${rest.join(':')}`).toString('base64')}`;
  } else if (authType === 'apiKey' && token) headers[apiKeyHeader] = token;
  const method = String(config.method || 'GET').toUpperCase();
  const bodyText = String((config as unknown as { body?: string }).body || '').trim();
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(60000) };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && bodyText) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    init.body = bodyText;
  }
  const pag = config.pagination?.type || 'none';
  const pageSize = Math.min(Number(config.pagination?.pageSize) || 100, 1000);
  const maxPages = Math.min(Number(config.pagination?.maxPages) || 10, 50);
  const rows: Record<string, unknown>[] = [];
  let cursor: unknown = null;
  let totalPages = pag === 'none' ? 1 : maxPages;
  for (let page = 0; page < totalPages && rows.length < MAX_INGEST_ROWS; page += 1) {
    const u = new URL(url);
    if (pag === 'offset') {
      u.searchParams.set(config.pagination?.offsetParam || 'offset', String(page * pageSize));
      u.searchParams.set(config.pagination?.limitParam || 'limit', String(pageSize));
    } else if (pag === 'page') {
      u.searchParams.set(config.pagination?.pageParam || 'page', String(page + 1));
      u.searchParams.set(config.pagination?.limitParam || 'limit', String(pageSize));
    } else if (pag === 'cursor' && cursor !== null) {
      u.searchParams.set(config.pagination?.offsetParam || 'cursor', String(cursor));
    }
    const res = await fetch(u.toString(), { method, headers, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`REST HTTP ${res.status} (página ${page + 1})`);
    const body = await res.json().catch(() => null);
    const extracted = jsonPathGet(body, config.jsonPath);
    const batch = (Array.isArray(extracted) ? extracted : extracted ? [extracted] : []) as Record<string, unknown>[];
    if (!batch.length) break;
    rows.push(...batch);
    if (pag === 'cursor') {
      const next = jsonPathGet(body, config.pagination?.offsetParam || 'nextCursor');
      if (next === null || next === undefined || next === cursor) break;
      cursor = next;
    } else if (batch.length < pageSize) break;
  }
  const sliced = rows.slice(0, MAX_INGEST_ROWS);
  return { rows: sliced, columns: inferColumns(sliced), truncated: rows.length > sliced.length };
}

// Postgres/MySQL/SQLServer nativo + ODBC genérico (DSN). mysql2/odbc/tedious
// con import dinámico: si el driver no está instalado, error accionable.
// Acepta config canónica (adapter: connectionString+query) o plana del form.
export async function readSqlSource(config: DataSourceConfig): Promise<IngestResult> {
  const c = config as unknown as Record<string, unknown>;
  let cs = String(config.connectionString || (c.dsn as string) || '');
  if (!cs && (c.host || c.database)) {
    const kind = String(c.ingestKind || '').toLowerCase();
    const host = String(c.host || 'localhost');
    const user = String(c.user || '');
    const pass = String(c.password || '');
    if (/mssql|sqlserver/i.test(kind) || /mssql|sqlserver/i.test(String(config.connectionString || ''))) {
      cs = `sqlserver://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${c.port || 1433}/${encodeURIComponent(String(c.database || ''))}`;
    } else if (/mysql/i.test(kind)) {
      cs = `mysql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${c.port || 3306}/${encodeURIComponent(String(c.database || ''))}`;
    } else {
      cs = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${c.port || 5432}/${encodeURIComponent(String(c.database || ''))}`;
    }
  }
  const query = String(config.query || '');
  if (!cs || !query) throw new Error('Faltan connectionString/query (agregá la fuente con host+query o connection string).');
  if (/^postgres/i.test(cs)) {
    const p = new PgPool({ connectionString: cs });
    try {
      const r = await p.query(query);
      const rows = (r.rows || []).slice(0, MAX_INGEST_ROWS) as Record<string, unknown>[];
      return { rows, columns: inferColumns(rows), truncated: (r.rows || []).length > rows.length };
    } finally {
      await p.end().catch(() => {});
    }
  }
  if (/^mysql/i.test(cs)) {
    let mysql: typeof import('mysql2/promise');
    try {
      mysql = await import('mysql2/promise');
    } catch {
      throw new Error('Driver mysql2 no instalado (pnpm add mysql2 + rebuild)');
    }
    const conn = await mysql.createConnection(cs);
    try {
      const [rows] = (await conn.query(query)) as [Record<string, unknown>[], unknown];
      const list = (Array.isArray(rows) ? rows : []).slice(0, MAX_INGEST_ROWS);
      return { rows: list, columns: inferColumns(list), truncated: (Array.isArray(rows) ? rows.length : 0) > list.length };
    } finally {
      await conn.end().catch(() => {});
    }
  }
  // SQL Server vía tedious (partes planas o connectionString sqlserver://).
  if (/^sqlserver/i.test(cs) || /mssql/i.test(String((config as unknown as Record<string, unknown>).ingestKind || ''))) {
    let tedious: {
      Connection: new (cfg: Record<string, unknown>) => {
        connect: (cb: (e?: Error) => void) => void;
        close: () => void;
        execSql: (r: unknown) => void;
        on: (ev: string, cb: (...a: never[]) => void) => void;
      };
      Request: new (sql: string, cb: (e: Error | null, count: number, rows: { value: unknown }[][]) => void) => unknown;
    };
    try {
      tedious = (await import('tedious')) as unknown as typeof tedious;
    } catch {
      throw new Error('Driver tedious no instalado (pnpm add tedious + rebuild)');
    }
    const m = /^sqlserver:\/\/([^:]+):([^@]*)@([^:/]+):?(\d+)?\/(.+)$/i.exec(cs);
    const cc = config as unknown as Record<string, unknown>;
    const connCfg = {
      server: m ? m[3] : String(cc.host || 'localhost'),
      authentication: {
        type: 'default',
        options: {
          userName: m ? decodeURIComponent(m[1]) : String(cc.user || ''),
          password: m ? decodeURIComponent(m[2]) : String(cc.password || ''),
        },
      },
      options: {
        port: Number(m?.[4] || cc.port) || 1433,
        database: m ? decodeURIComponent(m[5]) : String(cc.database || ''),
        encrypt: String(cc.encrypt ?? 'true') !== 'false',
        trustServerCertificate: true,
        connectTimeout: 15000,
        requestTimeout: 60000,
      },
    };
    const conn = new tedious.Connection(connCfg);
    try {
      await new Promise<void>((resolve, reject) => {
        conn.on('connect', (e) => (e ? reject(e) : resolve()));
        conn.connect(() => {});
      });
      const rows: Record<string, unknown>[] = await new Promise((resolve, reject) => {
        const out: Record<string, unknown>[] = [];
        let cols: string[] = [];
        const req = new tedious.Request(query, (e) => (e ? reject(e) : resolve(out)));
        (req as unknown as { on: (ev: string, cb: (arg: { metadata: { colName: string }[] } | { value: unknown }[]) => void) => void }).on('columnMetadata', (meta) => {
          cols = (meta as { metadata: { colName: string }[] }).metadata.map((m) => m.colName);
        });
        (req as unknown as { on: (ev: string, cb: (arg: { value: unknown }[]) => void) => void }).on('row', (columns) => {
          const obj: Record<string, unknown> = {};
          columns.forEach((col, i) => { obj[cols[i] || `col${i}`] = col?.value ?? null; });
          out.push(obj);
        });
        conn.execSql(req);
      });
      const list = rows.slice(0, MAX_INGEST_ROWS);
      return { rows: list, columns: inferColumns(list), truncated: rows.length > list.length };
    } finally {
      try { conn.close(); } catch {}
    }
  }
  // ODBC genérico: connectionString es el DSN ("DSN=...;UID=...;PWD=...").
  let odbc: typeof import('odbc');
  try {
    odbc = await import('odbc');
  } catch {
    throw new Error('Driver odbc no instalado (unixodbc + pnpm add odbc + rebuild; ver docs/06)');
  }
  let conn: { query: (q: string) => Promise<unknown[]>; close: () => Promise<void> } | null = null;
  try {
    conn = (await odbc.connect(cs)) as unknown as typeof conn;
    const raw = (await conn.query(query)) as Record<string, unknown>[];
    const list = (Array.isArray(raw) ? raw : []).slice(0, MAX_INGEST_ROWS);
    return { rows: list, columns: inferColumns(list), truncated: (Array.isArray(raw) ? raw.length : 0) > list.length };
  } finally {
    await conn?.close().catch(() => {});
  }
}

// Rama clásica (configs viejas / kinds sin adapter). Los adapters delegan
// acá cuando aplica; no agregar kinds nuevos acá, van en connectors/adapter.ts.
async function legacyRead(kind: string, config: DataSourceConfig): Promise<IngestResult> {
  if (kind === 'csv' || kind === 'xlsx') {
    const cfg = config as DataSourceConfig;
    return readFileSource(
      String(cfg.filePath || (cfg as DataSourceConfig & { filename?: string }).filename || ''),
      cfg.sheet,
      cfg.headerRow ?? 0,
      cfg.skiprows ?? 0,
    );
  }
  if (kind === 'rest') return readRestSource(config);
  if (kind === 'postgres' || kind === 'mysql' || kind === 'mssql' || kind === 'odbc') return readSqlSource(config);
  throw new Error(`Ingesta directa no soportada para kind=${kind} (usar preview con samples)`);
}

export async function ingestSource(
  datasetId: string,
  sourceId: string,
  opts: { createdBy?: string } = {},
): Promise<{ rowCount: number; columns: { name: string; type: string }[]; truncated: boolean; linkedTables: number; warning?: string }> {
  await ensureIngestSchema();
  const ds = await getDataset(datasetId);
  if (!ds) throw new Error('Dataset no encontrado');
  const { rows } = await pool.query('SELECT * FROM data_sources WHERE id = $1 AND dataset_id = $2', [sourceId, ds.id]);
  const source = rows[0] as { kind: string; config: DataSourceConfig } | undefined;
  if (!source) throw new Error('Fuente no encontrada');
  const kind = String(source.kind);
  void opts;
  let result: IngestResult;
  // Vía adapters cuando existe (agregar un kind = agregarlo en connectors/adapter.ts).
  const { adapterOf } = await import('../connectors/adapter.js');
  const adapter = adapterOf(kind);
  if (adapter) {
    result = await adapter.read(source.config as unknown as Record<string, unknown>);
  } else if (kind === 'manual' || kind === 'firestore') {
    throw new Error(`Ingesta directa no soportada para kind=${kind} (manual: cargar filas en el editor; firestore: usar preview con samples)`);
  } else {
    result = await legacyRead(kind, source.config as DataSourceConfig);
  }
  // Staging: reemplazo total por tabla/s fuente (la tabla destino se elige por sourceId).
  const tables = ds.spec.tables.filter((t) => t.sourceId === sourceId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of tables.length ? tables : [{ id: '__default' }]) {
      await client.query('DELETE FROM dataset_staging WHERE dataset_id = $1 AND table_id = $2', [ds.id, table.id]);
      let i = 0;
      const batch: unknown[] = [];
      const flush = async () => {
        if (!batch.length) return;
        const values = (batch as Record<string, unknown>[]).map((r) => `(${q(ds.id)},${q(table.id)},${i++},'${JSON.stringify(r).replace(/'/g, "''")}'::jsonb)`).join(',');
        await client.query(`INSERT INTO dataset_staging (dataset_id, table_id, row_idx, data) VALUES ${values}`);
        batch.length = 0;
      };
      for (const r of result.rows) {
        batch.push(r);
        if (batch.length >= 500) await flush();
      }
      await flush();
    }
    await client.query(
      `UPDATE data_sources SET sample_rows = $2, schema_hash = $3, updated_at = now() WHERE id = $1`,
      [sourceId, JSON.stringify(result.rows.slice(0, 200)), hashSchema(result.columns)],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return {
    rowCount: result.rows.length,
    columns: result.columns,
    truncated: result.truncated,
    linkedTables: tables.length,
    ...(tables.length
      ? {}
      : { warning: 'Esta fuente no alimenta ninguna tabla: las filas quedaron en staging sin asignar. Usá "Crear tabla" en la fuente y actualizá de nuevo.' }),
  };
}

const hashSchema = (columns: { name: string; type: string }[]) =>
  createHash('sha256').update(JSON.stringify(columns)).digest('hex').slice(0, 16);

const identOk = (s: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);

// Materializa cada tabla a dataset_data_<slug>__<table> con swap transaccional.
export async function materializeDataset(datasetId: string): Promise<{ version: number }> {
  await ensureIngestSchema();
  const ds = await getDataset(datasetId);
  if (!ds) throw new Error('Dataset no encontrado');
  const slug = ds.slug.replace(/[^a-z0-9_]/g, '_');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of ds.spec.tables) {
      const target = `ds_${slug}__${table.id.replace(/[^a-z0-9_]/g, '_')}`;
      if (!identOk(target)) throw new Error(`Nombre de tabla inválido: ${target}`);
      const staging = `dataset_staging`;
      const sql = buildTableSQL(table, `(SELECT data FROM ${staging} WHERE dataset_id = ${q(ds.id)} AND table_id = ${q(table.id)} ORDER BY row_idx)`);
      await client.query(`DROP TABLE IF EXISTS "${target}__new"`);
      await client.query(`CREATE TABLE "${target}__new" AS ${sql}`);
      await client.query(`DROP TABLE IF EXISTS "${target}__old"`);
      const exists = await client.query(`SELECT to_regclass($1) AS t`, [`public."${target}"`]);
      if (exists.rows[0]?.t) {
        await client.query(`ALTER TABLE "${target}" RENAME TO "${target}__old"`);
      }
      await client.query(`ALTER TABLE "${target}__new" RENAME TO "${target}"`);
      await client.query(`DROP TABLE IF EXISTS "${target}__old"`);
    }
    const v = await client.query(`UPDATE datasets SET current_data_version = current_data_version + 1, updated_at = now() WHERE id = $1 RETURNING current_data_version`, [ds.id]);
    await client.query('COMMIT');
    return { version: Number(v.rows[0]?.current_data_version || 0) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
export async function readRecords(
  datasetId: string,
  tableId: string,
  limit: number,
  offset: number,
  opts: { filters?: Record<string, unknown>; sort?: string; dir?: string } = {},
) {
  const ds = await getDataset(datasetId);
  if (!ds) throw new Error('Dataset no encontrado');
  const table = ds.spec.tables.find((t) => t.id === tableId) || ds.spec.tables[0];
  if (!table) throw new Error('Sin tablas');
  const slug = ds.slug.replace(/[^a-z0-9_]/g, '_');
  const target = `ds_${slug}__${table.id.replace(/[^a-z0-9_]/g, '_')}`;
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const off = Math.max(Number(offset) || 0, 0);
  const qid = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  // Allowlist de columnas reales (anti-inyección en identificadores).
  const realCols = async (): Promise<Set<string>> => {
    try {
      const r = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [target],
      );
      return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
    } catch {
      return new Set();
    }
  };
  // WHERE desde {col: [v...] | {gte,lte} | valor} solo con columnas permitidas.
  const buildWhere = (allowed: (c: string) => boolean, get: (c: string) => string, params: unknown[]): string => {
    const parts: string[] = [];
    for (const [col, cond] of Object.entries(opts.filters || {})) {
      if (!allowed(col)) continue;
      const c = get(col);
      if (Array.isArray(cond)) {
        if (!cond.length) continue;
        params.push(...cond.map(String));
        parts.push(`${c} = ANY (ARRAY[${cond.map((_, i) => `$${params.length - cond.length + i + 1}`).join(',')}])`);
      } else if (cond !== null && typeof cond === 'object') {
        const cc = cond as Record<string, unknown>;
        if (cc.like !== undefined && String(cc.like).trim() !== '') { params.push(`%${String(cc.like).trim()}%`); parts.push(`${c}::text ILIKE $${params.length}`); }
        if (cc.gte !== undefined) { params.push(String(cc.gte)); parts.push(`${c} >= $${params.length}`); }
        if (cc.lte !== undefined) { params.push(String(cc.lte)); parts.push(`${c} <= $${params.length}`); }
      } else if (cond !== undefined) {
        params.push(String(cond));
        parts.push(`${c} = $${params.length}`);
      }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  };
  const orderBy = (allowed: (c: string) => boolean, get: (c: string) => string): string => {
    if (!opts.sort || !allowed(opts.sort)) return '';
    return ` ORDER BY ${get(opts.sort)} ${opts.dir === 'desc' ? 'DESC' : 'ASC'}`;
  };
  if (ds.current_data_version > 0) {
    const exists = await pool.query(`SELECT to_regclass($1) AS t`, [`public."${target}"`]);
    if (exists.rows[0]?.t) {
      const allowed = await realCols();
      const params: unknown[] = [];
      const where = buildWhere((c) => allowed.has(c), (c) => qid(c), params);
      const order = orderBy((c) => allowed.has(c), (c) => qid(c));
      const r = await pool.query(`SELECT * FROM "${target}"${where}${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, lim, off]);
      const total = await pool.query(`SELECT count(*)::int AS n FROM "${target}"${where}`, params);
      return { tableId: table.id, rows: r.rows, total: total.rows[0]?.n || 0, version: ds.current_data_version, source: 'materialized' as const };
    }
  }
  // Staging (JSONB): filtros sobre data->>, con cast numérico según el spec.
  const specNames = new Set(table.columns.map((c) => c.name));
  const numeric = new Set(table.columns.filter((c) => c.type === 'number').map((c) => c.name));
  const numGet = (c: string) => `(NULLIF(data->>${JSON.stringify(c)},'')::float8)`;
  const params: unknown[] = [ds.id, table.id];
  const stGet = (c: string) => (numeric.has(c) ? numGet(c) : `data->>${JSON.stringify(c)}`);
  const where = buildWhere(
    (c) => specNames.has(c),
    stGet,
    params,
  );
  const order = orderBy((c) => specNames.has(c), stGet) || ' ORDER BY row_idx';
  const r = await pool.query(
    `SELECT data FROM dataset_staging WHERE dataset_id = $1 AND table_id = $2${where} ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, lim, off],
  );
  const total = await pool.query(`SELECT count(*)::int AS n FROM dataset_staging WHERE dataset_id = $1 AND table_id = $2${where}`, params);
  return { tableId: table.id, rows: r.rows.map((x: { data: unknown }) => x.data), total: total.rows[0]?.n || 0, version: 0, source: 'staging' as const };
}

// --- Worker de refrescos (patrón spooler: SKIP LOCKED, intervalo en server.mjs) ---

export async function claimDatasetJob(): Promise<Record<string, unknown> | null> {
  await ensureIngestSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM dataset_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const job = rows[0] as Record<string, unknown>;
    await client.query(`UPDATE dataset_jobs SET status = 'running', started_at = now() WHERE id = $1`, [job.id]);
    await client.query('COMMIT');
    return job;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function finishJob(id: string, patch: { status: string; error?: string }) {
  await pool.query(
    `UPDATE dataset_jobs SET status = $2, error = $3, finished_at = CASE WHEN $2 IN ('success','failed') THEN now() ELSE finished_at END WHERE id = $1`,
    [id, patch.status, patch.error || null],
  );
}

export async function runDatasetJob(job: Record<string, unknown>): Promise<void> {
  const datasetId = String((job as { dataset_id?: string }).dataset_id || '');
  const kind = String((job as { kind?: string }).kind || 'rebuild');
  const payload = ((job as { payload?: Record<string, unknown> }).payload || {}) as Record<string, unknown>;
  try {
    if (kind === 'ingest' && payload.sourceId) {
      await ingestSource(datasetId, String(payload.sourceId));
    } else if (kind === 'materialize' || kind === 'rebuild') {
      if (payload.sourceId) {
        await ingestSource(datasetId, String(payload.sourceId));
      } else if (kind === 'rebuild') {
        // Refresh REAL: re-ingesta TODAS las fuentes refrescables antes de
        // materializar (antes solo materializaba staging viejo).
        const { rows } = await pool.query('SELECT id, kind FROM data_sources WHERE dataset_id = $1', [datasetId]);
        const { adapterOf } = await import('../connectors/adapter.js');
        for (const s of rows as { id: string; kind: string }[]) {
          const a = adapterOf(String(s.kind));
          if (a && !a.refreshable) continue;
          try {
            await ingestSource(datasetId, String(s.id));
          } catch (e) {
            await pool.query(`UPDATE refresh_schedules SET last_status = $2 WHERE dataset_id = $1`, [datasetId, `error fuente ${s.id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)]);
          }
        }
      }
      const { version } = await materializeDataset(datasetId);
      await pool.query(`UPDATE dataset_jobs SET payload = payload || $2 WHERE id = $1`, [job.id, JSON.stringify({ dataVersion: version })]);
      await pool.query(`UPDATE refresh_schedules SET last_status = $2 WHERE dataset_id = $1`, [datasetId, `ok v${version} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]);
    } else {
      throw new Error(`kind desconocido: ${kind}`);
    }
    await finishJob(String(job.id), { status: 'success' });
  } catch (e) {
    await finishJob(String(job.id), { status: 'failed', error: e instanceof Error ? e.message : String(e) });
  }
}

// Encola vencimientos de refresh_schedules (cron simple: cada N minutos).
export async function enqueueDueRefreshes(): Promise<number> {
  await ensureIngestSchema();
  const { rows } = await pool.query(
    `SELECT s.* FROM refresh_schedules s
     WHERE s.enabled AND (s.next_run_at IS NULL OR s.next_run_at <= now())
     AND NOT EXISTS (SELECT 1 FROM dataset_jobs j WHERE j.dataset_id = s.dataset_id AND j.status IN ('queued','running'))`,
  );
  let n = 0;
  for (const s of rows as { dataset_id: string; id: string }[]) {
    await pool.query(
      `INSERT INTO dataset_jobs (id, dataset_id, kind, payload, created_by) VALUES ($1, $2, 'rebuild', '{}', 'scheduler')`,
      [`job_${Date.now().toString(36)}${n}`, s.dataset_id],
    );
    const everyMin = Math.max(5, parseCronMinutes(String((s as unknown as { cron?: string }).cron || '')));
    await pool.query(`UPDATE refresh_schedules SET next_run_at = now() + ($1 || ' minutes')::interval, last_status = 'queued' WHERE id = $2`, [String(everyMin), s.id]);
    n += 1;
  }
  return n;
}

// Acepta "*/N * * * *" (cada N min), "0 * * * *" (cada hora),
// "0 H * * *" (diario H:00), "0 H * * D" (semanal) o "cada N min".
export function parseCronMinutes(cron: string): number {
  const c = cron.trim();
  let m = /^\*\/(\d+)\s/.exec(c);
  if (m) return Math.max(1, Number(m[1]));
  m = /^0\s+(\d+)\s+\*\s+\*\s+(\d+)$/.exec(c);
  if (m) return 10080;
  m = /^0\s+(\d+)\s+\*\s+\*\s+\*$/.exec(c);
  if (m) return 1440;
  if (/^0\s+\*\s+\*\s+\*\s+\*$/.test(c)) return 60;
  const m2 = /cada\s+(\d+)/i.exec(c);
  if (m2) return Math.max(1, Number(m2[1]));
  return 60;
}

export async function datasetWorkerTick(): Promise<string> {
  await enqueueDueRefreshes().catch(() => 0);
  const job = await claimDatasetJob().catch(() => null);
  if (!job) return 'idle';
  await runDatasetJob(job);
  return `job ${String(job.id)} done`;
}

// Crea la tabla vinculada a una fuente (ingesta + columnas inferidas).
// onlyColumns: subconjunto de nombres (del picker de columnas).
export async function createTableFromSource(datasetId: string, sourceId: string, tableName: string, onlyColumns?: string[]) {
  const ds = await getDataset(datasetId);
  if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
  const ing = await ingestSource(ds.id, sourceId);
  let cols = ing.columns;
  if (Array.isArray(onlyColumns) && onlyColumns.length) {
    const want = new Set(onlyColumns.map(String));
    cols = cols.filter((c) => want.has(c.name));
    if (!cols.length) throw Object.assign(new Error('Ninguna columna elegida existe en la fuente'), { status: 422 });
  }
  if (!cols.length) throw Object.assign(new Error('Sin columnas detectadas'), { status: 422 });
  const stamp = Date.now().toString(36);
  const table = {
    id: `tbl_${stamp}`,
    name: String(tableName || 'Tabla').slice(0, 60),
    sourceId,
    columns: cols.map((c, i) => ({
      id: `col_${stamp}${i}`,
      name: c.name,
      type: (['text', 'number', 'boolean', 'date'].includes(c.type) ? c.type : 'text') as 'text' | 'number' | 'boolean' | 'date',
      nullable: true,
    })),
    steps: [],
    ui: { x: 60, y: 60 },
  };
  const hadTables = (ds.spec.tables || []).length > 0;
  const { row } = await patchDataset(ds.id, ds.spec_version, (spec) => ({
    ...spec,
    tables: [...spec.tables, table],
  }));
  // Si es la primera tabla y una ingesta previa cayó en __default (no había
  // tablas vinculadas), migrar esas filas para no dejar staging huérfano.
  if (!hadTables) {
    await pool.query(`UPDATE dataset_staging SET table_id = $2 WHERE dataset_id = $1 AND table_id = '__default'`, [ds.id, table.id]);
  }
  return { table, rowCount: ing.rowCount, spec_version: row.spec_version };
}
