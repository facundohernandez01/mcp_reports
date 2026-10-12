// Yoga escucha en PORT (4001 interno). /graphql + /health.
// Todo el estado en Postgres `creador_db` (JSONB lo flexible, relacional el resto).
import { createServer } from 'node:http';
import { createYoga } from 'graphql-yoga';
import { schema } from './schema.js';
import { processQueue } from './schema.js';
import { pool, ensureSchema, ensureUser } from './db.js';
import { callerEmail } from './auth.js';

const PORT = Number(process.env.PORT || 4001);

const yoga = createYoga({
  schema,
  graphqlEndpoint: '/graphql',
  // GraphiQL solo fuera de prod (útil en dev; en prod confunde).
  landingPage: process.env.NODE_ENV !== 'production',
  // Sin esto, un 401/403/400 esperado llega como "Unexpected error" y no se
  // entiende nada (lo que acabás de ver). Enmascara solo lo inesperado (>=500).
  maskedErrors: {
    maskError(error, message) {
      const err = error as { status?: number; originalError?: { status?: number } };
      const status = err?.status ?? err?.originalError?.status;
      if (status && status < 500) return error as Error;
      return new Error(message);
    },
  },
  // Browser directo (Astro dev :4321). En prod, mismo origen vía proxy.
  cors: {
    origin: (process.env.CORS_ORIGINS || 'http://localhost:4321').split(',').map((s) => s.trim()),
  },
  context: async ({ request, params }: any) => {
    // Operaciones públicas (login): sin identidad. Se usa `params` (ya
    // parseado por Yoga): leer el body acá falla porque Yoga lo consumió.
    try {
      const q = String(params?.query || '');
      if (/authLoginLocal|authLocalEnabled/.test(q)) return { email: '' };
    } catch {}
    const headers = {
      authorization: request.headers.get('authorization') || undefined,
      'x-user-email': request.headers.get('x-user-email') || undefined,
    };
    const email = await callerEmail(headers);
    await ensureUser(email);
    return { email };
  },
});

const server = createServer(yoga);

async function main() {
  await ensureSchema();
  try {
    const admin = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (admin) {
      await ensureUser(admin);
      await pool.query(`UPDATE users SET rol = 'admin' WHERE email = $1`, [admin]);
    }
  } catch {}
  server.listen(PORT, () => {
    console.log(`🔷 GraphQL en http://localhost:${PORT}/graphql`);
  });
  // Worker del spooler: por si un enqueue cayó sin disparar proceso.
  if (process.env.PUBLISH_WORKER !== 'OFF') {
    setInterval(() => processQueue().catch(() => {}), 15000);
    setTimeout(() => processQueue().catch(() => {}), 10000);
  }
  // Worker de datasets (ingest/materialize encolados + refresh programados).
  // Igual que el viejo: vencimientos → jobs → claim/skip-locked.
  if (process.env.DATASET_WORKER !== 'OFF') {
    const tick = async () => {
      try {
        const { claimDatasetJob, runDatasetJob, enqueueDueRefreshes } = await import('./semantic/ingest.js');
        await enqueueDueRefreshes().catch(() => 0);
        for (let i = 0; i < 3; i++) {
          const job = await claimDatasetJob().catch(() => null);
          if (!job) break;
          await runDatasetJob(job).catch(() => {});
        }
      } catch {}
    };
    setInterval(tick, 30000);
    setTimeout(tick, 20000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
