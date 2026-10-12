// Schema v2 code-first (Pothos). Todo lo flexible es escalar JSON (JSONB).
// Fase 0: lecturas + saveDraft + subscriptions básicas. El resto crece acá.
import SchemaBuilder from '@pothos/core';
import { createPubSub, filter, pipe } from 'graphql-yoga';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pool, ensureUser, isAdmin } from './db.js';
import { getLegacyDataset, readRecordsSimple, legacyPool, ensureDatasetShares } from './legacy.js';
import { hashPassword, localEnabled, signLocalToken, verifyPassword } from './auth-local.js';
import { getMailConfig, maskedMailConfig, sendMail, testMail } from './mailer.js';
import { CONNECTOR_CATALOG, connectorKindOf } from './connectors/catalog.js';
import { testConnector } from './connectors/test.js';
import { ensureIngestSchema, ingestSource, materializeDataset, runDatasetJob, claimDatasetJob } from './semantic/ingest.js';

export interface Ctx {
  email: string;
}

export const pubsub = createPubSub<{
  reportUpdated: [{ slug: string }];
  publishProgress: [{ jobId: string; slug: string; status: string; progress: number; message: string }];
}>();

const builder = new SchemaBuilder<{
  Context: Ctx;
  Scalars: { JSON: { Input: unknown; Output: unknown } };
}>({});

// Escalar JSON libre (specs, drafts, snapshots, filas).
const JsonScalar = builder.scalarType('JSON', {
  serialize: (v) => v,
  parseValue: (v) => v,
});

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

type Row = Record<string, any>;
const ReportRef = builder.objectRef<Row>('Report').implement({
  fields: (t) => ({
    slug: t.string({ resolve: (r) => String(r.slug ?? '') }),
    title: t.string({ resolve: (r) => String(r.title ?? '') }),
    ownerEmail: t.string({ resolve: (r) => String(r.owner_email ?? '') }),
    isPublished: t.boolean({ resolve: (r) => r.is_published !== false }),
    isTemplate: t.boolean({ resolve: (r) => r.is_template === true }),
    groups: t.field({ type: ['String'], resolve: (r) => (Array.isArray(r.groups) ? r.groups : []) as string[] }),
    // Permiso propio: owner | edit | view | none (admin = owner a efectos).
    myPermission: t.string({
      resolve: async (r, _args, ctx) => {
        const em = String(ctx.email || '').trim().toLowerCase();
        if (!em) return 'none';
        if (r.owner_email === em || (await isAdmin(em))) return 'owner';
        const { rows } = await pool.query(
          'SELECT permission FROM report_shares WHERE report_slug = $1 AND shared_with_email = $2',
          [r.slug, em],
        );
        if (!rows.length) return 'none';
        return rows.some((x) => x.permission === 'edit') ? 'edit' : 'view';
      },
    }),
    spec: t.field({ type: JsonScalar, resolve: (r) => (r.spec ?? {}) as unknown }),
    updatedAt: t.string({ nullable: true, resolve: (r) => str(r.updated_at) }),
  }),
});

const ShareRef = builder.objectRef<Row>('Share').implement({
  fields: (t) => ({
    slug: t.string({ resolve: (r) => String(r.report_slug ?? '') }),
    email: t.string({ resolve: (r) => String(r.shared_with_email ?? '') }),
    permission: t.string({ resolve: (r) => String(r.permission ?? '') }),
  }),
});

const DatasetRef = builder.objectRef<Row>('Dataset').implement({
  fields: (t) => ({
    id: t.string({ resolve: (r) => String(r.id ?? '') }),
    slug: t.string({ resolve: (r) => String(r.slug ?? '') }),
    name: t.string({ resolve: (r) => String(r.name ?? '') }),
    specVersion: t.int({ resolve: (r) => Number(r.spec_version ?? 1) }),
    spec: t.field({ type: JsonScalar, resolve: (r) => (r.spec ?? {}) as unknown }),
  }),
});

const PublishJobRef = builder.objectRef<Row>('PublishJob').implement({
  fields: (t) => ({
    id: t.string({ resolve: (r) => String(r.id ?? '') }),
    slug: t.string({ resolve: (r) => String(r.slug ?? '') }),
    status: t.string({ resolve: (r) => String(r.status ?? '') }),
    progress: t.int({ resolve: (r) => Number(r.progress ?? 0) }),
    message: t.string({ resolve: (r) => String(r.message ?? '') }),
    createdBy: t.string({ resolve: (r) => String(r.created_by ?? ''), nullable: true }),
    createdAt: t.string({ resolve: (r) => str(r.created_at), nullable: true }),
  }),
});

// Permisos de DATASET independientes del reporte: editar un reporte NO da
// derecho a editar sus datasets (hay que compartir ambos). Regla:
// - dataset sin owner: abierto salvo que tenga shares (compat legacy);
// - con owner: owner, admin o edit-share explícito.
async function canEditDataset(ds: { id: string; owner_email: string }, email: string): Promise<boolean> {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return false;
  if (await isAdmin(em)) return true;
  if (ds.owner_email && ds.owner_email === em) return true;
  await ensureDatasetShares();
  const { rows } = await legacyPool.query(
    `SELECT 1 FROM dataset_shares WHERE dataset_id = $1 AND shared_with_email = $2 AND permission = 'edit'`,
    [ds.id, em],
  );
  if (rows.length) return true;
  if (!ds.owner_email) {
    const any = await legacyPool.query('SELECT 1 FROM dataset_shares WHERE dataset_id = $1 LIMIT 1', [ds.id]);
    if (!any.rows.length) return true;
  }
  return false;
}

async function visibleSlugs(email: string): Promise<Set<string>> {
  const groups = await userGroups(email);
  const { rows } = await pool.query(
    `SELECT slug FROM reports WHERE owner_email = $1
     UNION SELECT report_slug FROM report_shares WHERE shared_with_email = $1
     UNION SELECT slug FROM reports WHERE groups && $2`,
    [email, groups],
  );
  return new Set(rows.map((r) => r.slug));
}

// Permisos efectivos: rol admin lo puede todo; si no, unión de perfiles
// (config/spool/users + grupos de reportes, ej. finanzas).
async function userPermissions(email: string): Promise<{ admin: boolean; config: boolean; spool: boolean; users: boolean; groups: string[] }> {
  const em = String(email || '').trim().toLowerCase();
  if (await isAdmin(em)) return { admin: true, config: true, spool: true, users: true, groups: [] };
  try {
    const { rows } = await pool.query(
      `SELECT p.permissions, p.groups FROM user_profiles up JOIN profiles p ON p.id = up.profile_id WHERE up.user_email = $1`,
      [em],
    );
    const out = { admin: false, config: false, spool: false, users: false, groups: [] as string[] };
    for (const r of rows) {
      const pm = (r.permissions || {}) as Record<string, boolean>;
      if (pm.config) out.config = true;
      if (pm.spool) out.spool = true;
      if (pm.users) out.users = true;
      for (const g of r.groups || []) if (g && !out.groups.includes(g)) out.groups.push(g);
    }
    return out;
  } catch {
    return { admin: false, config: false, spool: false, users: false, groups: [] };
  }
}

async function userGroups(email: string): Promise<string[]> {
  return (await userPermissions(email)).groups;
}

async function canDo(email: string, perm: 'config' | 'spool' | 'users'): Promise<boolean> {
  return (await userPermissions(email))[perm];
}

