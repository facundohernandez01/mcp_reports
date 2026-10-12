// @ts-nocheck
// Portado de builder/src/lib/semantic/ (stack viejo) — lógica pura, sin Next.
// No duplicar lógica: cualquier fix va acá y se backportea si aplica.
import type { Condition, DatasetTable, Expr, LogicGroup, TransformationStep } from './types.js';

export type Row = Record<string, unknown>;

const textOf = (v: unknown) => String(v ?? '').trim();

function evalCondition(row: Row, table: DatasetTable, cond: Condition): boolean {
  const col = table.columns.find((c) => c.id === cond.column);
  const key = col ? col.name : cond.column;
  const v = row[key];
  const t = cond.value;
  switch (cond.operator) {
    case 'isNull': return v === null || v === undefined || textOf(v) === '';
    case 'notNull': return !(v === null || v === undefined || textOf(v) === '');
    case 'eq': return textOf(v) === textOf(t);
    case 'neq': return textOf(v) !== textOf(t);
    case 'contains': return textOf(v).toLowerCase().includes(textOf(t).toLowerCase());
    case 'in': return Array.isArray(t) && t.map(textOf).includes(textOf(v));
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = Number(v), b = Number(t);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        return cond.operator === 'gt' ? a > b : cond.operator === 'gte' ? a >= b : cond.operator === 'lt' ? a < b : a <= b;
      }
      const cmp = textOf(v).localeCompare(textOf(t), 'es');
      return cond.operator === 'gt' ? cmp > 0 : cond.operator === 'gte' ? cmp >= 0 : cond.operator === 'lt' ? cmp < 0 : cmp <= 0;
    }
    default: return true;
  }
}

function castValue(v: unknown, to: DatasetTable['columns'][number]['type']): unknown {
  if (v === null || v === undefined || v === '') return null;
  switch (to) {
    case 'number': {
      // Primero formato internacional directo; si falla, formato AR
      // (puntos de miles, coma decimal): '1.756.9053'→17569053, '12,44'→12.44.
      const direct = Number(String(v).trim());
      if (Number.isFinite(direct)) return direct;
      const ar = Number(String(v).replace(/\./g, '').replace(',', '.'));
      return Number.isFinite(ar) ? ar : null;
    }
    case 'boolean': return ['true', '1', 'sí', 'si', 'yes'].includes(textOf(v).toLowerCase());
    case 'date': case 'datetime': {
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, to === 'date' ? 10 : 19);
    }
    default: return String(v);
  }
}

export function evalCond(row: Row, table: DatasetTable, cond: Condition | LogicGroup): boolean {
  if ('logic' in cond) {
    if (cond.logic === 'not') return !evalCond(row, table, cond.condition);
    const rs = cond.conditions.map((c) => evalCond(row, table, c));
    return cond.logic === 'and' ? rs.every(Boolean) : rs.some(Boolean);
  }
  return evalCondition(row, table, cond);
}

