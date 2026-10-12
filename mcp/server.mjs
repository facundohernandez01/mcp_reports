// Creador v2 · MCP sobre GraphQL (puerto 4002 interno, /mcp).
// Diferencia clave vs el stack viejo: el agente NO escribe archivos ni corre
// builds. Crea reportes (spec JSON) y datasets vía GraphQL; el renderer los
// pinta sin compilar. Alcance limitado: reportes + datasets (ver
// AGENT_INSTRUCTIONS.md). Sin HMR, sin efímeros, sin pnpm.
// Env: PORT, GQL_URL (http://backend:4001/graphql), MCP_API_KEY,
// MCP_USER_EMAIL (identidad de servicio para las mutations, owner/admin).
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";

// Superadmin (SOLO humano dueño): deshabilitado salvo SUPERADMIN_EMAIL +
// SUPERADMIN_KEY en el .env. Doble llave: API key del transporte + esta clave
// por llamada. Todo uso queda en los logs del container (auditoría).
// NUNCA poner SUPERADMIN_KEY en la config del agente: se entrega por pedido.
const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || "").trim().toLowerCase();
const SUPERADMIN_KEY = (process.env.SUPERADMIN_KEY || "").trim();
const superadminOn = Boolean(SUPERADMIN_EMAIL && SUPERADMIN_KEY);
function superadminCheck(key, asEmail) {
  if (!superadminOn) return "superadmin deshabilitado (falta SUPERADMIN_EMAIL/KEY).";
  const a = Buffer.from(String(key || ""));
  const b = Buffer.from(SUPERADMIN_KEY);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "clave de superadmin inválida.";
  if (String(asEmail || "").trim().toLowerCase() !== SUPERADMIN_EMAIL) return "solo el dueño puede usarlo.";
  return null;
}
function runCmd(command, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", String(command || "")], {
      cwd: cwd || "/work",
      timeout: Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 600000),
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, signal: err?.signal || null, timedOut: Boolean(err?.killed), stdout: String(stdout || ""), stderr: String(err?.message && !stdout && !stderr ? err.message : stderr || "") });
    });
  });
}

const PORT = Number(process.env.PORT || 4002);
const GQL_URL = (process.env.GQL_URL || "http://backend:4001/graphql").replace(/\/+$/, "");
const MCP_USER_EMAIL = (process.env.MCP_USER_EMAIL || "dev@local").trim().toLowerCase();
// El backend con MSAL ON no acepta x-user-email: el MCP se loguea con login
// propio (scrypt+jose) y usa el Bearer, renovándolo ante un 401.
const MCP_USER_PASSWORD = process.env.MCP_USER_PASSWORD || "";
let serviceToken = "";
async function serviceLogin() {
  if (!MCP_USER_PASSWORD) return "";
  const r = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "mutation($e:String!,$p:String!){ authLoginLocal(email:$e, password:$p) }",
      variables: { e: MCP_USER_EMAIL, p: MCP_USER_PASSWORD },
    }),
  });
  const p = await r.json().catch(() => null);
  serviceToken = p?.data?.authLoginLocal?.token || "";
  return serviceToken;
}

function textResult(t) { return { content: [{ type: "text", text: t }] }; }
function errorResult(m) { return { isError: true, content: [{ type: "text", text: `Error: ${m}` }] }; }
function trunc(t, m = 30000) { const s = String(t ?? ""); return s.length > m ? s.slice(0, m) + `\n...[truncado ${s.length}]` : s; }

