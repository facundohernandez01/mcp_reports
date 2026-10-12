// Envío de emails (SMTP configurable desde /admin/config). Nodemailer puro,
// sin dependencias pesadas. La config vive en creador_db (mail_config),
// nunca en el frontend.
import nodemailer from 'nodemailer';
import { pool } from './db.js';

export interface MailConfig {
  provider: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export async function getMailConfig(): Promise<MailConfig | null> {
  try {
    const { rows } = await pool.query('SELECT * FROM mail_config WHERE id = 1');
    if (!rows.length || !rows[0].host) return null;
    return rows[0] as MailConfig;
  } catch {
    return null;
  }
}

export async function maskedMailConfig(): Promise<Record<string, unknown> | null> {
  const c = await getMailConfig();
  if (!c) return null;
  return { ...c, pass: c.pass ? '••••••••' : '' };
}

function transporterFor(c: MailConfig) {
  return nodemailer.createTransport({
    host: c.host,
    port: Number(c.port) || 587,
    secure: !!c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });
}

export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const c = await getMailConfig();
  if (!c) throw new Error('Email no configurado (ver /admin/config).');
  const t = transporterFor(c);
  await t.sendMail({ from: c.from || c.user, to, subject, text, html });
}

export async function testMail(to: string): Promise<{ ok: boolean; detail: string }> {
  const t0 = Date.now();
  await sendMail(to, 'Creador v2 · email de prueba', 'Si leés esto, el envío anda.');
  return { ok: true, detail: `Enviado en ${Date.now() - t0}ms` };
}