function evalExpr(row: Row, byName: Map<string, string>, expr: Expr): unknown {
  // byName: column.name actual -> column.name (las calculadas leen por nombre vigente)
  switch (expr.kind) {
    case 'column': {
      const key = byName.get(expr.column) ?? expr.column;
      return row[key];
    }
    case 'literal': return expr.value;
    case 'binary': {
      const l = Number(evalExpr(row, byName, expr.left));
      const r = Number(evalExpr(row, byName, expr.right));
      if (!Number.isFinite(l) || !Number.isFinite(r)) return null;
      return expr.op === '+' ? l + r : expr.op === '-' ? l - r : expr.op === '*' ? l * r : r !== 0 ? l / r : null;
    }
    case 'concat':
      return expr.parts.map((p) => textOf(evalExpr(row, byName, p))).join(expr.separator ?? '');
    case 'datePart': {
      const d = new Date(String(evalExpr(row, byName, expr.of)));
      if (Number.isNaN(d.getTime())) return null;
      return expr.part === 'year' ? d.getFullYear() : expr.part === 'month' ? d.getMonth() + 1 : d.getDate();
    }
    case 'case': {
      const fake: DatasetTable = { id: '', name: '', sourceId: '', columns: [...byName].map(([id, name]) => ({ id, name, type: 'text' as const, nullable: true })), steps: [] };
      for (const w of expr.when) {
        if (evalCond(row, fake, w.cond)) {
          return evalExpr(row, byName, w.then);
        }
      }
      return evalExpr(row, byName, expr.else);
    }
    case 'dateDiffDays': {
      const a = new Date(String(evalExpr(row, byName, expr.a)));
      const b = new Date(String(evalExpr(row, byName, expr.b)));
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
      return Math.round((b.getTime() - a.getTime()) / 86400000);
    }
    case 'dateTrunc': {
      const d = new Date(String(evalExpr(row, byName, expr.of)));
      if (Number.isNaN(d.getTime())) return null;
      const mm = expr.part === 'year' ? '01' : String(d.getMonth() + 1).padStart(2, '0');
      return `${d.getFullYear()}-${mm}-01`;
    }
    case 'upper': return textOf(evalExpr(row, byName, expr.of)).toUpperCase();
    case 'lower': return textOf(evalExpr(row, byName, expr.of)).toLowerCase();
    case 'trim': return textOf(evalExpr(row, byName, expr.of));
    case 'substring':
      return textOf(evalExpr(row, byName, expr.of)).slice(Math.max(0, expr.start), expr.length === undefined ? undefined : Math.max(0, expr.start) + expr.length);
    case 'replace':
      return textOf(evalExpr(row, byName, expr.of)).split(expr.find).join(expr.with);
    case 'round': {
      const n = Number(evalExpr(row, byName, expr.of));
      if (!Number.isFinite(n)) return null;
      const f = Math.pow(10, Math.max(0, expr.digits ?? 0));
      return Math.round(n * f) / f;
    }
    case 'abs': {
      const n = Number(evalExpr(row, byName, expr.of));
      return Number.isFinite(n) ? Math.abs(n) : null;
    }
    case 'coalesce': {
      for (const p of expr.parts) {
        const v = evalExpr(row, byName, p);
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;
    }
  }
}

// Aplica los steps a filas crudas (claves = nombres de origen). Devuelve filas
// con claves = nombres vigentes + esquema resultante.
export function applySteps(
  table: DatasetTable,
  input: Row[],
  opts: { rowLimit?: number } = {},
): { rows: Row[]; columns: { id: string; name: string; type: string }[] } {
  let cols = table.columns.map((c) => ({ ...c }));
  let rows = input.map((r) => ({ ...r }));
  const byName = () => new Map(cols.map((c) => [c.id, c.name]));
  for (const step of table.steps) {
    if (step.op === 'filter') {
      rows = rows.filter((row) => {
        const col = cols.find((c) => c.id === step.column);
        const key = col ? col.name : step.column;
        return evalCondition(row, { ...table, columns: cols }, { column: step.column, operator: step.operator, value: step.value });
      });
    } else if (step.op === 'typeCast') {
      const col = cols.find((c) => c.id === step.column);
      if (col) {
        col.type = step.to;
        rows = rows.map((row) => ({ ...row, [col.name]: castValue(row[col.name], step.to) }));
      }
    } else if (step.op === 'renameColumn') {
      const col = cols.find((c) => c.id === step.column);
      if (col) {
        const from = col.name;
        col.name = step.to;
        rows = rows.map((row) => {
          if (!(from in row)) return row;
          const { [from]: v, ...rest } = row as Record<string, unknown>;
          return { ...rest, [col.name]: v };
        });
      }
    } else if (step.op === 'dropColumn') {
      const col = cols.find((c) => c.id === step.column);
      cols = cols.filter((c) => c.id !== step.column);
      if (col) rows = rows.map((row) => {
        const { [col.name]: _, ...rest } = row as Record<string, unknown>;
        return rest;
      });
    } else if (step.op === 'addCalculatedColumn') {
      cols.push({ id: step.id, name: step.name, type: step.type, nullable: true });
      const names = byName();
      rows = rows.map((row) => ({ ...row, [step.name]: evalExpr(row, names, step.expression) }));
    } else if (step.op === 'join') {
      // join resuelto por el llamador (necesita la otra tabla); se marca y se ignora aquí.
      continue;
    }
  }
  const limit = opts.rowLimit ?? rows.length;
  return { rows: rows.slice(0, limit), columns: cols.map((c) => ({ id: c.id, name: c.name, type: c.type })) };
}

// --- SQL generado (materialización en PG, filas JSONB en columna `data`) ---

const sqlIdent = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
const sqlLit = (v: unknown): string =>
  v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v)
  : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE')
  : `'${String(v).replace(/'/g, "''")}'`;

