// Portado de builder/src/lib/... (stack viejo). Ver notas en cada archivo.
// @ts-nocheck
// Pruebas de conectores (server-side). Cada test devuelve {ok, ms, detail}.
import { createSign } from 'node:crypto';

export interface ConnectorTestResult {
  ok: boolean;
  ms: number;
  detail: string;
}

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new Error(`${label}: timeout ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
};

export async function testPostgres(c: Record<string, unknown>): Promise<ConnectorTestResult> {
  const t0 = Date.now();
  const { Pool } = await import('pg');
  const pool = new Pool({
    host: String(c.host || 'localhost'),
    port: Number(c.port) || 5432,
    database: String(c.database || ''),
    user: String(c.user || ''),
    password: String(c.password || ''),
    connectionTimeoutMillis: 15000,
  });
  try {
    const r = await withTimeout(pool.query('SELECT 1 AS ok, version() AS v'), 20000, 'postgres');
    return { ok: true, ms: Date.now() - t0, detail: `SELECT 1 OK · ${String(r.rows[0]?.v || '').split(' ').slice(0, 2).join(' ')}` };
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function testMysql(c: Record<string, unknown>): Promise<ConnectorTestResult> {
  const t0 = Date.now();
  const mysql = await import('mysql2/promise');
  const conn = await withTimeout(
    mysql.createConnection({
      host: String(c.host || 'localhost'),
      port: Number(c.port) || 3306,
      database: String(c.database || ''),
      user: String(c.user || ''),
      password: String(c.password || ''),
      connectTimeout: 15000,
    }),
    20000,
    'mysql',
  );
  try {
    const [rows] = (await conn.query('SELECT 1 AS ok, VERSION() AS v')) as unknown as [{ ok: number; v: string }[]];
    return { ok: true, ms: Date.now() - t0, detail: `SELECT 1 OK · MySQL ${rows?.[0]?.v || ''}` };
  } finally {
    await conn.end().catch(() => {});
  }
}

export async function testMssql(c: Record<string, unknown>): Promise<ConnectorTestResult> {
  const t0 = Date.now();
  const tedious = (await import('tedious')) as unknown as {
    Connection: new (cfg: Record<string, unknown>) => {
      connect: (cb: (e?: Error) => void) => void;
      close: () => void;
      execSql: (r: unknown) => void;
      on: (ev: string, cb: (...a: never[]) => void) => void;
    };
    Request: new (sql: string, cb: (e: Error | null, count: number, rows: { value: unknown }[][]) => void) => unknown;
  };
  const config = {
    server: String(c.host || 'localhost'),
    authentication: { type: 'default', options: { userName: String(c.user || ''), password: String(c.password || '') } },
    options: {
      port: Number(c.port) || 1433,
      database: String(c.database || ''),
      encrypt: String(c.encrypt ?? 'true') !== 'false',
      trustServerCertificate: true,
      connectTimeout: 15000,
      requestTimeout: 20000,
    },
  };
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const conn = new tedious.Connection(config);
      conn.on('connect', (e) => (e ? reject(e) : resolve()));
      conn.connect(() => {});
      setTimeout(() => {
        try {
          conn.close();
        } catch {}
      }, 25000);
    }),
    22000,
    'mssql',
  );
  // Segunda conexión breve para el SELECT 1 (tedious reutiliza el patrón).
  const conn = new tedious.Connection(config);
  try {
    await new Promise<void>((resolve, reject) => {
      conn.on('connect', (e) => (e ? reject(e) : resolve()));
      conn.connect(() => {});
    });
    const out: { value: unknown }[][] = await new Promise((resolve, reject) => {
      const rows: { value: unknown }[][] = [];
      const req = new tedious.Request('SELECT 1 AS ok', (e, _n, rws) => (e ? reject(e) : resolve(rws || rows)));
      (req as unknown as { on: (ev: string, cb: (cols: { value: unknown }[]) => void) => void }).on('row', (cols) => rows.push(cols));
      conn.execSql(req);
    });
    void out;
    return { ok: true, ms: Date.now() - t0, detail: 'SELECT 1 OK · SQL Server' };
  } finally {
    try {
      conn.close();
    } catch {}
  }
}

export async function testOdbc(c: Record<string, unknown>): Promise<ConnectorTestResult> {
  const t0 = Date.now();
  const odbc = (await import('odbc')) as unknown as {
    connect: (s: string) => Promise<{ query: (q: string) => Promise<unknown[]>; close: () => Promise<void> }>;
  };
  const conn = await withTimeout(odbc.connect(String(c.connectionString || '')), 20000, 'odbc');
  try {
    await conn.query('SELECT 1 AS ok');
    return { ok: true, ms: Date.now() - t0, detail: 'SELECT 1 OK · ODBC' };
  } finally {
    await conn.close().catch(() => {});
  }
}

export function buildRestRequest(c: Record<string, unknown>): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {};
  const extra = (c.headers || {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(extra)) if (k.trim() && String(v ?? '').trim()) headers[k.trim()] = String(v);
  const auth = String(c.authType || 'none');
  if (auth === 'bearer' && c.token) headers.Authorization = `Bearer ${c.token}`;
  else if (auth === 'basic') {
    const t = String(c.token || '');
    const [u, ...rest] = t.includes(':') ? t.split(':') : [String(c.user || ''), t];
    headers.Authorization = `Basic ${Buffer.from(`${u}:${rest.join(':')}`).toString('base64')}`;
  } else if (auth === 'apiKey' && c.token) {
    headers[String(c.apiKeyHeader || 'x-api-key')] = String(c.token);
  }
  const method = String(c.method || 'GET').toUpperCase();
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(20000) };
  if (['POST', 'PUT', 'PATCH'].includes(method) && String(c.body || '').trim()) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    init.body = String(c.body);
  }
  return { url: String(c.url || ''), init };
}

export async function testRest(c: Record<string, unknown>): Promise<ConnectorTestResult> {
  const t0 = Date.now();
  const { url, init } = buildRestRequest(c);
  if (!/^https?:\/\//i.test(url)) throw new Error('URL inválida (http/https).');
  const r = await fetch(url, init);
  const text = await r.text().catch(() => '');
  const ct = r.headers.get('content-type') || '';
  return {
    ok: r.ok,
    ms: Date.now() - t0,
    detail: `HTTP ${r.status} · ${ct.split(';')[0] || 'sin content-type'} · ${text.slice(0, 500)}${text.length > 500 ? '…' : ''}`,
  };
}

const b64url = (s: string): string => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function testFirestore(c: Record<string, unknown>): Promise<ConnectorTestResult> {
  const t0 = Date.now();
  const projectId = String(c.projectId || '').trim();
  const clientEmail = String(c.clientEmail || '').trim();
  const privateKey = String(c.privateKey || '').replace(/\\n/g, '\n');
  const collection = String(c.collection || 'test').trim() || 'test';
  if (!projectId || !clientEmail || !privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('Faltan projectId, clientEmail o privateKey válida.');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = signer.sign(privateKey, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${sig}` }),
    signal: AbortSignal.timeout(20000),
  });
  const tok = (await tokRes.json().catch(() => null)) as { access_token?: string; error_description?: string } | null;
  if (!tok?.access_token) throw new Error(`OAuth: ${tok?.error_description || tokRes.status}`);
  const list = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}?pageSize=1`,
    { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(20000) },
  );
  const body = (await list.json().catch(() => null)) as { documents?: unknown[]; error?: { message?: string } } | null;
  if (!list.ok) throw new Error(`Firestore: ${body?.error?.message || list.status}`);
  return { ok: true, ms: Date.now() - t0, detail: `Colección "${collection}": ${(body?.documents || []).length ? 'con documentos ✓' : 'vacía (conexión OK)'}` };
}

export async function testConnector(kind: string, config: Record<string, unknown>): Promise<ConnectorTestResult> {
  switch (kind) {
    case 'postgres':
      return testPostgres(config);
    case 'mysql':
      return testMysql(config);
    case 'mssql':
      return testMssql(config);
    case 'odbc':
      return testOdbc(config);
    case 'rest':
      return testRest(config);
    case 'firestore':
      return testFirestore(config);
    default:
      throw new Error(`kind desconocido: ${kind}`);
  }
}
