// @ts-nocheck
import type { Condition, DatasetTable, Expr, LogicGroup, SemanticModelSpec } from './types.js';

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  tableId?: string;
  ref?: string;
}

function exprColumns(expr: Expr, acc: string[] = []): string[] {
  switch (expr.kind) {
    case 'column': acc.push(expr.column); break;
    case 'binary': exprColumns(expr.left, acc); exprColumns(expr.right, acc); break;
    case 'concat': case 'coalesce': expr.parts.forEach((p) => exprColumns(p, acc)); break;
    case 'datePart': case 'dateTrunc': case 'upper': case 'lower': case 'trim':
    case 'round': case 'abs': exprColumns(expr.of, acc); break;
    case 'substring': case 'replace': exprColumns(expr.of, acc); break;
    case 'dateDiffDays': exprColumns(expr.a, acc); exprColumns(expr.b, acc); break;
    case 'case':
      expr.when.forEach((w) => { groupColumns(w.cond, acc); exprColumns(w.then, acc); });
      exprColumns(expr.else, acc);
      break;
    default: break;
  }
  return acc;
}

function groupColumns(cond: Condition | LogicGroup, acc: string[]): void {
  if ('logic' in cond) {
    if (cond.logic === 'not') groupColumns(cond.condition, acc);
    else cond.conditions.forEach((c) => groupColumns(c, acc));
    return;
  }
  acc.push(cond.column);
}

// Simula el esquema resultante de los steps (sin filas) para validar refs.
export function schemaAfterSteps(table: DatasetTable): { id: string; name: string; type: string }[] {
  let cols = table.columns.map((c) => ({ ...c }));
  for (const step of table.steps) {
    if (step.op === 'renameColumn') {
      const col = cols.find((c) => c.id === step.column);
      if (col) col.name = step.to;
    } else if (step.op === 'dropColumn') {
      cols = cols.filter((c) => c.id !== step.column);
    } else if (step.op === 'addCalculatedColumn') {
      cols.push({ id: step.id, name: step.name, type: step.type, nullable: true });
    }
  }
  return cols;
}

export function validateSpec(spec: SemanticModelSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!spec.tables.length) {
    issues.push({ level: 'warning', code: 'no-tables', message: 'El dataset no tiene tablas.' });
  }
  const tableIds = new Set(spec.tables.map((t) => t.id));
  for (const table of spec.tables) {
    // columnas duplicadas por nombre visible
    const seen = new Set<string>();
    for (const c of schemaAfterSteps(table)) {
      const k = c.name.toLowerCase();
      if (seen.has(k)) {
        issues.push({ level: 'error', code: 'dup-column', message: `Columna duplicada "${c.name}" en tabla "${table.name}".`, tableId: table.id });
      }
      seen.add(k);
    }
    // steps contra IDs inexistentes
    const ids = new Set(table.columns.map((c) => c.id));
    for (const [i, step] of table.steps.entries()) {
      const ref = (step as { column?: string }).column;
      if (ref && !ids.has(ref) && step.op !== 'addCalculatedColumn') {
        issues.push({ level: 'error', code: 'dangling-step', message: `Paso ${i} (${step.op}) referencia columna inexistente en "${table.name}".`, tableId: table.id, ref });
      }
      if (step.op === 'addCalculatedColumn') {
        for (const c of exprColumns(step.expression)) {
          if (!ids.has(c) && !table.steps.some((s) => s.op === 'addCalculatedColumn' && s.id === c)) {
            issues.push({ level: 'error', code: 'dangling-expr', message: `Expresión de "${step.name}" usa columna inexistente en "${table.name}".`, tableId: table.id, ref: c });
          }
        }
      }
      if (step.op === 'join' && !tableIds.has(step.table)) {
        issues.push({ level: 'error', code: 'dangling-join', message: `Join a tabla inexistente en "${table.name}".`, tableId: table.id, ref: step.table });
      }
    }
  }
  for (const rel of spec.relations) {
    const from = spec.tables.find((t) => t.id === rel.from.table);
    const to = spec.tables.find((t) => t.id === rel.to.table);
    if (!from || !to) {
      issues.push({ level: 'error', code: 'dangling-relation', message: `Relación ${rel.id} apunta a tabla inexistente.`, ref: rel.id });
      continue;
    }
    const fc = schemaAfterSteps(from).some((c) => c.id === rel.from.column);
    const tc = schemaAfterSteps(to).some((c) => c.id === rel.to.column);
    if (!fc || !tc) {
      issues.push({ level: 'error', code: 'dangling-relation-col', message: `Relación ${rel.id} apunta a columna inexistente.`, ref: rel.id });
    }
  }
  for (const m of spec.measures) {
    for (const c of exprColumns(m.expression)) {
      const known = spec.tables.some((t) => schemaAfterSteps(t).some((x) => x.id === c));
      if (!known) {
        issues.push({ level: 'error', code: 'dangling-measure', message: `Medida "${m.name}" usa columna inexistente.`, ref: m.id });
      }
    }
  }
  return issues;
}

export const hasErrors = (issues: ValidationIssue[]) => issues.some((i) => i.level === 'error');