async function gql(query, variables, user) {
  const headers = { "Content-Type": "application/json" };
  let usedToken = false;
  if (serviceToken) { headers.Authorization = `Bearer ${serviceToken}`; usedToken = true; }
  else headers["x-user-email"] = user || MCP_USER_EMAIL;
  let r = await fetch(GQL_URL, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  // Con MSAL ON el backend rechaza x-user-email (401 o 500 enmascarado):
  // login propio + un reintento. Solo si aún no se usó token.
  if (!r.ok && !usedToken && MCP_USER_PASSWORD) {
    serviceToken = "";
    await serviceLogin().catch(() => "");
    if (serviceToken) {
      headers.Authorization = `Bearer ${serviceToken}`;
      delete headers["x-user-email"];
      r = await fetch(GQL_URL, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    }
  }
  const p = await r.json().catch(() => null);
  if (!r.ok || p?.errors) throw new Error(p?.errors?.[0]?.message || `HTTP ${r.status}`);
  return p.data;
}

function buildServer() {
  const server = new McpServer({ name: "creador-mcp", version: "1.0.0" }, { capabilities: { logging: {} } });
  const notify = (extra, text, level = "info") => {
    try {
      const payload = { method: "notifications/message", params: { level, logger: "creador-mcp", data: { message: String(text).slice(0, 2000) } } };
      if (extra && typeof extra.sendNotification === "function") {
        const p = extra.sendNotification(payload);
        if (p && typeof p.then === "function") p.catch(() => {});
      }
    } catch {}
  };

  server.tool("server_info", "Info para el agente: base pública, usuario de servicio y cómo previsualizar. LLAMAR PRIMERO.", {},
    async () => {
      const base = (process.env.PUBLIC_BASE_URL || process.env.CHARTIA_EXTERNAL_BASE_URL || "http://localhost:4321").replace(/\/+$/, "");
      return textResult(`externalBaseUrl: ${base}\nserviceUser: ${MCP_USER_EMAIL}\npreviewLink: ${base}/report?slug=<slug>\neditLink: ${base}/report?slug=<slug>&edit=1\nFlujo: crear spec JSON → upsert → previsualizar → publicar lo hace el HUMANO desde el dock.`);
    });

  server.tool("report_list", "Lista reportes visibles (propios + compartidos).", { ownerEmail: z.string().optional() },
    async ({ ownerEmail }) => {
      try {
        const d = await gql('{ reports { slug title ownerEmail isPublished } }', null, ownerEmail);
        const rows = d.reports || [];
        return textResult(rows.length ? rows.map((r) => `${r.slug} | ${r.title || "(sin título)"} | owner:${r.ownerEmail}${r.isPublished ? "" : " | BORRADOR"}`).join("\n") : "(sin reportes)");
      } catch (e) { return errorResult(e.message); }
    });

  server.tool("report_get", "Trae spec JSON completo de un reporte (para editar sobre él, nunca inventar de cero).", { slug: z.string() },
    async ({ slug }) => {
      try {
        const d = await gql('{ report(slug:"' + String(slug).replace(/"/g, '') + '") { slug title ownerEmail isPublished spec } }');
        if (!d.report) throw new Error("No existe o sin acceso.");
        return textResult(JSON.stringify(d.report.spec).slice(0, 60000));
      } catch (e) { return errorResult(e.message); }
    });

  server.tool("report_upsert", "Crea o actualiza un reporte (spec JSON: charts, kpis, tabs, hero, filters, datasetId/staticRows). NUNCA toca UI general. Publicar lo hace el HUMANO (isPublished se ignora).", {
    slug: z.string(), title: z.string().optional().default(""), spec: z.record(z.string(), z.any()), isPublished: z.boolean().optional().default(false), ownerEmail: z.string().optional(),
  }, async ({ slug, title, spec, isPublished, ownerEmail }, extra) => {
    try {
      if (isPublished) notify(extra, `report_upsert: publicar lo hace el humano desde el dock (isPublished ignorado).`);
      notify(extra, `report_upsert: guardando ${slug}…`);
      const d = await gql('mutation($s:String!,$t:String,$sp:JSON,$p:Boolean){ upsertReport(slug:$s,title:$t,spec:$sp,isPublished:$p){ slug title } }',
        { s: String(slug).trim().toLowerCase(), t: title || "", sp: spec || {}, p: false }, ownerEmail);
      notify(extra, `report_upsert: listo`);
      return textResult(`Guardado: ${d.upsertReport.slug}. Previsualizar sin compilar (sin builds en v2).`);
    } catch (e) { notify(extra, `report_upsert: ${e.message}`, "error"); return errorResult(e.message); }
  });

  server.tool("report_share", "Comparte un reporte (view = ver, edit = editar).", {
    slug: z.string(), email: z.string(), permission: z.string().optional().default("view"), ownerEmail: z.string().optional(),
  }, async ({ slug, email, permission, ownerEmail }) => {
    try {
      await gql(`mutation{ shareReport(slug:"${slug}", email:"${email}", permission:"${permission}") }`, null, ownerEmail);
      return textResult(`Compartido ${slug} con ${email} (${permission}).`);
    } catch (e) { return errorResult(e.message); }
  });

  server.tool("report_drafts", "Borradores abiertos de un reporte (quién los tiene sin publicar). LLAMAR ANTES de report_upsert: si hay borradores ajenos más nuevos, avisar al humano y no pisarlos.", {
    slug: z.string(), ownerEmail: z.string().optional(),
  }, async ({ slug, ownerEmail }) => {
    try {
      const d = await gql('{ openDrafts(slug:"' + String(slug).replace(/"/g, '') + '") }', null, ownerEmail);
      const rows = d.openDrafts || [];
      return textResult(rows.length ? rows.map((r) => `${r.user_email} (${r.updated_at})`).join("\n") : "(sin borradores abiertos)");
    } catch (e) { return errorResult(e.message); }
  });

  server.tool("dataset_refresh", "Actualización a demanda: encola rebuild (re-ingesta fuentes refrescables + materializa). Para cron programado, el humano lo agenda en el editor.", {
    id: z.string(), ownerEmail: z.string().optional(),
  }, async ({ id, ownerEmail }, extra) => {
    try {
      notify(extra, `dataset_refresh: encolando ${id}…`);
      const d = await gql('mutation($id:String!){ datasetRefreshNow(id:$id) }', { id }, ownerEmail);
      return textResult(`Encolado: ${d.datasetRefreshNow.id}. Ver estado con dataset_jobs.`);
    } catch (e) { return errorResult(e.message); }
  });

  server.tool("dataset_jobs", "Historial de actualizaciones de un dataset (ver si corrió o dio error).", {
    id: z.string(), ownerEmail: z.string().optional(),
  }, async ({ id, ownerEmail }) => {
    try {
      const d = await gql('{ datasetJobs(id:"' + String(id).replace(/"/g, '') + '") }', null, ownerEmail);
      const rows = d.datasetJobs || [];
      return textResult(rows.length ? rows.map((j) => `${j.id} | ${j.kind} | ${j.status} | por ${j.created_by || "—"} | ${j.created_at || ""}${j.status === "failed" ? ` | ERROR: ${j.error || ""}` : ""}`).join("\n") : "(sin ejecuciones)");
    } catch (e) { return errorResult(e.message); }
  });

  server.tool("dataset_list", "Lista datasets legacy (specs + versión).", {},
    async () => {
      try {
        const d = await gql('{ legacyDatasets }');
        const rows = d.legacyDatasets || [];
        return textResult(rows.length ? rows.map((x) => `${x.id} | ${x.slug} | v${x.spec_version} | ${x.name}`).join("\n") : "(sin datasets)");
      } catch (e) { return errorResult(e.message); }
    });

  server.tool("dataset_get", "Trae spec + versión base de un dataset.", { id: z.string() },
    async ({ id }) => {
      try {
        const d = await gql('{ legacyDataset(id:"' + String(id).replace(/"/g, '') + '") { id slug spec_version spec } }');
        if (!d.legacyDataset) throw new Error("No existe o sin acceso.");
        return textResult(JSON.stringify({ id: d.legacyDataset.id, spec_version: d.legacyDataset.spec_version, spec: d.legacyDataset.spec }).slice(0, 60000));
      } catch (e) { return errorResult(e.message); }
    });

  server.tool("dataset_records", "Filas (cap 200). Nunca trae todo.", {
    id: z.string(), tableId: z.string().optional(), limit: z.number().optional(), offset: z.number().optional(),
  }, async ({ id, tableId, limit, offset }) => {
    try {
      const d = await gql(`{ legacyRecords(id:"${String(id).replace(/"/g, '')}", tableId:"${String(tableId || '').replace(/"/g, '')}", limit:${limit || 50}, offset:${offset || 0}) }`);
      return textResult(JSON.stringify(d.legacyRecords).slice(0, 30000));
    } catch (e) { return errorResult(e.message); }
  });

  server.tool("dataset_update_spec", "Actualiza spec con versionado optimista (baseVersion; 409 si cambió). Tablas, steps, relaciones, renombres.", {
    id: z.string(), baseVersion: z.number(), spec: z.record(z.string(), z.any()),
  }, async ({ id, baseVersion, spec }) => {
    try {
      const d = await gql('mutation($id:String!,$v:Int!,$s:JSON!){ updateDatasetSpec(id:$id, baseVersion:$v, spec:$s) }', { id, v: baseVersion, s: spec });
      return textResult(`OK. Nueva versión: ${d.updateDatasetSpec.spec_version}`);
    } catch (e) { return errorResult(e.message); }
  });

  server.tool("dataset_add_source", "Registra una fuente en un dataset (csv/xlsx/rest/postgres/mysql/mssql/odbc/firestore/manual). Para csv/xlsx usar filePath del upload.", {
    id: z.string(), kind: z.string(), name: z.string().optional(), config: z.record(z.string(), z.any()).optional(),
  }, async ({ id, kind, name, config }) => {
    try {
      const d = await gql('mutation($id:String!,$k:String!,$n:String,$c:JSON){ datasetAddSource(id:$id, kind:$k, name:$n, config:$c) }', { id, k: kind, n: name || kind, c: config || {} });
      return textResult(`Fuente ${d.datasetAddSource.id} registrada.`);
    } catch (e) { return errorResult(e.message); }
  });

  server.tool("dataset_ingest", "Ingesta una fuente a staging (devuelve filas/columnas).", {
    id: z.string(), sourceId: z.string(),
  }, async ({ id, sourceId }, extra) => {
    try {
      notify(extra, `ingestando ${sourceId}…`);
      const d = await gql('mutation($id:String!,$s:String!){ datasetIngest(id:$id, sourceId:$s) }', { id, s: sourceId });
      return textResult(`Ingestadas ${d.datasetIngest.rowCount} filas. Columnas: ${(d.datasetIngest.columns || []).map((c) => `${c.name}:${c.type}`).join(', ')}`);
    } catch (e) { return errorResult(e.message); }
  });

  server.tool("dataset_create_table", "Crea la tabla vinculada a una fuente (columnas inferidas).", {
    id: z.string(), sourceId: z.string(), tableName: z.string().optional(),
  }, async ({ id, sourceId, tableName }) => {
    try {
      const d = await gql('mutation($id:String!,$s:String!,$t:String){ datasetCreateTable(id:$id, sourceId:$s, tableName:$t) }', { id, s: sourceId, t: tableName || 'Tabla' });
      return textResult(`Tabla creada: ${JSON.stringify(d.datasetCreateTable).slice(0, 500)}`);
    } catch (e) { return errorResult(e.message); }
  });

  // Flujo agente-excel: crear dataset vacío → subir archivo → registrar fuente
  // → ingestar → crear tabla vinculada. Las columnas varían por archivo: se
  // infieren solas (nunca DDL manual).
  server.tool("dataset_create", "Crea un dataset semántico vacío (dueño: el usuario de servicio o el ownerEmail dado).", {
    name: z.string(), slug: z.string().optional(), ownerEmail: z.string().optional(),
  }, async ({ name, slug, ownerEmail }) => {
    try {
      const d = await gql('mutation($n:String!,$s:String){ datasetCreate(name:$n, slug:$s) }', { n: name, s: slug || "" }, ownerEmail);
      return textResult(`Dataset ${d.datasetCreate.id} (${d.datasetCreate.slug}).`);
    } catch (e) { return errorResult(e.message); }
  });

  server.tool("dataset_upload", "Sube un CSV/XLSX (base64, máx 25MB) para luego registrarlo como fuente. NO pegar contenido en el chat.", {
    filename: z.string(), contentBase64: z.string(),
  }, async ({ filename, contentBase64 }, extra) => {
    try {
      notify(extra, `dataset_upload: recibiendo ${filename}…`);
      const d = await gql('mutation($f:String!,$c:String!){ datasetUploadCsv(filename:$f, contentBase64:$c) }', { f: filename, c: contentBase64 });
      notify(extra, `dataset_upload: listo (${d.datasetUploadCsv.bytes} bytes)`);
      return textResult(`Subido: ${d.datasetUploadCsv.filename} (${d.datasetUploadCsv.bytes} bytes) en ${d.datasetUploadCsv.path}. Usar dataset_add_source con kind csv/xlsx.`);
    } catch (e) { notify(extra, `dataset_upload: ${e.message}`, "error"); return errorResult(e.message); }
  });

  // Superadmin: shell + lectura de archivos (repo en /work). SOLO humano dueño
  // con SUPERADMIN_KEY por llamada. Prohibido uso autónomo del agente.
  server.tool("admin_exec", "SUPERADMIN (dueño, con clave por llamada): ejecuta un comando shell en el entorno del proyecto (/work = repo). Todo uso se audita en logs.", {
    key: z.string(), as: z.string(), command: z.string(), workdir: z.string().optional(), timeoutMs: z.number().optional(),
  }, async ({ key, as, command, workdir, timeoutMs }) => {
    const deny = superadminCheck(key, as);
    console.log(`[superadmin] admin_exec ${deny ? "DENEGADO" : "OK"} as=${as} cmd=${String(command || "").slice(0, 200)}`);
    if (deny) return errorResult(deny);
    try {
      const r = await runCmd(command, { cwd: workdir, timeoutMs });
      return textResult(`exit=${r.code}${r.timedOut ? " (TIMEOUT)" : ""}${r.signal ? ` signal=${r.signal}` : ""}\n--- stdout ---\n${trunc(r.stdout, 20000)}\n--- stderr ---\n${trunc(r.stderr, 4000)}`);
    } catch (e) { return errorResult(e.message); }
  });

  server.tool("admin_read", "SUPERADMIN (dueño, con clave por llamada): lee un archivo (absoluto o relativo a /work).", {
    key: z.string(), as: z.string(), path: z.string(), limit: z.number().optional(),
  }, async ({ key, as, path, limit }) => {
    const deny = superadminCheck(key, as);
    console.log(`[superadmin] admin_read ${deny ? "DENEGADO" : "OK"} as=${as} path=${String(path || "").slice(0, 200)}`);
    if (deny) return errorResult(deny);
    try {
      const p = String(path || "");
      const full = p.startsWith("/") ? p : `/work/${p.replace(/^\/+/, "")}`;
      const text = await readFile(full, "utf8");
      const lines = text.split("\n");
      const n = Math.min(Math.max(Number(limit) || 400, 1), 2000);
      const out = lines.slice(0, n).map((l, i) => `${i + 1}: ${l}`).join("\n");
      return textResult(`${full} (${lines.length} líneas)${lines.length > n ? ` — mostrando ${n}` : ""}\n${trunc(out, 30000)}`);
    } catch (e) { return errorResult(e.message); }
  });

  return server;
}

const app = express();
app.use("/mcp", express.json({ limit: "5mb" }));
const transports = {};

const MCP_API_KEY = (process.env.MCP_API_KEY || "").trim();
// Base pública (https://dominio) para OAuth: issuer y URLs que ve Claude web.
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || process.env.CHARTIA_EXTERNAL_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
function bearerToken(req) {
  const h = String(req.headers.authorization || "");
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return String(req.headers["x-api-key"] || "").trim();
}
function apiKeyOk(req) {
  if (!MCP_API_KEY) return true;
  const got = bearerToken(req);
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(MCP_API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- OAuth 2.1 mínimo para Claude web (conector custom exige OAuth + DCR).
// Tokens opacos PERSISTIDOS en disco (/data, volumen) para que un restart no
// volteé clientes ni sesiones. El dueño aprueba en el browser con su key.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const OAUTH_FILE = process.env.OAUTH_STORE || "/data/oauth.json";
const oauthClients = new Map(); // client_id -> {secret, redirect_uris[], auth_method}
const oauthCodes = new Map(); // code -> {client_id, redirect_uri, challenge, exp}
const oauthTokens = new Map(); // access -> {exp}
const oauthRefresh = new Map(); // refresh -> {exp}
function oauthLoad() {
  try {
    const d = JSON.parse(readFileSync(OAUTH_FILE, "utf8"));
    for (const [k, v] of Object.entries(d.clients || {})) oauthClients.set(k, v);
    for (const [k, v] of Object.entries(d.codes || {})) if (v.exp > Date.now()) oauthCodes.set(k, v);
    for (const [k, v] of Object.entries(d.tokens || {})) if (v.exp > Date.now()) oauthTokens.set(k, v);
    for (const [k, v] of Object.entries(d.refresh || {})) if (v.exp > Date.now()) oauthRefresh.set(k, v);
    console.log(`   🔑 oauth store: ${oauthClients.size} clientes, ${oauthTokens.size} tokens`);
  } catch {}
}
function oauthSave() {
  try {
    mkdirSync("/data", { recursive: true });
    writeFileSync(OAUTH_FILE, JSON.stringify({
      clients: Object.fromEntries(oauthClients),
      codes: Object.fromEntries(oauthCodes),
      tokens: Object.fromEntries(oauthTokens),
      refresh: Object.fromEntries(oauthRefresh),
    }));
  } catch (e) { console.error("oauth store:", e.message); }
}
oauthLoad();
const rnd = (n = 32) => randomBytes(n).toString("base64url");
const b64urlSha256 = (s) => createHash("sha256").update(s).digest("base64url");
function oauthClientAuth(req, body) {
  // Devuelve client_id si autentica (o es público), null si falla.
  let cid = String(body.client_id || "");
  let secret = String(body.client_secret || "");
  const h = String(req.headers.authorization || "");
  if (h.toLowerCase().startsWith("basic ")) {
    try {
      const [u, p] = Buffer.from(h.slice(6).trim(), "base64").toString().split(":");
      cid = cid || u || "";
      secret = secret || p || "";
    } catch {}
  }
  if (!cid) return null;
  const c = oauthClients.get(cid);
  if (!c) return null;
  if (c.auth_method === "none") return cid;
  const a = Buffer.from(secret), b = Buffer.from(c.secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return cid;
}
function accessOk(token) {
  const t = oauthTokens.get(token);
  if (!t) return false;
  if (Date.now() > t.exp) { oauthTokens.delete(token); return false; }
  return true;
}
function mcpAuthorized(req) {
  if (apiKeyOk(req)) return true;
  const got = bearerToken(req);
  return !!got && accessOk(got);
}
function unauthorized(res, json) {
  const meta = `${PUBLIC_BASE}/.well-known/oauth-protected-resource/mcp`;
  res.set("WWW-Authenticate", `Bearer resource_metadata="${meta}"`);
  if (json) return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "MCP no autorizado." }, id: null });
  return res.status(401).send("MCP no autorizado.");
}

app.post("/mcp", async (req, res) => {
  try {
    if (!mcpAuthorized(req)) return unauthorized(res, true);
    const sid = req.headers["mcp-session-id"];
    let t;
    if (sid && transports[sid]) t = transports[sid];
    else if (!sid && isInitializeRequest(req.body)) {
      t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { transports[id] = t; } });
      t.onclose = () => { if (t.sessionId) delete transports[t.sessionId]; };
      await buildServer().connect(t);
    } else { res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Sesión inválida o falta initialize." }, id: null }); return; }
    await t.handleRequest(req, res, req.body);
  } catch (e) { console.error("POST /mcp", e); if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null }); }
});
app.get("/mcp", async (req, res) => {
  if (!mcpAuthorized(req)) return unauthorized(res, false);
  const sid = req.headers["mcp-session-id"];
  if (!sid || !transports[sid]) return res.status(400).send("Sesión inválida");
  await transports[sid].handleRequest(req, res);
});
app.delete("/mcp", async (req, res) => {
  if (!mcpAuthorized(req)) return unauthorized(res, false);
  const sid = req.headers["mcp-session-id"];
  if (!sid || !transports[sid]) return res.status(400).send("Sesión inválida");
  await transports[sid].handleRequest(req,res);
});
app.get("/health", (req, res) => res.json({ status: "ok", gql: GQL_URL }));

