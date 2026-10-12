// Portado de builder/src/lib/... (stack viejo). Ver notas en cada archivo.
// @ts-nocheck
// Catálogo data-driven de conectores (estilo Grafana): agregar un kind nuevo
// es agregar una entrada acá (label + fields). El form de /conectores y el
// test usan este catálogo; no hay que tocar UI.
export interface ConnectorField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'password' | 'textarea' | 'select' | 'kv';
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  help?: string;
  secret?: boolean;
}

export interface ConnectorKind {
  kind: string;
  label: string;
  icon: string;
  desc: string;
  fields: ConnectorField[];
}

export const CONNECTOR_CATALOG: ConnectorKind[] = [
  {
    kind: 'postgres',
    label: 'PostgreSQL',
    icon: '🐘',
    desc: 'Base PostgreSQL (también sirve para el ingest de datasets).',
    fields: [
      { key: 'host', label: 'Servidor', type: 'text', placeholder: 'localhost', required: true, help: 'OJO: desde un container, localhost es el propio container. Para el PG del proyecto usá host "postgres" (botón de abajo).' },
      { key: 'port', label: 'Puerto', type: 'number', placeholder: '5432' },
      { key: 'database', label: 'Base de datos', type: 'text', required: true },
      { key: 'user', label: 'Usuario', type: 'text', required: true },
      { key: 'password', label: 'Contraseña', type: 'password', secret: true },
      { key: 'query', label: 'Consulta SQL (SELECT)', type: 'textarea', placeholder: 'SELECT * FROM esquema.tabla', required: true, help: 'Se ejecuta en cada ingesta y en cada refresh programado.' },
    ],
  },
  {
    kind: 'mysql',
    label: 'MySQL / MariaDB',
    icon: '🐬',
    desc: 'Base MySQL o MariaDB.',
    fields: [
      { key: 'host', label: 'Servidor', type: 'text', placeholder: 'localhost', required: true },
      { key: 'port', label: 'Puerto', type: 'number', placeholder: '3306' },
      { key: 'database', label: 'Base de datos', type: 'text', required: true },
      { key: 'user', label: 'Usuario', type: 'text', required: true },
      { key: 'password', label: 'Contraseña', type: 'password', secret: true },
      { key: 'query', label: 'Consulta SQL (SELECT)', type: 'textarea', placeholder: 'SELECT * FROM esquema.tabla', required: true, help: 'Se ejecuta en cada ingesta y en cada refresh programado.' },
    ],
  },
  {
    kind: 'mssql',
    label: 'SQL Server',
    icon: '🗄',
    desc: 'Microsoft SQL Server (vía TDS).',
    fields: [
      { key: 'host', label: 'Servidor', type: 'text', placeholder: 'localhost', required: true },
      { key: 'port', label: 'Puerto', type: 'number', placeholder: '1433' },
      { key: 'database', label: 'Base de datos', type: 'text', required: true },
      { key: 'user', label: 'Usuario', type: 'text', required: true },
      { key: 'password', label: 'Contraseña', type: 'password', secret: true },
      { key: 'encrypt', label: 'Cifrar conexión', type: 'select', options: [{ value: 'true', label: 'Sí (recomendado)' }, { value: 'false', label: 'No (red local)' }] },
      { key: 'query', label: 'Consulta SQL (SELECT)', type: 'textarea', placeholder: 'SELECT * FROM esquema.tabla', required: true, help: 'Se ejecuta en cada ingesta y en cada refresh programado.' },
    ],
  },
  {
    kind: 'odbc',
    label: 'ODBC genérico',
    icon: '🔌',
    desc: 'Cualquier origen con driver ODBC (Excel, DB2, etc.).',
    fields: [
      { key: 'connectionString', label: 'Connection string', type: 'textarea', placeholder: 'Driver={...};Server=...;Database=...;Uid=...;Pwd=...;', required: true, secret: true },
      { key: 'query', label: 'Consulta SQL (SELECT)', type: 'textarea', placeholder: 'SELECT * FROM esquema.tabla', required: true, help: 'Se ejecuta en cada ingesta y en cada refresh programado.' },
    ],
  },
  {
    kind: 'rest',
    label: 'API REST (mini-postman)',
    icon: '🌐',
    desc: 'Endpoint HTTP con auth, headers y body. Probalo acá antes de usarlo en un dataset.',
    fields: [
      { key: 'url', label: 'URL completa', type: 'text', placeholder: 'https://api…/recurso?x=1', required: true },
      { key: 'method', label: 'Método', type: 'select', options: [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }, { value: 'PATCH', label: 'PATCH' }, { value: 'DELETE', label: 'DELETE' }] },
      { key: 'authType', label: 'Auth', type: 'select', options: [{ value: 'none', label: 'Sin auth' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'Basic (usuario:clave)' }, { value: 'apiKey', label: 'API key en header' }] },
      { key: 'token', label: 'Token / clave (según auth)', type: 'password', secret: true, help: 'Bearer: el token. Basic: usuario:contraseña. API key: el valor.' },
      { key: 'apiKeyHeader', label: 'Header de API key', type: 'text', placeholder: 'x-api-key', help: 'Solo si auth = API key.' },
      { key: 'user', label: 'Usuario (basic)', type: 'text', help: 'Solo si auth = Basic y no usás usuario:clave en Token.' },
      { key: 'headers', label: 'Headers extra', type: 'kv', help: 'Pares clave: valor (ej. Accept: application/json).' },
      { key: 'body', label: 'Body JSON (POST/PUT/PATCH)', type: 'textarea', placeholder: '{\n  "clave": "valor"\n}' },
      { key: 'jsonPath', label: 'JSON path de filas (opcional)', type: 'text', placeholder: 'data.items', help: 'Para usarlo luego en datasets: dónde están las filas.' },
      { key: 'pagination', label: 'Paginación', type: 'select', options: [{ value: 'none', label: 'Sin paginación' }, { value: 'offset', label: 'offset/limit' }, { value: 'page', label: 'page/limit' }, { value: 'cursor', label: 'Cursor' }] },
      { key: 'pageSize', label: 'Filas por página', type: 'number', placeholder: '100' },
      { key: 'maxPages', label: 'Máx páginas', type: 'number', placeholder: '10' },
    ],
  },
  {
    kind: 'firestore',
    label: 'Firestore (remoto)',
    icon: '🔥',
    desc: 'Google Firestore vía service account (sin dependencias extra).',
    fields: [
      { key: 'projectId', label: 'Project ID', type: 'text', required: true },
      { key: 'clientEmail', label: 'Client email (service account)', type: 'text', required: true },
      { key: 'privateKey', label: 'Private key', type: 'textarea', placeholder: '-----BEGIN PRIVATE KEY-----…', required: true, secret: true },
      { key: 'collection', label: 'Colección de prueba', type: 'text', placeholder: 'clientes', help: 'Se lee 1 documento para probar.' },
    ],
  },
];

export const connectorKindOf = (kind: string): ConnectorKind | undefined =>
  CONNECTOR_CATALOG.find((k) => k.kind === kind);
