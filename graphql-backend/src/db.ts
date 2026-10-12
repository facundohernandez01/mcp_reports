// Pool PG + auto-migración estilo ensureSchema (igual que el stack viejo).
// DB nueva `creador_db` en el MISMO Postgres: el stack viejo no se toca.
// Todo lo de estructura variable (spec de reporte, drafts, dataset specs,
// filas ingestas) va en JSONB; ownership/shares/locks relacional.
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'creador_db',
  password: process.env.DB_PASSWORD || '123123',
  port: Number(process.env.DB_PORT || 5432),
  max: 10,
});

export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      rol TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reports (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      owner_email TEXT NOT NULL REFERENCES users(email) ON DELETE RESTRICT,
      is_published BOOLEAN NOT NULL DEFAULT false,
      spec JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS report_shares (
      report_slug TEXT NOT NULL REFERENCES reports(slug) ON DELETE CASCADE,
      shared_with_email TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'view',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (report_slug, shared_with_email, permission)
    );
    CREATE TABLE IF NOT EXISTS report_drafts (
      slug TEXT NOT NULL,
      user_email TEXT NOT NULL,
      state JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (slug, user_email)
    );
    CREATE TABLE IF NOT EXISTS report_versions (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL REFERENCES reports(slug) ON DELETE CASCADE,
      snapshot JSONB NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS report_locks (
      report_id TEXT PRIMARY KEY,
      locked_by TEXT NOT NULL,
      locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS report_opens (
      slug TEXT NOT NULL,
      user_email TEXT NOT NULL,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      open_count INT NOT NULL DEFAULT 1,
      PRIMARY KEY (slug, user_email)
    );
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      owner_email TEXT NOT NULL DEFAULT '',
      spec JSONB NOT NULL DEFAULT '{}',
      spec_version INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS publish_jobs (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress INT NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS groups TEXT[] NOT NULL DEFAULT '{}'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      permissions JSONB NOT NULL DEFAULT '{"config":false,"spool":false,"users":false}',
      groups TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_email, profile_id)
    );
    CREATE TABLE IF NOT EXISTS mail_config (
      id INT PRIMARY KEY DEFAULT 1,
      provider TEXT NOT NULL DEFAULT 'custom',
      host TEXT NOT NULL DEFAULT '',
      port INT NOT NULL DEFAULT 587,
      secure BOOLEAN NOT NULL DEFAULT false,
      "user" TEXT NOT NULL DEFAULT '',
      pass TEXT NOT NULL DEFAULT '',
      "from" TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function ensureUser(email: string, name?: string) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  await pool.query(
    `INSERT INTO users (email, name, rol) VALUES ($1, $2, 'user')
     ON CONFLICT (email) DO NOTHING`,
    [em, name || em],
  );
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [em]);
  return rows[0] || null;
}

export async function isAdmin(email: string): Promise<boolean> {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return false;
  const { rows } = await pool.query('SELECT rol FROM users WHERE email = $1', [em]);
  return String(rows[0]?.rol || '').toLowerCase() === 'admin';
}