// ---- OAuth endpoints (Claude web / MCP spec) ----
app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  res.json({
    resource: `${PUBLIC_BASE}/mcp`,
    authorization_servers: [PUBLIC_BASE],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  });
});
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: PUBLIC_BASE,
    authorization_endpoint: `${PUBLIC_BASE}/oauth/authorize`,
    token_endpoint: `${PUBLIC_BASE}/oauth/token`,
    registration_endpoint: `${PUBLIC_BASE}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
  });
});
// Dynamic Client Registration (abierto: el dueño aprueba después en authorize).
app.post("/oauth/register", express.json(), (req, res) => {
  const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.filter((u) => typeof u === "string" && /^https:\/\//.test(u)) : [];
  if (!redirectUris.length) return res.status(400).json({ error: "invalid_redirect_uri" });
  const method = String(req.body?.token_endpoint_auth_method || "client_secret_basic");
  const cid = `cli_${rnd(12)}`;
  const secret = method === "none" ? "" : rnd(24);
  oauthClients.set(cid, { secret, redirect_uris: redirectUris, auth_method: method });
  oauthSave();
  console.log(`[oauth] cliente registrado ${cid} (${redirectUris.join(",")})`);
  res.status(201).json({
    client_id: cid,
    ...(secret ? { client_secret: secret } : {}),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
  });
});
// Pantalla de aprobación del dueño (contraseña = MCP_API_KEY).
app.get("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.query;
  const c = oauthClients.get(String(client_id || ""));
  if (!c || !redirect_uri || !c.redirect_uris.includes(String(redirect_uri))) {
    return res.status(400).send("Cliente o redirect_uri inválido.");
  }
  if (code_challenge_method && code_challenge_method !== "S256") {
    return res.status(400).send("Solo S256.");
  }
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorizar Creador MCP</title></head>
<body style="font-family:system-ui;background:#1c1e31;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0">
<form method="post" action="/oauth/approve" style="background:#262842;padding:28px;border-radius:14px;display:grid;gap:12px;width:min(380px,90vw)">
<h2 style="margin:0">Autorizar Creador MCP</h2>
<p style="margin:0;font-size:13px;color:#bbb">Un asistente (Claude web) pide acceso a tus reportes/datasets.${scope ? ` Alcance: ${String(scope).slice(0, 80)}.` : ""}</p>
<input type="hidden" name="client_id" value="${String(client_id).replace(/"/g, "")}">
<input type="hidden" name="redirect_uri" value="${String(redirect_uri).replace(/"/g, "")}">
<input type="hidden" name="state" value="${String(state || "").replace(/"/g, "")}">
<input type="hidden" name="code_challenge" value="${String(code_challenge || "").replace(/"/g, "")}">
<label style="font-size:13px">Clave de dueño (MCP_API_KEY)<input type="password" name="password" required autofocus style="width:100%;margin-top:4px;padding:10px;border-radius:8px;border:1px solid #555;background:#1c1e31;color:#fff;box-sizing:border-box"></label>
<button style="padding:11px;border-radius:9px;border:0;background:linear-gradient(115deg,#460a78,#be2878,#d63c41,#ff3700);color:#fff;font-weight:700;cursor:pointer">Autorizar acceso</button>
</form></body></html>`);
});
app.post("/oauth/approve", express.urlencoded({ extended: false }), (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, password } = req.body || {};
  const c = oauthClients.get(String(client_id || ""));
  if (!c || !redirect_uri || !c.redirect_uris.includes(String(redirect_uri))) {
    return res.status(400).send("Cliente o redirect_uri inválido.");
  }
  const a = Buffer.from(String(password || "")), b = Buffer.from(MCP_API_KEY);
  if (!MCP_API_KEY || a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(403).send("Clave incorrecta.");
  }
  const code = rnd();
  oauthCodes.set(code, { client_id: String(client_id), redirect_uri: String(redirect_uri), challenge: String(code_challenge || ""), exp: Date.now() + 10 * 60 * 1000 });
  oauthSave();
  console.log(`[oauth] código emitido para ${client_id}`);
  const sep = String(redirect_uri).includes("?") ? "&" : "?";
  res.redirect(`${redirect_uri}${sep}code=${code}${state ? `&state=${encodeURIComponent(state)}` : ""}`);
});
app.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
  const grant = String(req.body?.grant_type || "");
  if (grant === "authorization_code") {
    const cid = oauthClientAuth(req, req.body || {});
    const { code, redirect_uri, code_verifier } = req.body || {};
    const rec = oauthCodes.get(String(code || ""));
    if (!cid || !rec || rec.client_id !== cid) return res.status(400).json({ error: "invalid_grant" });
    if (rec.redirect_uri !== String(redirect_uri || "")) return res.status(400).json({ error: "invalid_grant" });
    if (Date.now() > rec.exp) { oauthCodes.delete(String(code)); return res.status(400).json({ error: "invalid_grant" }); }
    if (rec.challenge) {
      if (!code_verifier || b64urlSha256(String(code_verifier)) !== rec.challenge) {
        return res.status(400).json({ error: "invalid_grant" });
      }
    }
    oauthCodes.delete(String(code));
    const access = rnd(), refresh = rnd();
    oauthTokens.set(access, { exp: Date.now() + 3600 * 1000 });
    oauthRefresh.set(refresh, { exp: Date.now() + 30 * 24 * 3600 * 1000 });
    oauthSave();
    console.log(`[oauth] token emitido para ${cid}`);
    return res.json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "mcp" });
  }
  if (grant === "refresh_token") {
    const cid = oauthClientAuth(req, req.body || {});
    const rec = oauthRefresh.get(String(req.body?.refresh_token || ""));
    if (!cid || !rec) return res.status(400).json({ error: "invalid_grant" });
    if (Date.now() > rec.exp) { oauthRefresh.delete(String(req.body.refresh_token)); return res.status(400).json({ error: "invalid_grant" }); }
    // Sin rotación: el mismo refresh sigue valiendo (evita invalid_grant por
    // refreshes concurrentes). Solo se emite access nuevo.
    const access = rnd();
    oauthTokens.set(access, { exp: Date.now() + 3600 * 1000 });
    oauthSave();
    return res.json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "mcp" });
  }
  return res.status(400).json({ error: "unsupported_grant_type" });
});

app.listen(PORT, () => {
  console.log(`🤖 MCP v2 en http://localhost:${PORT}/mcp (backend: ${GQL_URL}, serviceUser: ${MCP_USER_EMAIL})`);
  console.log(MCP_API_KEY ? `   🔑 protegido con API key` : `   ⚠️ sin API key (solo dev)`);
  // Login anticipado del usuario de servicio (evita el 401/500 del 1er call).
  if (MCP_USER_PASSWORD) serviceLogin().then((t) => console.log(t ? `   🔑 sesión de servicio lista` : `   ⚠️ sin sesión de servicio (revisar MCP_USER_EMAIL/PASSWORD)`)).catch(() => {});
});