function sqlCond(col: string, operator: Condition['operator'], value?: unknown): string {
  const c = `data->>${sqlLit(col)}`;
  // Comparaciones numéricas contra columna text: castear lado izquierdo.
  const numOps = ['gt', 'gte', 'lt', 'lte'] as const;
  if ((numOps as readonly string[]).includes(operator) && typeof value === 'number') {
    const n = `NULLIF(${c},'')::numeric`;
    return operator === 'gt' ? `${n} > ${value}` : operator === 'gte' ? `${n} >= ${value}` : operator === 'lt' ? `${n} < ${value}` : `${n} <= ${value}`;
  }
  switch (operator) {
    case 'isNull': return `(${c} IS NULL OR ${c} = '')`;
    case 'notNull': return `(${c} IS NOT NULL AND ${c} <> '')`;
    case 'eq': return `${c} = ${sqlLit(textOf(value))}`;
    case 'neq': return `${c} <> ${sqlLit(textOf(value))}`;
    case 'contains': return `${c} ILIKE ${sqlLit(`%${value ?? ''}%`)}`;
    case 'in': return Array.isArray(value) ? `${c} = ANY (ARRAY[${value.map(sqlLit).join(',')}])` : 'TRUE';
    case 'gt': return `${c} > ${sqlLit(value)}`;
    case 'gte': return `${c} >= ${sqlLit(value)}`;
    case 'lt': return `${c} < ${sqlLit(value)}`;
    case 'lte': return `${c} <= ${sqlLit(value)}`;
    default: return 'TRUE';
  }
}

function sqlCondEx(cond: Condition | LogicGroup, resolve: (id: string) => string): string {
  if ('logic' in cond) {
    if (cond.logic === 'not') return `(NOT (${sqlCondEx(cond.condition, resolve)}))`;
    const parts = cond.conditions.map((c) => `(${sqlCondEx(c, resolve)})`);
    return parts.length ? `(${parts.join(cond.logic === 'and' ? ' AND ' : ' OR ')})` : 'TRUE';
  }
  return sqlCond(resolve(cond.column), cond.operator, cond.value);
}

