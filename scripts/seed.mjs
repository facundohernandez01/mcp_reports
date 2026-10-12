// Seed v2 desde el stack viejo: published JSON + rawData del modelo.
// Uso: node scripts/seed.mjs (con el backend en :4001 y MSAL OFF).
// Idempotente (upsert por slug).
import fs from 'node:fs';

const GQL = process.env.GQL_URL || 'http://localhost:4001/graphql';
const ROOT = '/home/facundo/constructor_reportes_mcp_BACKUP';

async function gql(query, variables, user) {
  const r = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-email': user },
    body: JSON.stringify({ query, variables }),
  });
  const p = await r.json();
  if (!r.ok || p.errors) throw new Error(JSON.stringify(p.errors || p).slice(0, 300));
  return p.data;
}

const UPSERT = `mutation($slug:String!,$title:String,$spec:JSON,$isPublished:Boolean) {
  upsertReport(slug:$slug,title:$title,spec:$spec,isPublished:$isPublished){ slug title }
}`;

// --- powerbiejemplo (template canónico): spec publicada + filas estáticas + KPIs con medida.
global.window = {};
const model = (await import(`${ROOT}/builder/src/components/chartia/powerBiInvoiceModel.js`)).default;
const pubPbi = JSON.parse(fs.readFileSync(`${ROOT}/builder/src/components/chartia/published/powerbiejemplo.json`, 'utf8'));
const kpiMeasure = { total: ['importeTotal', 'sum'], neto: ['importeNetoGravado', 'sum'], iva: ['iva', 'sum'], comprobantes: ['cantidadComprobantes', 'sum'] };
const specPbi = {
  ...pubPbi,
  datasetId: null,
  staticRows: model.rawData,
  staticColumns: model.table?.columns || [],
  kpis: (pubPbi.kpis || []).map((k) => ({ operation: 'sum', ...k, ...(kpiMeasure[k.id] ? { measure: kpiMeasure[k.id][0], operation: kpiMeasure[k.id][1] } : {}) })),
};
await gql(UPSERT, { slug: 'powerbiejemplo', title: 'PowerBI Ejemplo (template)', spec: specPbi, isPublished: true }, 'dev@local');
console.log('seed powerbiejemplo OK, filas:', model.rawData.length);

// --- elecciones: spec publicada + dataset vivo del stack viejo.
const pubEle = JSON.parse(fs.readFileSync(`${ROOT}/builder/src/components/chartia/published/elecciones-presidenciales-argentina.json`, 'utf8'));
const specEle = { ...pubEle, datasetId: 'ds_mur105k4n5' };
await gql(UPSERT, { slug: 'elecciones-presidenciales-argentina', title: 'Elecciones presidenciales 2023', spec: specEle, isPublished: true }, 'facundo.hernandez@contratosac.com.ar');
console.log('seed elecciones OK');
