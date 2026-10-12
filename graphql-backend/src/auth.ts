// Identidad: igual que el stack viejo.
// - MSAL ON: Bearer JWT verificado contra JWKS (jose, con caché).
// - MSAL OFF (dev): x-user-email directo.
// Reutiliza AZURE_TENANT_ID / AZURE_CLIENT_ID / MSAL_ENABLED del .env.
import * as jose from 'jose';

function msalEnabled(): boolean {
  const v = String(process.env.MSAL_ENABLED || 'ON').toUpperCase();
  return !['OFF', 'FALSE', '0', 'DISABLED'].includes(v);
}

let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
function getJwks(tenant: string) {
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`),
    );
  }
  return jwks;
}

async function verifyMsal(token: string): Promise<string> {
  const tenant = (process.env.AZURE_TENANT_ID || '').trim();
  const client = (process.env.AZURE_CLIENT_ID || '').trim();
  if (!tenant || !client) throw new Error('MSAL no configurado');
  const { payload } = await jose.jwtVerify(token, getJwks(tenant), {
    audience: client,
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    clockTolerance: 60,
  });
  const email = String(
    (payload as Record<string, unknown>).preferred_username ||
      (payload as Record<string, unknown>).upn ||
      (payload as Record<string, unknown>).email ||
      '',
  ).trim().toLowerCase();
  if (!email) throw new Error('Token sin email');
  return email;
}

export interface CtxHeaders {
  authorization?: string;
  'x-user-email'?: string;
}

import { verifyLocalToken } from './auth-local.js';

/** Resuelve el email del caller o lanza 401.
 * - MSAL ON: solo Bearer MSAL válido.
 * - MSAL OFF (dev): Bearer local (scrypt/jose) o x-user-email; sin nada,
 *   dev abierto como el stack viejo. */
export async function callerEmail(headers: CtxHeaders): Promise<string> {
  const h = String(headers.authorization || '');
  const m = /^bearer\s+(.+)$/i.exec(h);
  if (m) {
    const token = m[1].trim();
    // MSAL y login propio conviven (igual que el stack viejo): se prueba
    // MSAL primero y cae a local si hay JWT_SECRET.
    if (msalEnabled()) {
      try {
        return await verifyMsal(token);
      } catch {
        return verifyLocalToken(token);
      }
    }
    try {
      return await verifyLocalToken(token);
    } catch {
      // cae al dev abierto de abajo
    }
  }
  if (!msalEnabled()) {
    const dev = String(headers['x-user-email'] || '').trim().toLowerCase();
    if (dev) return dev;
    return devDefault();
  }
  throw Object.assign(new Error('No autorizado: falta Bearer válido.'), { status: 401 });
}

/** Usuario dev por defecto cuando MSAL está OFF y no hay header. */
export function devDefault(): string {
  return (process.env.DEV_EMAIL || 'dev@local').trim().toLowerCase();
}