function sqlExpr(expr: Expr, names: Map<string, string>): string {
  // Lado numérico: solo las referencias a columna llevan NULLIF anti-''.
  // Literales van crudos y subexpresiones ya son numeric/NULL (envolverlas
  // rompería: NULLIF(<numeric>, '') fuerza ''::numeric).
  const num = (sub: Expr): string => {
    if (sub.kind === 'literal' && typeof sub.value === 'number') return String(sub.value);
    if (sub.kind === 'literal' && typeof sub.value === 'boolean') return sub.value ? 'TRUE' : 'FALSE';
    if (sub.kind === 'column') return `NULLIF(${sqlExpr(sub, names)},'')::numeric`;
    return `(${sqlExpr(sub, names)})`;
  };
  switch (expr.kind) {
    case 'column': return `data->>${sqlLit(names.get(expr.column) ?? expr.column)}`;
    case 'literal': return sqlLit(expr.value);
    case 'binary': {
      const l = num(expr.left), r = num(expr.right);
      return expr.op === '+' ? `(${l} + ${r})` : `(${l} ${expr.op} ${r})`;
    }
    case 'concat': return expr.parts.map((p) => `COALESCE(${sqlExpr(p, names)},'')`).join(` || ${sqlLit(expr.separator ?? '')} || `);
    case 'datePart': {
      const f = expr.part === 'year' ? 'YYYY' : expr.part === 'month' ? 'MM' : 'DD';
      return `to_char((${sqlExpr(expr.of, names)})::timestamp, '${f}')::int`;
    }
    case 'dateDiffDays':
      return `((${sqlExpr(expr.b, names)})::date - (${sqlExpr(expr.a, names)})::date)`;
    case 'dateTrunc':
      return `date_trunc('${expr.part}', (${sqlExpr(expr.of, names)})::timestamp)`;
    case 'upper': return `UPPER(${sqlExpr(expr.of, names)})`;
    case 'lower': return `LOWER(${sqlExpr(expr.of, names)})`;
    case 'trim': return `BTRIM(${sqlExpr(expr.of, names)})`;
    case 'substring': {
      const base = `SUBSTRING(${sqlExpr(expr.of, names)} FROM ${Math.max(0, expr.start) + 1}`;
      return expr.length === undefined ? `${base})` : `${base} FOR ${expr.length})`;
    }
    case 'replace':
      return `REPLACE(${sqlExpr(expr.of, names)}, ${sqlLit(expr.find)}, ${sqlLit(expr.with)})`;
    case 'round': return `ROUND((${sqlExpr(expr.of, names)})::numeric, ${Math.max(0, expr.digits ?? 0)})`;
    case 'abs': return `ABS((${sqlExpr(expr.of, names)})::numeric)`;
    case 'coalesce':
      return `COALESCE(${expr.parts.map((p) => sqlExpr(p, names)).join(', ')})`;
    case 'case': {
      const byId = (id: string) => names.get(id) ?? id;
      const whens = expr.when.map((w) => `WHEN ${sqlCondEx(w.cond, byId)} THEN ${sqlExpr(w.then, names)}`).join(' ');
      return `(CASE ${whens} ELSE ${sqlExpr(expr.else, names)} END)`;
    }
  }
}

// SELECT que materializa la tabla (staging `fromTable` con columna JSONB `data`).
export function buildTableSQL(table: DatasetTable, fromTable: string): string {
  let cols = table.columns.map((c) => ({ ...c }));
  const wheres: string[] = [];
  const selects: string[] = [];
  const calcNames = new Set<string>();
  for (const step of table.steps) {
    if (step.op === 'filter') {
      const col = cols.find((c) => c.id === step.column);
      wheres.push(sqlCond(col ? col.name : step.column, step.operator, step.value));
    } else if (step.op === 'renameColumn') {
      const col = cols.find((c) => c.id === step.column);
      if (col) col.name = step.to;
    } else if (step.op === 'dropColumn') {
      cols = cols.filter((c) => c.id !== step.column);
    } else if (step.op === 'typeCast') {
      const col = cols.find((c) => c.id === step.column);
      if (col) col.type = step.to;
    } else if (step.op === 'addCalculatedColumn') {
      const names = new Map(cols.map((c) => [c.id, c.name]));
      // ::float8 en numéricas: node-pg devuelve numeric como string.
      const expr = sqlExpr(step.expression, names);
      selects.push(`${step.type === 'number' ? `(${expr})::float8` : expr} AS ${sqlIdent(step.name)}`);
      calcNames.add(step.name);
      cols.push({ id: step.id, name: step.name, type: step.type, nullable: true });
    }
  }
  // Base: solo columnas físicas (las calculadas salen en selects, sin duplicar).
  // Numéricas con cast (si no, quedan TEXT y las comparaciones/sorts son
  // lexicográficos: '797955' >= '1000000' daría true).
  const colType = new Map(cols.map((c) => [c.name, c.type]));
  const baseOf = (n: string) =>
    colType.get(n) === 'number' ? `NULLIF(data->>${sqlLit(n)},'')::float8 AS ${sqlIdent(n)}` : `data->>${sqlLit(n)} AS ${sqlIdent(n)}`;
  const names = cols.filter((c) => !calcNames.has(c.name)).map((c) => c.name);
  const base = names.map(baseOf).join(', ');
  const all = selects.length ? `${base}, ${selects.join(', ')}` : base;
  const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : '';
  return `SELECT ${all} FROM ${fromTable}${where}`;
}