async function setJob(id: string, patch: { status?: string; progress?: number; message?: string }) {
  const { rows } = await pool.query('SELECT * FROM publish_jobs WHERE id = $1', [id]);
  if (!rows.length) return null;
  const job = rows[0];
  const status = patch.status ?? job.status;
  const progress = patch.progress ?? job.progress;
  const message = patch.message ?? job.message;
  await pool.query(
    `UPDATE publish_jobs SET status = $2, progress = $3, message = $4, finished_at = CASE WHEN $2 IN ('success','failed','cancelled') THEN now() ELSE finished_at END WHERE id = $1`,
    [id, status, progress, message],
  );
  pubsub.publish('publishProgress', { jobId: id, slug: job.slug, status, progress, message });
  return { ...job, status, progress, message };
}

// Worker del spooler (patrón stack viejo: CLAIM con SKIP LOCKED, un job por
// vez). Lo dispara el enqueue y un intervalo en server.ts por si queda algo.
export async function processQueue(): Promise<void> {
  const client = await pool.connect();
  let job: any = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM publish_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (rows.length) {
      job = rows[0];
      await client.query(`UPDATE publish_jobs SET status = 'running', progress = 10, message = 'Publicando…' WHERE id = $1`, [job.id]);
    }
    await client.query('COMMIT');
  } catch {
    try { await client.query('ROLLBACK'); } catch {}
  } finally {
    // Sin finally, la rama "cola vacía" fugaba un cliente por poll hasta
    // agotar el pool (10) y colgar TODO el backend. Fue el bug del home.
    client.release();
  }
  if (!job) return;
  pubsub.publish('publishProgress', { jobId: job.id, slug: job.slug, status: 'running', progress: 10, message: 'Publicando…' });
  try {
    const spec = await pool.query('SELECT spec FROM reports WHERE slug = $1', [job.slug]);
    if (!spec.rows.length) throw new Error('Reporte inexistente.');
    await setJob(job.id, { progress: 60, message: 'Congelando versión…' });
    const vid = `v_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    await pool.query('INSERT INTO report_versions (id, slug, snapshot, created_by) VALUES ($1, $2, $3, $4)', [
      vid,
      job.slug,
      JSON.stringify(spec.rows[0].spec || {}),
      job.created_by,
    ]);
    await pool.query('UPDATE reports SET is_published = true, updated_at = now() WHERE slug = $1', [job.slug]);
    await setJob(job.id, { status: 'success', progress: 100, message: 'Publicado.' });
    pubsub.publish('reportUpdated', { slug: job.slug });
  } catch (e) {
    await setJob(job.id, { status: 'failed', progress: 100, message: e instanceof Error ? e.message : String(e) });
  }
  // Encadenar: si quedó otro encolado, seguir sin esperar el intervalo.
  void processQueue().catch(() => {});
}

const STALE_LOCK_MIN = 15;

builder.queryType({
  fields: (t) => ({
    me: t.string({
      nullable: true,
      resolve: (_root, _args, ctx) => ctx.email || null,
    }),
    reports: t.field({
      type: [ReportRef],
      resolve: async (_root, _args, ctx) => {
        // Templates canónicos (solo MCP por slug directo + referencia):
        // nunca listan para nadie, ni owner.
        const groups = await userGroups(ctx.email);
        const { rows } = await pool.query(
          `SELECT r.* FROM reports r WHERE NOT COALESCE(r.is_template, false) AND (r.owner_email = $1
           OR EXISTS (SELECT 1 FROM report_shares s WHERE s.report_slug = r.slug AND s.shared_with_email = $1)
           OR r.groups && $2)
           ORDER BY r.slug`,
          [ctx.email, groups],
        );
        return rows;
      },
    }),
    report: t.field({
      type: ReportRef,
      nullable: true,
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ok = await visibleSlugs(ctx.email);
        if (!ok.has(args.slug) && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Sin acceso.'), { status: 403 });
        }
        const { rows } = await pool.query('SELECT * FROM reports WHERE slug = $1', [args.slug]);
        return rows[0] || null;
      },
    }),
    datasets: t.field({
      type: [DatasetRef],
      resolve: async () => {
        const { rows } = await pool.query('SELECT * FROM datasets ORDER BY name');
        return rows;
      },
    }),
    // Lista legacy (crud_db): el editor v2 trabaja sobre estos datasets.
    legacyDatasets: t.field({
      type: JsonScalar,
      resolve: async (_root, _args, ctx) => {
        const { rows } = await legacyPool.query('SELECT id, slug, name, spec_version, owner_email FROM datasets ORDER BY name');
        const out = [];
        for (const r of rows) {
          out.push({ ...r, can_edit: await canEditDataset(r, ctx.email) });
        }
        return out;
      },
    }),
    // Fase 1 renderer: spec + filas desde crud_db (stack viejo). Sin acceso
    // si el dataset tiene owner distinto y no sos admin (igual que el viejo).
    legacyDataset: t.field({
      type: DatasetRef,
      nullable: true,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) return null;
        if (ds.owner_email && ds.owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Sin acceso a este dataset.'), { status: 403 });
        }
        return { id: ds.id, slug: ds.slug, name: ds.name, spec_version: ds.spec_version, spec: ds.spec };
      },
    }),
    legacyRecords: t.field({
      type: JsonScalar,
      args: {
        id: t.arg.string({ required: true }),
        tableId: t.arg.string(),
        limit: t.arg.int(),
        offset: t.arg.int(),
      },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (ds.owner_email && ds.owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Sin acceso a este dataset.'), { status: 403 });
        }
        return readRecordsSimple(args.id, args.tableId || '', args.limit || 1000, args.offset || 0);
      },
    }),
    publishJobs: t.field({
      type: [PublishJobRef],
      args: { slug: t.arg.string() },
      resolve: async (_root, args) => {
        const { rows } = args.slug
          ? await pool.query('SELECT * FROM publish_jobs WHERE slug = $1 ORDER BY created_at DESC LIMIT 20', [args.slug])
          : await pool.query('SELECT * FROM publish_jobs ORDER BY created_at DESC LIMIT 20');
        return rows;
      },
    }),
    amAdmin: t.boolean({
      resolve: async (_root, _args, ctx) => isAdmin(ctx.email),
    }),
    // Login propio (igual que el stack viejo): JWT 12h si hay JWT_SECRET.
    authLocalEnabled: t.boolean({
      resolve: async () => localEnabled(),
    }),
    myProfile: t.field({
      type: JsonScalar,
      resolve: async (_root, _args, ctx) => {
        const me = await ensureUser(ctx.email);
        return { email: me.email, name: me.name || me.email.split('@')[0], rol: me.rol };
      },
    }),
    // Catálogo de conectores (igual que el viejo; data-driven).
    connectorCatalog: t.field({
      type: JsonScalar,
      resolve: async () => CONNECTOR_CATALOG,
    }),
    connectors: t.field({
      type: JsonScalar,
      resolve: async () => {
        await legacyPool.query(`CREATE TABLE IF NOT EXISTS connectors (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        const { rows } = await legacyPool.query('SELECT id, name, kind, updated_at FROM connectors ORDER BY updated_at DESC');
        return rows;
      },
    }),
    datasetSources: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso de edición en este dataset (independiente del reporte).'), { status: 403 });
        }
        await ensureIngestSchema();
        const { rows } = await legacyPool.query('SELECT id, kind, name, updated_at FROM data_sources WHERE dataset_id = $1 ORDER BY created_at', [ds.id]);
        return rows;
      },
    }),
    recents: t.field({
      type: JsonScalar,
      resolve: async (_root, _args, ctx) => {
        const { rows } = await pool.query(
          `SELECT r.slug, r.title, r.owner_email, r.is_published, o.opened_at, o.open_count
           FROM report_opens o JOIN reports r ON r.slug = o.slug
           WHERE o.user_email = $1 AND NOT COALESCE(r.is_template, false) ORDER BY o.opened_at DESC LIMIT 8`,
          [ctx.email],
        );
        return rows.map((r) => ({ ...r, opened_at: str(r.opened_at) }));
      },
    }),
    // Admin de usuarios (igual que /admin/usuarios del stack viejo).
    users: t.field({
      type: JsonScalar,
      resolve: async (_root, _args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso de gestión de usuarios.'), { status: 403 });
        }
        const { rows } = await pool.query(
          `SELECT u.email, u.name, u.rol, (u.password_hash <> '') AS has_password, u.created_at,
                  COALESCE(array_agg(up.profile_id) FILTER (WHERE up.profile_id IS NOT NULL), '{}') AS profiles
           FROM users u LEFT JOIN user_profiles up ON up.user_email = u.email
           GROUP BY u.email ORDER BY u.email`);
        return rows.map((r) => ({ ...r, created_at: str(r.created_at) }));
      },
    }),
    // Permisos efectivos propios (para gating de sidebar/páginas).
    myPermissions: t.field({
      type: JsonScalar,
      resolve: async (_root, _args, ctx) => userPermissions(ctx.email),
    }),
    // Perfiles de acceso (ej. finanzas): permisos de admin + grupos de reportes.
    profiles: t.field({
      type: JsonScalar,
      resolve: async (_root, _args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        const { rows } = await pool.query(
          `SELECT p.id, p.name, p.permissions, p.groups,
                  COALESCE(array_agg(up.user_email) FILTER (WHERE up.user_email IS NOT NULL), '{}') AS members
           FROM profiles p LEFT JOIN user_profiles up ON up.profile_id = p.id
           GROUP BY p.id ORDER BY p.name`);
        return rows;
      },
    }),
    // Borrador propio (para retomar edición). Null si no hay.
    draft: t.field({
      type: JsonScalar,
      nullable: true,
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows } = await pool.query('SELECT state, updated_at FROM report_drafts WHERE slug = $1 AND user_email = $2', [args.slug, ctx.email]);
        if (!rows.length) return null;
        return { state: rows[0].state, updated_at: str(rows[0].updated_at) };
      },
    }),
    // Borradores abiertos de un reporte (owner/admin): para no pisar trabajo
    // sin publicar al editar (humano o MCP).
    openDrafts: t.field({
      type: JsonScalar,
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows: rep } = await pool.query('SELECT owner_email FROM reports WHERE slug = $1', [args.slug]);
        if (!rep.length) throw new Error('Reporte inexistente.');
        if (rep[0].owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        const { rows } = await pool.query(
          'SELECT user_email, updated_at FROM report_drafts WHERE slug = $1 ORDER BY updated_at DESC',
          [args.slug],
        );
        return rows.map((r) => ({ user_email: r.user_email, updated_at: str(r.updated_at) }));
      },
    }),
    reportVersions: t.field({
      type: JsonScalar,
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ok = await visibleSlugs(ctx.email);
        if (!ok.has(args.slug) && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Sin acceso.'), { status: 403 });
        }
        const { rows } = await pool.query(
          'SELECT id, created_by, created_at FROM report_versions WHERE slug = $1 ORDER BY created_at DESC LIMIT 20',
          [args.slug],
        );
        return rows.map((r) => ({ ...r, created_at: str(r.created_at) }));
      },
    }),
    // Con quién está compartido un reporte (owner/admin). Para gestionar permisos.
    reportShares: t.field({
      type: JsonScalar,
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows: rep } = await pool.query('SELECT owner_email FROM reports WHERE slug = $1', [args.slug]);
        if (!rep.length) throw new Error('Reporte inexistente.');
        if (rep[0].owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        const { rows } = await pool.query(
          'SELECT shared_with_email AS email, permission, created_at FROM report_shares WHERE report_slug = $1 ORDER BY shared_with_email',
          [args.slug],
        );
        return rows.map((r) => ({ ...r, created_at: str(r.created_at) }));
      },
    }),
    // Todos los reportes (gestión de grupos por perfil; incluye templates
    // marcados para distinguirlos).
    allReports: t.field({
      type: JsonScalar,
      resolve: async (_root, _args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        const { rows } = await pool.query(
          'SELECT slug, title, owner_email, is_published, is_template, groups FROM reports ORDER BY slug');
        return rows;
      },
    }),
    // Estado del sistema para el menú Config (permiso config). Sin secretos.
    systemStatus: t.field({
      type: JsonScalar,
      resolve: async (_root, _args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'config'))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        const [rep, ds, usr, jobs, vers] = await Promise.all([
          pool.query('SELECT COUNT(*)::int AS n FROM reports'),
          legacyPool.query('SELECT COUNT(*)::int AS n FROM datasets'),
          pool.query('SELECT COUNT(*)::int AS n FROM users'),
          pool.query(`SELECT COUNT(*)::int AS n FROM publish_jobs WHERE status IN ('queued','running')`),
          pool.query('SELECT COUNT(*)::int AS n FROM report_versions'),
        ]);
        return {
          reports: rep.rows[0].n,
          datasets: ds.rows[0].n,
          users: usr.rows[0].n,
          jobsActive: jobs.rows[0].n,
          versions: vers.rows[0].n,
          msal: String(process.env.MSAL_ENABLED || 'ON').toUpperCase() !== 'OFF',
          local: localEnabled(),
          uptimeSec: Math.round(process.uptime()),
          node: process.version,
        };
      },
    }),
    // Email: config SMTP (solo admin, clave enmascarada).
    mailConfig: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: async (_root, _args, ctx) => {
        if (!(await isAdmin(ctx.email))) throw Object.assign(new Error('Solo admin.'), { status: 403 });
        return maskedMailConfig();
      },
    }),
    // Lock de edición (igual que el stack viejo): un editor por reporte.
    // Stale >15min sin heartbeat se puede tomar.
    lockStatus: t.field({
      type: JsonScalar,
      nullable: true,
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args) => {
        const { rows } = await pool.query('SELECT * FROM report_locks WHERE report_id = $1', [args.slug]);
        return rows[0] || null;
      },
    }),
    // Schedules de un dataset (lectura; había quedado en Mutation y el
    // listado nunca andaba).
    datasetSchedules: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        await ensureIngestSchema();
        const { rows } = await legacyPool.query('SELECT id, cron, enabled, next_run_at, last_status FROM refresh_schedules WHERE dataset_id = $1 ORDER BY created_at', [ds.id]);
        return rows;
      },
    }),
    // Historial global de jobs de datasets (permiso spool): ver qué actualizó,
    // qué falló y con qué error técnico, en todos los datasets.
    datasetJobsRecent: t.field({
      type: JsonScalar,
      args: { limit: t.arg.int() },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'spool'))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        await ensureIngestSchema();
        const lim = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
        const { rows } = await legacyPool.query(
          `SELECT j.id, j.dataset_id, d.slug AS dataset_slug, d.name AS dataset_name, j.kind,
                  j.status, j.error, j.created_by, j.created_at, j.finished_at
           FROM dataset_jobs j LEFT JOIN datasets d ON d.id = j.dataset_id
           ORDER BY j.created_at DESC LIMIT $1`,
          [lim],
        );
        return rows;
      },
    }),
    // Historial de jobs de UN dataset (ver si corrió / dio error).
    datasetJobs: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        await ensureIngestSchema();
        const { rows } = await legacyPool.query(
          `SELECT id, kind, status, error, created_by, created_at, finished_at FROM dataset_jobs
           WHERE dataset_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [ds.id],
        );
        return rows;
      },
    }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    // Crea o actualiza el spec JSON de un reporte (el agente genera JSON,
    // nunca archivos: sin builds ni efímeros).
    upsertReport: t.field({
      type: ReportRef,
      args: {
        slug: t.arg.string({ required: true }),
        title: t.arg.string(),
        spec: t.arg({ type: JsonScalar }),
        isPublished: t.arg.boolean(),
        isTemplate: t.arg.boolean(),
        groups: t.arg({ type: ['String'] }),
      },
      resolve: async (_root, args, ctx) => {
        await ensureUser(ctx.email);
        const slug = args.slug.trim().toLowerCase();
        const groups = Array.isArray(args.groups) ? (args.groups as string[]).map((g) => String(g).trim().toLowerCase()).filter(Boolean).slice(0, 20) : undefined;
        const existing = await pool.query('SELECT owner_email FROM reports WHERE slug = $1', [slug]);
        if (existing.rows.length) {
          const own = existing.rows[0].owner_email === ctx.email || (await isAdmin(ctx.email));
          if (!own) {
            // Share de edición: puede actualizar spec/título, pero NO flags
            // (publicado/template/grupos son del owner/admin).
            const { rows: sh } = await pool.query(
              `SELECT 1 FROM report_shares WHERE report_slug = $1 AND shared_with_email = $2 AND permission = 'edit'`,
              [slug, ctx.email],
            );
            if (!sh.length) throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
            const { rows } = await pool.query(
              `UPDATE reports SET title = COALESCE($2, title), spec = COALESCE($3, spec), updated_at = now()
               WHERE slug = $1 RETURNING *`,
              [slug, args.title ?? null, args.spec === undefined ? null : JSON.stringify(args.spec)],
            );
            pubsub.publish('reportUpdated', { slug });
            return rows[0];
          }
          const { rows } = await pool.query(
            `UPDATE reports SET title = COALESCE($2, title), spec = COALESCE($3, spec),
             is_published = COALESCE($4, is_published), is_template = COALESCE($5, is_template),
             groups = COALESCE($6, groups), updated_at = now()
             WHERE slug = $1 RETURNING *`,
            [slug, args.title ?? null, args.spec === undefined ? null : JSON.stringify(args.spec), args.isPublished ?? null, args.isTemplate ?? null, groups ?? null],
          );
          pubsub.publish('reportUpdated', { slug });
          return rows[0];
        }
        const { rows } = await pool.query(
          `INSERT INTO reports (slug, title, owner_email, spec, is_published, is_template, groups) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [slug, args.title || slug, ctx.email, JSON.stringify(args.spec ?? {}), args.isPublished ?? false, args.isTemplate ?? false, groups ?? []],
        );
        pubsub.publish('reportUpdated', { slug });
        return rows[0];
      },
    }),
    // Borra reporte + borradores, versiones, shares, locks y jobs (owner/admin).
    reportDelete: t.field({
      type: 'Boolean',
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows } = await pool.query('SELECT owner_email FROM reports WHERE slug = $1', [args.slug]);
        if (!rows.length) throw new Error('Reporte inexistente.');
        if (rows[0].owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        await pool.query('DELETE FROM report_shares WHERE report_slug = $1', [args.slug]);
        await pool.query('DELETE FROM report_drafts WHERE slug = $1', [args.slug]);
        await pool.query('DELETE FROM report_versions WHERE slug = $1', [args.slug]);
        await pool.query('DELETE FROM report_locks WHERE report_id = $1', [args.slug]);
        await pool.query('DELETE FROM publish_jobs WHERE slug = $1', [args.slug]);
        await pool.query('DELETE FROM report_opens WHERE slug = $1', [args.slug]);
        await pool.query('DELETE FROM reports WHERE slug = $1', [args.slug]);
        return true;
      },
    }),
    saveDraft: t.field({
      type: 'Boolean',
      args: { slug: t.arg.string({ required: true }), state: t.arg({ type: JsonScalar, required: true }) },
      resolve: async (_root, args, ctx) => {
        await pool.query(
          `INSERT INTO report_drafts (slug, user_email, state, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (slug, user_email) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [args.slug, ctx.email, JSON.stringify(args.state ?? {})],
        );
        pubsub.publish('reportUpdated', { slug: args.slug });
        return true;
      },
    }),
    shareReport: t.field({
      type: 'Boolean',
      args: {
        slug: t.arg.string({ required: true }),
        email: t.arg.string({ required: true }),
        permission: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const { rows } = await pool.query('SELECT owner_email FROM reports WHERE slug = $1', [args.slug]);
        if (!rows.length) throw new Error('Reporte inexistente.');
        if (rows[0].owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        if (!['view', 'edit'].includes(args.permission)) throw new Error('permission view|edit.');
        await ensureUser(args.email);
        await pool.query(
          `INSERT INTO report_shares (report_slug, shared_with_email, permission) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [args.slug, args.email.trim().toLowerCase(), args.permission],
        );
        return true;
      },
    }),
    reportUnshare: t.field({
      type: 'Boolean',
      args: { slug: t.arg.string({ required: true }), email: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows } = await pool.query('SELECT owner_email FROM reports WHERE slug = $1', [args.slug]);
        if (!rows.length) throw new Error('Reporte inexistente.');
        if (rows[0].owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        await pool.query('DELETE FROM report_shares WHERE report_slug = $1 AND shared_with_email = $2', [
          args.slug,
          args.email.trim().toLowerCase(),
        ]);
        return true;
      },
    }),
    // Publicar en v2 = congelar versión + marcar publicado. Sin builds:
    // el renderer pinta el spec, así que publicar es instantáneo.
    // Paso cola: encola el job; el worker lo procesa en segundos (igual que
    // el spooler del stack viejo: si varios publican a la vez, se serian).
    publishReport: t.field({
      type: JsonScalar,
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows } = await pool.query('SELECT owner_email FROM reports WHERE slug = $1', [args.slug]);
        if (!rows.length) throw new Error('Reporte inexistente.');
        if (rows[0].owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        const id = `job_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
        await pool.query(
          `INSERT INTO publish_jobs (id, slug, status, progress, message, created_by) VALUES ($1, $2, 'queued', 0, 'Encolado', $3)`,
          [id, args.slug, ctx.email],
        );
        pubsub.publish('publishProgress', { jobId: id, slug: args.slug, status: 'queued', progress: 0, message: 'Encolado' });
        void processQueue().catch(() => {});
        return { jobId: id, status: 'queued' };
      },
    }),
    setPublished: t.field({
      type: 'Boolean',
      args: { slug: t.arg.string({ required: true }), published: t.arg.boolean({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows } = await pool.query('SELECT owner_email FROM reports WHERE slug = $1', [args.slug]);
        if (!rows.length) throw new Error('Reporte inexistente.');
        if (rows[0].owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        await pool.query('UPDATE reports SET is_published = $2, updated_at = now() WHERE slug = $1', [args.slug, args.published]);
        pubsub.publish('reportUpdated', { slug: args.slug });
        return true;
      },
    }),
    // Locks de edición: tomar / latir / soltar. Stale >15min se puede tomar.
    acquireLock: t.field({
      type: JsonScalar,
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows } = await pool.query('SELECT * FROM report_locks WHERE report_id = $1', [args.slug]);
        const cur = rows[0];
        if (cur) {
          if (cur.locked_by === ctx.email) {
            await pool.query('UPDATE report_locks SET heartbeat_at = now() WHERE report_id = $1', [args.slug]);
            return { mine: true, lockedBy: ctx.email };
          }
          const stale = Date.now() - new Date(cur.heartbeat_at).getTime() > STALE_LOCK_MIN * 60 * 1000;
          if (!stale) return { mine: false, lockedBy: cur.locked_by };
        }
        await pool.query(
          `INSERT INTO report_locks (report_id, locked_by, locked_at, heartbeat_at) VALUES ($1, $2, now(), now())
           ON CONFLICT (report_id) DO UPDATE SET locked_by = $2, locked_at = now(), heartbeat_at = now()`,
          [args.slug, ctx.email],
        );
        return { mine: true, lockedBy: ctx.email };
      },
    }),
    heartbeatLock: t.field({
      type: 'Boolean',
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        await pool.query('UPDATE report_locks SET heartbeat_at = now() WHERE report_id = $1 AND locked_by = $2', [args.slug, ctx.email]);
        return true;
      },
    }),
    releaseLock: t.field({
      type: 'Boolean',
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const admin = await isAdmin(ctx.email);
        if (admin) await pool.query('DELETE FROM report_locks WHERE report_id = $1', [args.slug]);
        else await pool.query('DELETE FROM report_locks WHERE report_id = $1 AND locked_by = $2', [args.slug, ctx.email]);
        return true;
      },
    }),
    cancelPublishJob: t.field({
      type: 'Boolean',
      args: { jobId: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows } = await pool.query('SELECT * FROM publish_jobs WHERE id = $1', [args.jobId]);
        if (!rows.length) throw new Error('Job inexistente.');
        const { rows: rep } = await pool.query('SELECT owner_email FROM reports WHERE slug = $1', [rows[0].slug]);
        if (rep[0]?.owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        await pool.query(`UPDATE publish_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued'`, [args.jobId]);
        pubsub.publish('publishProgress', { jobId: args.jobId, slug: rows[0].slug, status: 'cancelled', progress: 0, message: 'Cancelado.' });
        return true;
      },
    }),
    // Edición de spec de dataset legacy (editor v2): versionado optimista.
    updateDatasetSpec: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }), baseVersion: t.arg.int({ required: true }), spec: t.arg({ type: JsonScalar, required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso de edición en este dataset (owner, admin o edit-share).'), { status: 403 });
        }
        const cur = await legacyPool.query('SELECT spec_version FROM datasets WHERE id = $1', [ds.id]);
        if ((cur.rows[0]?.spec_version || 0) !== args.baseVersion) {
          throw Object.assign(new Error('Conflicto: el spec cambió (releer).'), { status: 409 });
        }
        const { rows } = await legacyPool.query(
          'UPDATE datasets SET spec = $2, spec_version = spec_version + 1, updated_at = now() WHERE id = $1 RETURNING spec_version',
          [ds.id, JSON.stringify(args.spec ?? {})],
        );
        return { spec_version: rows[0].spec_version };
      },
    }),
    restoreVersion: t.field({
      type: 'Boolean',
      args: { versionId: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows } = await pool.query(
          `SELECT v.snapshot, r.owner_email, r.slug FROM report_versions v
           JOIN reports r ON r.slug = v.slug WHERE v.id = $1`,
          [args.versionId],
        );
        if (!rows.length) throw new Error('Versión inexistente.');
        if (rows[0].owner_email !== ctx.email && !(await isAdmin(ctx.email))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        await pool.query('UPDATE reports SET spec = $2, updated_at = now() WHERE slug = $1', [
          rows[0].slug,
          JSON.stringify(rows[0].snapshot || {}),
        ]);
        pubsub.publish('reportUpdated', { slug: rows[0].slug });
        return true;
      },
    }),
    // Login propio (igual que el stack viejo): JWT 12h si hay JWT_SECRET.
    authLoginLocal: t.field({
      type: JsonScalar,
      args: { email: t.arg.string({ required: true }), password: t.arg.string({ required: true }) },
      resolve: async (_root, args) => {
        if (!localEnabled()) throw Object.assign(new Error('Login propio deshabilitado (falta JWT_SECRET).'), { status: 403 });
        const email = String(args.email || '').trim().toLowerCase();
        if (!email || !args.password) throw Object.assign(new Error('Faltan email o clave.'), { status: 400 });
        const { rows } = await pool.query('SELECT email, rol, password_hash FROM users WHERE email = $1', [email]);
        if (!rows[0]?.password_hash || !verifyPassword(args.password, rows[0].password_hash)) {
          throw Object.assign(new Error('Credenciales inválidas.'), { status: 401 });
        }
        const token = await signLocalToken(email);
        return { token, email: rows[0].email, rol: rows[0].rol };
      },
    }),
    authSetPassword: t.field({
      type: 'Boolean',
      args: { email: t.arg.string({ required: true }), password: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso de gestión de usuarios.'), { status: 403 });
        }
        if (!localEnabled() || String(args.password || '').length < 8) throw new Error('Clave mínima 8 (y JWT_SECRET).');
        await ensureUser(args.email);
        await pool.query('UPDATE users SET password_hash = $2 WHERE email = $1', [args.email.trim().toLowerCase(), hashPassword(args.password)]);
        return true;
      },
    }),
    // Guardar config SMTP (solo admin). pass vacío = conserva la anterior.
    mailSave: t.field({
      type: 'Boolean',
      args: {
        provider: t.arg.string(), host: t.arg.string(), port: t.arg.int(),
        secure: t.arg.boolean(), user: t.arg.string(), pass: t.arg.string(), from: t.arg.string(),
      },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email))) throw Object.assign(new Error('Solo admin.'), { status: 403 });
        const cur = await getMailConfig();
        await pool.query(
          `INSERT INTO mail_config (id, provider, host, port, secure, "user", pass, "from", updated_at)
           VALUES (1, $1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (id) DO UPDATE SET provider = $1, host = $2, port = $3, secure = $4,
             "user" = $5, pass = CASE WHEN $6 = '' THEN mail_config.pass ELSE $6 END, "from" = $7, updated_at = now()`,
          [
            String(args.provider || cur?.provider || 'custom').slice(0, 20),
            String(args.host || '').slice(0, 200),
            Number(args.port) || 587,
            !!args.secure,
            String(args.user || '').slice(0, 200),
            String(args.pass ?? ''),
            String(args.from || args.user || '').slice(0, 200),
          ],
        );
        return true;
      },
    }),
    mailTest: t.field({
      type: JsonScalar,
      args: { to: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email))) throw Object.assign(new Error('Solo admin.'), { status: 403 });
        return testMail(args.to.trim().toLowerCase());
      },
    }),
    // Recuperación de clave por email (siempre true para no enumerar).
    authForgot: t.field({
      type: 'Boolean',
      args: { email: t.arg.string({ required: true }) },
      resolve: async (_root, args) => {
        const email = String(args.email || '').trim().toLowerCase();
        try {
          const { rows } = await pool.query('SELECT email FROM users WHERE email = $1', [email]);
          if (!rows.length) return true;
          const cfg = await getMailConfig();
          if (!cfg) return true;
          const token = randomBytes(32).toString('base64url');
          await pool.query(
            `INSERT INTO password_resets (token, email, expires_at) VALUES ($1, $2, now() + interval '1 hour')
             ON CONFLICT (token) DO NOTHING`,
            [token, email],
          );
          const base = (process.env.PUBLIC_BASE_URL || process.env.CHARTIA_EXTERNAL_BASE_URL || 'http://localhost:4321').replace(/\/+$/, '');
          await sendMail(
            email,
            'Creador v2 · recuperá tu clave',
            `Pediste recuperar tu clave. Entrá acá (vale 1 hora):\n${base}/login?reset=${token}\nSi no fuiste vos, ignorá este mail.`,
            `<p>Pediste recuperar tu clave. <a href="${base}/login?reset=${token}">Entrá acá</a> (vale 1 hora).</p><p>Si no fuiste vos, ignorá este mail.</p>`,
          );
        } catch {}
        return true;
      },
    }),
    authReset: t.field({
      type: 'Boolean',
      args: { token: t.arg.string({ required: true }), password: t.arg.string({ required: true }) },
      resolve: async (_root, args) => {
        if (!localEnabled() || String(args.password || '').length < 8) throw new Error('Clave mínima 8.');
        const { rows } = await pool.query('SELECT email FROM password_resets WHERE token = $1 AND expires_at > now()', [String(args.token)]);
        if (!rows.length) throw new Error('Token inválido o vencido.');
        await pool.query('UPDATE users SET password_hash = $2 WHERE email = $1', [rows[0].email, hashPassword(args.password)]);
        await pool.query('DELETE FROM password_resets WHERE token = $1', [String(args.token)]);
        return true;
      },
    }),
    setUserRole: t.field({
      type: 'Boolean',
      args: { email: t.arg.string({ required: true }), rol: t.arg.string({ required: true }) },      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso de gestión de usuarios.'), { status: 403 });
        }
        if (!['admin', 'user', 'viewer'].includes(args.rol)) throw new Error('rol inválido.');
        await ensureUser(args.email);
        await pool.query('UPDATE users SET rol = $2 WHERE email = $1', [args.email.trim().toLowerCase(), args.rol]);
        return true;
      },
    }),
    deleteUser: t.field({
      type: 'Boolean',
      args: { email: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso de gestión de usuarios.'), { status: 403 });
        }
        const target = args.email.trim().toLowerCase();
        if (target === ctx.email) throw new Error('No podés eliminarte.');
        await pool.query('DELETE FROM users WHERE email = $1', [target]);
        return true;
      },
    }),
    // Crear usuario: email + rol + clave local opcional (crea + asigna).
    userCreate: t.field({
      type: 'Boolean',
      args: { email: t.arg.string({ required: true }), rol: t.arg.string(), password: t.arg.string() },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso de gestión de usuarios.'), { status: 403 });
        }
        const email = args.email.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Email inválido.');
        await ensureUser(email);
        if (args.rol) {
          if (!['admin', 'user', 'viewer'].includes(args.rol)) throw new Error('rol inválido.');
          await pool.query('UPDATE users SET rol = $2 WHERE email = $1', [email, args.rol]);
        }
        if (args.password) {
          if (!localEnabled() || String(args.password).length < 8) throw new Error('Clave mínima 8 (y JWT_SECRET).');
          await pool.query('UPDATE users SET password_hash = $2 WHERE email = $1', [email, hashPassword(args.password)]);
        }
        return true;
      },
    }),
    profileCreate: t.field({
      type: JsonScalar,
      args: { name: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        const id = `prof_${Date.now().toString(36)}`;
        await pool.query('INSERT INTO profiles (id, name) VALUES ($1, $2)', [id, args.name.slice(0, 80)]);
        return { id };
      },
    }),
    profileUpdate: t.field({
      type: 'Boolean',
      args: { id: t.arg.string({ required: true }), permissions: t.arg({ type: JsonScalar }), groups: t.arg({ type: ['String'] }) },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        const pm = (args.permissions || {}) as Record<string, boolean>;
        const clean = { config: !!pm.config, spool: !!pm.spool, users: !!pm.users };
        const groups = Array.isArray(args.groups) ? (args.groups as string[]).map((g) => String(g).trim().toLowerCase()).filter(Boolean).slice(0, 30) : undefined;
        if (groups === undefined) {
          await pool.query('UPDATE profiles SET permissions = $2 WHERE id = $1', [args.id, JSON.stringify(clean)]);
        } else {
          await pool.query('UPDATE profiles SET permissions = $2, groups = $3 WHERE id = $1', [args.id, JSON.stringify(clean), groups]);
        }
        return true;
      },
    }),
    profileDelete: t.field({
      type: 'Boolean',
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        await pool.query('DELETE FROM profiles WHERE id = $1', [args.id]);
        return true;
      },
    }),
    profileAssign: t.field({
      type: 'Boolean',
      args: { profileId: t.arg.string({ required: true }), email: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        await ensureUser(args.email);
        await pool.query('INSERT INTO user_profiles (user_email, profile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [args.email.trim().toLowerCase(), args.profileId]);
        return true;
      },
    }),
    profileUnassign: t.field({
      type: 'Boolean',
      args: { profileId: t.arg.string({ required: true }), email: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        if (!(await isAdmin(ctx.email)) && !(await canDo(ctx.email, 'users'))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        await pool.query('DELETE FROM user_profiles WHERE user_email = $1 AND profile_id = $2', [args.email.trim().toLowerCase(), args.profileId]);
        return true;
      },
    }),
    connectorSave: t.field({
      type: JsonScalar,
      args: { name: t.arg.string({ required: true }), kind: t.arg.string({ required: true }), config: t.arg({ type: JsonScalar, required: true }), id: t.arg.string() },
      resolve: async (_root, args, ctx) => {
        if (!connectorKindOf(args.kind)) throw new Error(`kind desconocido: ${args.kind}`);
        await legacyPool.query(`CREATE TABLE IF NOT EXISTS connectors (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        if (args.id) {
          await legacyPool.query('UPDATE connectors SET name = $2, config = $3, updated_at = now() WHERE id = $1', [args.id, args.name.slice(0, 80), JSON.stringify(args.config || {})]);
          return { id: args.id };
        }
        const id = `conn_${Date.now().toString(36)}`;
        await legacyPool.query('INSERT INTO connectors (id, name, kind, config) VALUES ($1, $2, $3, $4)', [id, args.name.slice(0, 80), args.kind, JSON.stringify(args.config || {})]);
        return { id };
      },
    }),
    connectorDelete: t.field({
      type: 'Boolean',
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args) => {
        await legacyPool.query('DELETE FROM connectors WHERE id = $1', [args.id]);
        return true;
      },
    }),
    connectorTest: t.field({
      type: JsonScalar,
      args: { kind: t.arg.string({ required: true }), config: t.arg({ type: JsonScalar, required: true }) },
      resolve: async (_root, args) => {
        try {
          return await testConnector(args.kind, (args.config || {}) as Record<string, unknown>);
        } catch (e) {
          return { ok: false, ms: 0, detail: e instanceof Error ? e.message : String(e) };
        }
      },
    }),
    connectorTables: t.field({
      type: JsonScalar,
      args: { kind: t.arg.string({ required: true }), config: t.arg({ type: JsonScalar, required: true }) },
      resolve: async (_root, args) => {
        const c = (args.config || {}) as Record<string, unknown>;
        const qid = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
        if (args.kind === 'postgres') {
          const { Pool } = await import('pg');
          const p = new Pool({ user: String(c.user || ''), host: String(c.host || 'localhost'), database: String(c.database || ''), password: String(c.password || ''), port: Number(c.port || 5432), connectionTimeoutMillis: 15000 });
          try {
            const r = await p.query(`SELECT schemaname || '.' || tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1 LIMIT 200`);
            return r.rows.map((x: { name: string }) => x.name);
          } finally { await p.end().catch(() => {}); }
        }
        if (args.kind === 'mysql') {
          const mysql = await import('mysql2/promise');
          const conn = await mysql.createConnection({ host: String(c.host || 'localhost'), port: Number(c.port || 3306), database: String(c.database || ''), user: String(c.user || ''), password: String(c.password || ''), connectTimeout: 15000 });
          try {
            const [rows] = (await conn.query('SHOW FULL TABLES WHERE TABLE_TYPE LIKE ?', ['%BASE TABLE%'])) as unknown as [Array<Record<string, string>>];
            return rows.map((r) => String(Object.values(r)[0] || '')).filter(Boolean).slice(0, 200);
          } finally { await conn.end().catch(() => {}); }
        }
        if (args.kind === 'mssql') {
          const tedious = (await import('tedious')) as any;
          const cfg = { server: String(c.host || 'localhost'), authentication: { type: 'default', options: { userName: String(c.user || ''), password: String(c.password || '') } }, options: { database: String(c.database || ''), port: Number(c.port || 1433), encrypt: false, trustServerCertificate: true, connectTimeout: 15000 } };
          const conn = new tedious.Connection(cfg);
          await new Promise<void>((res, rej) => { conn.on('connect', (e: unknown) => (e ? rej(e) : res())); conn.connect(); });
          try {
            const rows: Array<Record<string, string>> = await new Promise((res, rej) => {
              const out: Array<Record<string, string>> = [];
              const req = new tedious.Request("SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY 1", (e: unknown) => (e ? rej(e) : res(out)));
              req.on('row', (cols: Array<{ value: unknown }>) => out.push({ name: String(cols[0]?.value || '') }));
              conn.execSql(req);
            });
            return rows.map((r) => r.name).filter(Boolean).slice(0, 200);
          } finally { conn.close(); }
        }
        throw new Error(`tables no soportado para kind ${args.kind} (usar SQL manual o CSV).`);
      },
    }),
    datasetAddSource: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }), kind: t.arg.string({ required: true }), name: t.arg.string(), config: t.arg({ type: JsonScalar }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso de edición en este dataset (independiente del reporte).'), { status: 403 });
        }
        await ensureIngestSchema();
        // Config canónica vía adapters (connectionString/query, auth anidada…).
        const { normalizeSourceConfig } = await import('./connectors/adapter.js');
        const canonical = normalizeSourceConfig(String(args.kind), (args.config || {}) as Record<string, unknown>);
        const id = `src_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
        await legacyPool.query('INSERT INTO data_sources (id, dataset_id, kind, name, config) VALUES ($1, $2, $3, $4, $5)', [
          id, ds.id, args.kind, args.name || args.kind, JSON.stringify(canonical),
        ]);
        return { id };
      },
    }),
    datasetUploadCsv: t.field({
      type: JsonScalar,
      args: { filename: t.arg.string({ required: true }), contentBase64: t.arg.string({ required: true }) },
      resolve: async (_root, args) => {
        const base = path.basename(String(args.filename || '').trim());
        if (!/\.(csv|xlsx|xls|xlsm)$/i.test(base)) throw new Error('Solo .csv/.xlsx/.xls/.xlsm');
        const b64 = String(args.contentBase64 || '').replace(/^data:[^;]+;base64,/, '');
        if (!b64) throw new Error('contentBase64 vacío.');
        if (b64.length > 25 * 1024 * 1024 * 1.4) throw new Error('Máx 25MB.');
        const dir = process.env.UPLOADS_DIR || '/srv/uploads';
        fs.mkdirSync(dir, { recursive: true });
        const full = path.join(dir, base);
        fs.writeFileSync(full, Buffer.from(b64, 'base64'));
        return { filename: base, path: full, bytes: fs.statSync(full).size };
      },
    }),
    // Subir imagen para widgets (máx 5MB). Se sirve en /uploads/<file>.
    assetUpload: t.field({
      type: JsonScalar,
      args: { filename: t.arg.string({ required: true }), contentBase64: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        await ensureUser(ctx.email);
        const base = path.basename(String(args.filename || '').trim()).replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(base)) throw new Error('Solo imágenes (png/jpg/gif/webp/svg).');
        const b64 = String(args.contentBase64 || '').replace(/^data:[^;]+;base64,/, '');
        if (!b64) throw new Error('contentBase64 vacío.');
        if (b64.length > 5 * 1024 * 1024 * 1.4) throw new Error('Máx 5MB.');
        const dir = process.env.UPLOADS_DIR || '/srv/uploads';
        fs.mkdirSync(dir, { recursive: true });
        const stamped = `${Date.now().toString(36)}_${base}`;
        fs.writeFileSync(path.join(dir, stamped), Buffer.from(b64, 'base64'));
        return { filename: stamped, url: `/uploads/${stamped}` };
      },
    }),
    datasetIngest: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }), sourceId: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso de edición en este dataset (independiente del reporte).'), { status: 403 });
        }
        const { ingestSource } = await import('./semantic/ingest.js');
        return ingestSource(ds.id, args.sourceId, { createdBy: ctx.email });
      },
    }),
    datasetMaterialize: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso de edición en este dataset (independiente del reporte).'), { status: 403 });
        }
        const { materializeDataset } = await import('./semantic/ingest.js');
        return materializeDataset(ds.id);
      },
    }),
    // Crea un dataset vacío (el agente lo usa para CSVs/APIs nuevos).
    datasetCreate: t.field({
      type: JsonScalar,
      args: { name: t.arg.string({ required: true }), slug: t.arg.string() },
      resolve: async (_root, args, ctx) => {
        const slug = String(args.slug || args.name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80) || `ds-${Date.now().toString(36)}`;
        const id = `ds_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
        await ensureIngestSchema();
        await legacyPool.query(
          `INSERT INTO datasets (id, slug, name, owner_email, spec, spec_version, status, created_by) VALUES ($1, $2, $3, $4, $5, 1, 'draft', $4)
           ON CONFLICT (id) DO NOTHING`,
          [id, slug, args.name, ctx.email, JSON.stringify({ name: args.name, tables: [], relations: [], measures: [], version: 1 })],
        );
        return { id, slug };
      },
    }),
    // Crea una tabla vinculada a una fuente (columnas inferidas).
    datasetCreateTable: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }), sourceId: t.arg.string({ required: true }), tableName: t.arg.string() },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso de edición en este dataset (independiente del reporte).'), { status: 403 });
        }
        const { createTableFromSource } = await import('./semantic/ingest.js');
        return createTableFromSource(ds.id, args.sourceId, args.tableName || 'Tabla');
      },
    }),
    // Borra un dataset completo (owner/admin). Ojo: reportes que lo usan
    // quedan sin datos (se avisa en la UI).
    datasetDelete: t.field({
      type: 'Boolean',
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!((ds.owner_email && ds.owner_email === ctx.email) || (await isAdmin(ctx.email)))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        await legacyPool.query('DELETE FROM datasets WHERE id = $1', [ds.id]);
        return true;
      },
    }),
    // Compartir dataset (independiente del reporte).
    datasetShares: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        await ensureDatasetShares();
        const { rows } = await legacyPool.query('SELECT shared_with_email AS email, permission FROM dataset_shares WHERE dataset_id = $1 ORDER BY shared_with_email', [ds.id]);
        return rows;
      },
    }),
    datasetShare: t.field({
      type: 'Boolean',
      args: { id: t.arg.string({ required: true }), email: t.arg.string({ required: true }), permission: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!((ds.owner_email && ds.owner_email === ctx.email) || (await isAdmin(ctx.email)))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        if (!['view', 'edit'].includes(args.permission)) throw new Error('permission view|edit.');
        await ensureDatasetShares();
        await legacyPool.query(
          `INSERT INTO dataset_shares (dataset_id, shared_with_email, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [ds.id, args.email.trim().toLowerCase(), args.permission],
        );
        return true;
      },
    }),
    datasetUnshare: t.field({
      type: 'Boolean',
      args: { id: t.arg.string({ required: true }), email: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!((ds.owner_email && ds.owner_email === ctx.email) || (await isAdmin(ctx.email)))) {
          throw Object.assign(new Error('Solo owner/admin.'), { status: 403 });
        }
        await ensureDatasetShares();
        await legacyPool.query('DELETE FROM dataset_shares WHERE dataset_id = $1 AND shared_with_email = $2', [ds.id, args.email.trim().toLowerCase()]);
        return true;
      },
    }),
    // Reingesta: reemplaza el archivo de una fuente file (csv/xlsx) por una
    // versión nueva y re-ingesta. Para APIs: refresh programado (schedules).
    datasetReplaceFile: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }), sourceId: t.arg.string({ required: true }), filename: t.arg.string({ required: true }), contentBase64: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso de edición en este dataset (independiente del reporte).'), { status: 403 });
        }
        const base = path.basename(String(args.filename || '').trim());
        if (!/\.(csv|xlsx|xls|xlsm)$/i.test(base)) throw new Error('Solo .csv/.xlsx/.xls/.xlsm');
        const b64 = String(args.contentBase64 || '').replace(/^data:[^;]+;base64,/, '');
        if (!b64) throw new Error('contentBase64 vacío.');
        const dir = process.env.UPLOADS_DIR || '/srv/uploads';
        fs.mkdirSync(dir, { recursive: true });
        const full = path.join(dir, base);
        fs.writeFileSync(full, Buffer.from(b64, 'base64'));
        await legacyPool.query(`UPDATE data_sources SET config = config || $3, updated_at = now() WHERE id = $1 AND dataset_id = $2`, [args.sourceId, ds.id, JSON.stringify({ filePath: full, filename: base })]);
        const { ingestSource } = await import('./semantic/ingest.js');
        const out = await ingestSource(ds.id, args.sourceId, { createdBy: ctx.email });
        return { ...out, filename: base };
      },
    }),
    datasetAddSchedule: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }), cron: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso de edición en este dataset (independiente del reporte).'), { status: 403 });
        }
        await ensureIngestSchema();
        const sid = `sch_${Date.now().toString(36)}`;
        await legacyPool.query('INSERT INTO refresh_schedules (id, dataset_id, cron) VALUES ($1, $2, $3)', [sid, ds.id, args.cron]);
        return { id: sid };
      },
    }),
    datasetDeleteSchedule: t.field({
      type: 'Boolean',
      args: { scheduleId: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows } = await legacyPool.query('SELECT dataset_id FROM refresh_schedules WHERE id = $1', [args.scheduleId]);
        if (!rows.length) throw new Error('Schedule inexistente.');
        const ds = await getLegacyDataset(rows[0].dataset_id);
        if (!ds || !(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        await legacyPool.query('DELETE FROM refresh_schedules WHERE id = $1', [args.scheduleId]);
        return true;
      },
    }),
    // Pausar/reanudar un schedule sin borrarlo.
    datasetToggleSchedule: t.field({
      type: 'Boolean',
      args: { scheduleId: t.arg.string({ required: true }), enabled: t.arg.boolean({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const { rows } = await legacyPool.query('SELECT dataset_id FROM refresh_schedules WHERE id = $1', [args.scheduleId]);
        if (!rows.length) throw new Error('Schedule inexistente.');
        const ds = await getLegacyDataset(rows[0].dataset_id);
        if (!ds || !(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        await legacyPool.query('UPDATE refresh_schedules SET enabled = $2 WHERE id = $1', [args.scheduleId, args.enabled]);
        return true;
      },
    }),
    // Ejecutar actualización ahora (encola rebuild: re-ingesta + materializa).
    datasetRefreshNow: t.field({
      type: JsonScalar,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const ds = await getLegacyDataset(args.id);
        if (!ds) throw Object.assign(new Error('Dataset no encontrado'), { status: 404 });
        if (!(await canEditDataset(ds, ctx.email))) {
          throw Object.assign(new Error('Sin permiso.'), { status: 403 });
        }
        await ensureIngestSchema();
        const jid = `job_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
        await legacyPool.query(
          `INSERT INTO dataset_jobs (id, dataset_id, kind, payload, created_by) VALUES ($1, $2, 'rebuild', '{}', $3)`,
          [jid, ds.id, ctx.email],
        );
        const { datasetWorkerTick } = await import('./semantic/ingest.js');
        void datasetWorkerTick().catch(() => {});
        return { id: jid };
      },
    }),
    // Recientes (igual que el home viejo): se registra al abrir un publicado.
    trackOpen: t.field({
      type: 'Boolean',
      args: { slug: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        await pool.query(
          `INSERT INTO report_opens (slug, user_email, opened_at, open_count) VALUES ($1, $2, now(), 1)
           ON CONFLICT (slug, user_email) DO UPDATE SET opened_at = now(), open_count = report_opens.open_count + 1`,
          [args.slug, ctx.email],
        );
        return true;
      },
    }),
  }),
});

builder.subscriptionType({
  fields: (t) => ({
    // Reemplaza el SSE/polling del dock: push de cambios por reporte.
    reportUpdated: t.field({
      type: JsonScalar,
      args: { slug: t.arg.string({ required: true }) },
      subscribe: (_root, args) =>
        pipe(
          pubsub.subscribe('reportUpdated'),
          filter((payload: { slug: string }) => payload.slug === args.slug),
        ),
      resolve: (payload: { slug: string }) => ({ slug: payload.slug }),
    }),
    // Progreso de la cola para el dock (reemplaza el poll a publish-spooler).
    jobProgress: t.field({
      type: JsonScalar,
      args: { slug: t.arg.string({ required: true }) },
      subscribe: (_root, args) =>
        pipe(
          pubsub.subscribe('publishProgress'),
          filter((p: any) => p?.slug === args.slug),
        ) as any,
      resolve: (p: any) => p,
    }),
  }),
});

export const schema = builder.toSchema();
