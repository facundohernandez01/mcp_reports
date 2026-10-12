// Capa adapter de conectores: cada kind declara cómo probar, leer y
// normalizar su config. Agregar un kind nuevo (SAP PO, cubo BW, etc.) es:
// 1. entrada en CONNECTOR_CATALOG (form + test),
// 2. adapter acá (normalize + read),
// 3. el ingest/scheduler lo usan sin tocar otro código.
// La config guardada en data_sources es SIEMPRE canónica (ver normalizeSourceConfig).
import type { IngestResult } from '../semantic/ingest.js';
import { readRestSource, readSqlSource, readFileSource } from '../semantic/ingest.js';

export interface Adapter {
  kind: string;
  label: string;
  // Convierte config plana del form (catalog fields) a canónica para ingest.
  normalize: (flat: Record<string, unknown>) => Record<string, unknown>;
  read: (config: Record<string, unknown>) => Promise<IngestResult>;
  // ¿Sus datos pueden refrescarse solos con cron? (csv = no: hay que subir archivo).
  refreshable: boolean;
}

const enc = (s: string) => encodeURIComponent(s);

const sqlConnectionString = (kind: string, c: Record<string, unknown>): string => {
  if (kind === 'odbc') return String(c.connectionString || '');
  const host = String(c.host || 'localhost');
  const port = c.port || (kind === 'mysql' ? 3306 : kind === 'mssql' ? 1433 : 5432);
  const db = String(c.database || '');
  const user = String(c.user || '');
  const pass = String(c.password || '');
  const proto = kind === 'mysql' ? 'mysql' : kind === 'mssql' ? 'sqlserver' : 'postgres';
  return `${proto}://${enc(user)}:${enc(pass)}@${host}:${port}/${enc(db)}`;
};

const parseKv = (v: unknown): Record<string, string> => {
  if (!v) return {};
  if (typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k.trim()) out[k.trim()] = String(val ?? '');
    }
    return out;
  }
  const out: Record<string, string> = {};
  const text = String(v);
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') return parseKv(obj);
  } catch {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

const normalizeSql = (kind: string) => (flat: Record<string, unknown>) => ({
  ...flat,
  ingestKind: kind,
  query: String(flat.query || ''),
  connectionString: sqlConnectionString(kind, flat),
});

const normalizeRest = (flat: Record<string, unknown>) => {
  const headers = parseKv(flat.headers);
  return {
    ...flat,
    method: String(flat.method || 'GET').toUpperCase(),
    // Forma anidada que entiende readRestSource + plana para el test.
    auth: {
      type: String(flat.authType || 'none'),
      token: String(flat.token || ''),
      user: String(flat.user || ''),
      headers,
    },
    headers,
    pagination: {
      type: String(flat.pagination || 'none'),
      pageSize: Number(flat.pageSize) || 100,
      maxPages: Number(flat.maxPages) || 10,
    },
  };
};

export const ADAPTERS: Adapter[] = [
  { kind: 'postgres', label: 'PostgreSQL', normalize: normalizeSql('postgres'), read: (c) => readSqlSource(c as never), refreshable: true },
  { kind: 'mysql', label: 'MySQL', normalize: normalizeSql('mysql'), read: (c) => readSqlSource(c as never), refreshable: true },
  { kind: 'mssql', label: 'SQL Server', normalize: normalizeSql('mssql'), read: (c) => readSqlSource(c as never), refreshable: true },
  { kind: 'odbc', label: 'ODBC', normalize: normalizeSql('odbc'), read: (c) => readSqlSource(c as never), refreshable: true },
  { kind: 'rest', label: 'API REST', normalize: normalizeRest, read: (c) => readRestSource(c as never), refreshable: true },
  { kind: 'csv', label: 'CSV/Excel', normalize: (f) => ({ ...f }), read: (c) => readFileSource(String(c.filePath || (c as { filename?: string }).filename || ''), (c as { sheet?: string | number }).sheet), refreshable: false },
  { kind: 'xlsx', label: 'Excel', normalize: (f) => ({ ...f }), read: (c) => readFileSource(String(c.filePath || (c as { filename?: string }).filename || ''), (c as { sheet?: string | number }).sheet), refreshable: false },
];

export const adapterOf = (kind: string): Adapter | undefined => ADAPTERS.find((a) => a.kind === kind);

// Normaliza antes de guardar en data_sources (datasetAddSource). Si el kind
// no tiene adapter (manual, firestore), guarda la plana tal cual.
export function normalizeSourceConfig(kind: string, flat: Record<string, unknown>): Record<string, unknown> {
  const a = adapterOf(kind);
  if (!a) return { ...(flat || {}) };
  try {
    return a.normalize({ ...(flat || {}) });
  } catch {
    return { ...(flat || {}) };
  }
}
