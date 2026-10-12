// Portado de builder/src/lib/semantic/ (stack viejo) — lógica pura, sin Next.
// No duplicar lógica: cualquier fix va acá y se backportea si aplica.
// Capa semántica: qué datos existen (agnóstica a visualización).
// Todo se referencia por IDs estables; los `name` son display renombrable.

export type ColumnType = 'text' | 'number' | 'boolean' | 'date' | 'datetime';

export interface SemanticColumn {
  id: string;
  name: string;
  type: ColumnType;
  nullable: boolean;
}

export type Expr =
  | { kind: 'column'; column: string }                       // column.id
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr }
  | { kind: 'concat'; parts: Expr[]; separator?: string }
  | { kind: 'datePart'; part: 'year' | 'month' | 'day'; of: Expr }
  | { kind: 'dateDiffDays'; a: Expr; b: Expr }                // b - a en días
  | { kind: 'dateTrunc'; part: 'month' | 'year'; of: Expr }
  | { kind: 'upper' | 'lower' | 'trim'; of: Expr }
  | { kind: 'substring'; of: Expr; start: number; length?: number }  // start 0-indexed
  | { kind: 'replace'; of: Expr; find: string; with: string }
  | { kind: 'round'; of: Expr; digits?: number }
  | { kind: 'abs'; of: Expr }
  | { kind: 'coalesce'; parts: Expr[] }
  | { kind: 'case'; when: { cond: Condition | LogicGroup; then: Expr }[]; else: Expr };

// Grupo lógico para CASE (and/or/not anidables).
export type LogicGroup =
  | { logic: 'and' | 'or'; conditions: (Condition | LogicGroup)[] }
  | { logic: 'not'; condition: Condition | LogicGroup };

export interface Condition {
  column: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'isNull' | 'notNull';
  value?: unknown;
}

export type TransformationStep =
  | { op: 'typeCast'; column: string; to: ColumnType }
  | { op: 'filter'; column: string; operator: Condition['operator']; value?: unknown }
  | { op: 'renameColumn'; column: string; to: string }
  | { op: 'dropColumn'; column: string }
  | { op: 'addCalculatedColumn'; id: string; name: string; type: ColumnType; expression: Expr }
  | { op: 'join'; table: string; leftKey: string; rightKey: string; how: 'left' | 'inner'; prefix?: string };

export type SourceKind = 'csv' | 'xlsx' | 'rest' | 'odbc' | 'manual' | 'postgres' | 'mysql';

export interface DataSourceConfig {
  // files
  filePath?: string;
  sheet?: string | number;
  headerRow?: number;
  skiprows?: number;
  // rest
  url?: string;
  method?: 'GET' | 'POST';
  auth?: { type: 'none' | 'bearer' | 'basic' | 'headers'; token?: string; user?: string; password?: string; headers?: Record<string, string> };
  pagination?: { type: 'none' | 'offset' | 'page' | 'cursor'; limitParam?: string; offsetParam?: string; pageParam?: string; cursorPath?: string; pageSize?: number; maxPages?: number };
  jsonPath?: string;
  // sql (postgres/mysql/odbc)
  connectionString?: string;
  dsn?: string;
  query?: string;
}

export interface DatasetTable {
  id: string;
  name: string;
  sourceId: string;
  columns: SemanticColumn[];
  steps: TransformationStep[];
  ui?: { x: number; y: number };
}

export interface Relation {
  id: string;
  from: { table: string; column: string };
  to: { table: string; column: string };
  cardinality: '1-N' | '1-1' | 'N-N';
}

export interface Measure {
  id: string;
  name: string;
  expression: Expr;
  format?: string;
}

export interface SemanticModelSpec {
  version: 1;
  datasetId: string;
  name: string;
  tables: DatasetTable[];
  relations: Relation[];
  measures: Measure[];
  specVersion: number;
  updatedAt: string;
}

// Presentación: bindings por ID estable (nunca nombres).
export interface ViewBinding {
  tableId: string;
  columnId: string;
}

export interface ChartBinding {
  id: string;
  title: string;
  type: string;
  dimension: ViewBinding;
  measure: ViewBinding | { measureId: string };
  breakdown?: ViewBinding;
  rh?: number;
}

export interface ViewLayoutSpec {
  tabs: unknown[];
  tabOrientation: string;
  activeTab: string;
  charts: ChartBinding[];
  kpis: { id: string; measureId: string; operation: string }[];
  tableColumns: ViewBinding[];
}

export const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
