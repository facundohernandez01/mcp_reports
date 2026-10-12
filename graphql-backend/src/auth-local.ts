// Portado de builder/src/app/lib/auth-local.ts (stack viejo). Scrypt+jose.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

// Login propio (email + password de la DB) conviviendo con MSAL.
// Sin JWT_SECRET = deshabilitado (solo MSAL). Scrypt+jose, sin dependencias nuevas.

export function localEnabled(): boolean {
  return Boolean((process.env.JWT_SECRET || "").trim());
}

function secret(): Uint8Array {
  return new TextEncoder().encode((process.env.JWT_SECRET || "").trim());
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, { N: 16384 }).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [kind, salt, hash] = String(stored || "").split("$");
    if (kind !== "scrypt" || !salt || !hash) return false;
    const check = scryptSync(password, salt, 64, { N: 16384 });
    const a = Buffer.from(check.toString("hex"));
    const b = Buffer.from(hash);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export async function signLocalToken(email: string): Promise<string> {
  return new SignJWT({ auth: "local", email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret());
}

export async function verifyLocalToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(String(token || "").trim(), secret(), {
    algorithms: ["HS256"],
  });
  if ((payload as any).auth !== "local") throw new Error("no es un token local");
  const email = String((payload as any).email || payload.sub || "").trim().toLowerCase();
  if (!email) throw new Error("token sin email");
  return email;
}
