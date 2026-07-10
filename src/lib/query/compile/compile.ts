/**
 * IR → SQL compiler.
 *
 * Injection safety rests on three rules, all enforced here:
 *   1. IDENTIFIERS come only from the IR and are validated against the source
 *      allowlist, then quoted by the dialect. A column not on the allowlist
 *      throws `CompileError` — a tampered IR can't name an out-of-allowlist column.
 *   2. FILTER VALUES are always bound parameters (never interpolated). `limit`/
 *      `offset` are bound too.
 *   3. EXPRESSIONS are a closed algebra; each node maps to a fixed SQL fragment.
 *      Expression literals are inlined with strict escaping (so a calculated
 *      field reused in SELECT + GROUP BY doesn't desync the positional params).
 *
 * Joins and window functions are parsed into the IR but not yet compiled (M10).
 */

import type {
  Aggregation,
  Dimension,
  Expr,
  FieldRef,
  Filter,
  QueryIR,
  WindowSpec,
} from "@/lib/query/ir";
import { isAggregated } from "@/lib/query/ir";
import type { Dialect } from "./dialect";

export type ColumnRole = "dimension" | "metric" | "window" | "raw";

export interface CompiledColumn {
  name: string;
  role: ColumnRole;
}

export interface CompiledSql {
  sql: string;
  params: unknown[];
  columns: CompiledColumn[];
}

export interface CompileOptions {
  /**
   * Inline all values as escaped SQL literals instead of bound parameters.
   * Used for the LOCAL DuckDB path, whose `runSql` takes a bare string (no param
   * binding). Injection-safe: the same strict escaping as expression literals.
   */
  inline?: boolean;
  /**
   * Physical tables a JOIN may name (the introspected table allowlist). When set,
   * a join to any other table throws. Omit on the trusted local path (the draft
   * only ever produces tables the user picked from the same source).
   */
  allowedTables?: Set<string>;
}

const JOIN_SQL: Record<string, string> = {
  inner: "INNER JOIN",
  left: "LEFT JOIN",
  right: "RIGHT JOIN",
  full: "FULL JOIN",
};

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

const SCALAR_SQL: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

interface Ctx {
  dialect: Dialect;
  allowed: Set<string>;
  /** Physical table allowlist for JOINs (undefined ⇒ trusted, no check). */
  allowedTables?: Set<string>;
  params: unknown[];
  inline: boolean;
  /** Calculated field name → compiled SQL (inlined, param-free). */
  calc: Map<string, string>;
  /** Aggregation ordinal → its output alias (for order/having references). */
  aggAlias: string[];
}

export function compileIR(
  ir: QueryIR,
  dialect: Dialect,
  allowedColumns: Set<string>,
  options: CompileOptions = {},
): CompiledSql {
  const ctx: Ctx = {
    dialect,
    allowed: allowedColumns,
    allowedTables: options.allowedTables,
    params: [],
    inline: options.inline === true,
    calc: new Map(),
    aggAlias: [],
  };

  // 1. Compile calculated fields in order (each may reference earlier ones).
  for (const cf of ir.calculated ?? []) {
    ctx.calc.set(cf.name, compileExpr(cf.expr, ctx));
  }

  // 2. Pre-compute aggregation aliases so order/having can reference them.
  const aggs = ir.aggregations ?? [];
  aggs.forEach((agg, i) => {
    ctx.aggAlias[i] = agg.alias ?? defaultAggAlias(agg, i);
  });

  const dims = ir.dimensions ?? [];
  const aggregated = isAggregated(ir);

  // 3. SELECT list (no bound params — expression literals are inlined).
  const selectParts: string[] = [];
  const columns: CompiledColumn[] = [];
  // Names available to window functions + a window-wrapped ORDER BY (the inner
  // query's output columns).
  const outputCols = new Set<string>();

  if (aggregated) {
    dims.forEach((dim) => {
      const alias = dim.alias ?? defaultDimAlias(dim);
      selectParts.push(`${compileDimension(dim, ctx)} AS ${dialect.quoteIdent(alias)}`);
      columns.push({ name: alias, role: "dimension" });
      outputCols.add(alias);
    });
    aggs.forEach((agg, i) => {
      const alias = ctx.aggAlias[i];
      selectParts.push(`${compileAggregation(agg, ctx)} AS ${dialect.quoteIdent(alias)}`);
      columns.push({ name: alias, role: "metric" });
      outputCols.add(alias);
    });
  } else {
    selectParts.push("*");
    for (const name of ctx.allowed) outputCols.add(name); // SELECT * exposes them
    for (const cf of ir.calculated ?? []) {
      selectParts.push(`${ctx.calc.get(cf.name)} AS ${dialect.quoteIdent(cf.name)}`);
      columns.push({ name: cf.name, role: "raw" });
      outputCols.add(cf.name);
    }
  }

  // 4. FROM (+ JOINs).
  const from = fromClause(ir, ctx);

  // 5. WHERE (params bound here, left-to-right).
  const where = ir.filters ? compileFilter(ir.filters, ctx) : null;

  // 6. GROUP BY (only when there are dimensions).
  const groupBy =
    aggregated && dims.length > 0
      ? dims.map((dim) => compileDimension(dim, ctx)).join(", ")
      : null;

  // 7. HAVING.
  const having = ir.having ? compileFilter(ir.having, ctx) : null;

  const wins = ir.windows ?? [];
  const windowed = wins.length > 0;

  // Window functions wrap the base query: they're computed in an OUTER SELECT
  // over the (grouped/raw) base, so they see its output columns and run
  // post-aggregation. ORDER BY / LIMIT then apply to the windowed result.
  wins.forEach((w) => outputCols.add(w.alias));

  // 8. ORDER BY — resolves against output columns when windowed (the outer
  //    query's scope), else against the base fields.
  const orderBy =
    ir.order && ir.order.length > 0
      ? ir.order
          .map(
            (o) =>
              `${windowed ? resolveOutput(o.ref, ctx, outputCols) : resolveField(o.ref, ctx)} ${
                o.dir === "desc" ? "DESC" : "ASC"
              }`,
          )
          .join(", ")
      : null;

  // Base query (no ORDER/LIMIT here when windowed — those move to the wrapper).
  let base = `SELECT ${selectParts.join(", ")} FROM ${from}`;
  if (where) base += ` WHERE ${where}`;
  if (groupBy) base += ` GROUP BY ${groupBy}`;
  if (having) base += ` HAVING ${having}`;

  let sql: string;
  if (windowed) {
    const winSelect = wins
      .map((w) => `${compileWindow(w, ctx, outputCols)} AS ${dialect.quoteIdent(w.alias)}`)
      .join(", ");
    wins.forEach((w) => columns.push({ name: w.alias, role: "window" }));
    sql = `SELECT *, ${winSelect} FROM (${base}) AS ${dialect.quoteIdent("__base")}`;
  } else {
    sql = base;
  }

  if (orderBy) sql += ` ORDER BY ${orderBy}`;

  // 9. LIMIT / OFFSET (bound last, matching emission order).
  if (ir.limit !== undefined && Number.isFinite(ir.limit)) {
    sql += ` LIMIT ${bind(ctx, Math.max(0, Math.floor(ir.limit)))}`;
  }
  if (ir.offset !== undefined && Number.isFinite(ir.offset) && ir.offset > 0) {
    sql += ` OFFSET ${bind(ctx, Math.floor(ir.offset))}`;
  }

  return { sql, params: ctx.params, columns };
}

// ── Window functions (compiled in an outer SELECT over the base query) ──────────

/** Resolve a field ref against the base query's OUTPUT columns (window scope). */
function resolveOutput(ref: FieldRef, ctx: Ctx, outputCols: Set<string>): string {
  switch (ref.kind) {
    case "column":
    case "expression":
      if (!outputCols.has(ref.name)) {
        throw new CompileError(`"${ref.name}" is not an output column of the query.`);
      }
      return ctx.dialect.quoteIdent(ref.name);
    case "aggregation": {
      const alias = ctx.aggAlias[ref.index];
      if (alias === undefined) {
        throw new CompileError(`Aggregation index ${ref.index} is out of range.`);
      }
      return ctx.dialect.quoteIdent(alias);
    }
  }
}

function compileWindow(w: WindowSpec, ctx: Ctx, outputCols: Set<string>): string {
  const arg = (fallback: number) =>
    w.arg !== undefined && Number.isFinite(w.arg) ? Math.max(1, Math.floor(w.arg)) : fallback;
  const needField = (): string => {
    if (!w.field) throw new CompileError(`Window "${w.fn}" requires a field.`);
    return resolveOutput(w.field, ctx, outputCols);
  };

  let call: string;
  switch (w.fn) {
    case "row_number":
    case "rank":
    case "dense_rank":
      call = `${w.fn}()`;
      break;
    case "sum":
    case "avg":
      call = `${w.fn}(${needField()})`;
      break;
    case "lag":
    case "lead":
      call = `${w.fn}(${needField()}, ${arg(1)})`;
      break;
    case "ntile":
      call = `ntile(${arg(4)})`;
      break;
  }

  const parts: string[] = [];
  if (w.partitionBy && w.partitionBy.length > 0) {
    parts.push(`PARTITION BY ${w.partitionBy.map((f) => resolveOutput(f, ctx, outputCols)).join(", ")}`);
  }
  if (w.orderBy && w.orderBy.length > 0) {
    parts.push(
      `ORDER BY ${w.orderBy
        .map((o) => `${resolveOutput(o.field, ctx, outputCols)} ${o.dir === "desc" ? "DESC" : "ASC"}`)
        .join(", ")}`,
    );
  }
  // A frame only applies to the cumulative aggregates.
  if ((w.fn === "sum" || w.fn === "avg") && w.frame) {
    parts.push(
      w.frame === "running"
        ? "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"
        : "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING",
    );
  }

  return `${call} OVER (${parts.join(" ")})`;
}

// ── FROM ──────────────────────────────────────────────────────────────────────

function fromClause(ir: QueryIR, ctx: Ctx): string {
  const d = ctx.dialect;
  let sql = d.quoteIdent(ir.source.table);
  if (ir.source.alias) sql += ` AS ${d.quoteIdent(ir.source.alias)}`;

  for (const j of ir.joins ?? []) {
    if (ctx.allowedTables && !ctx.allowedTables.has(j.table)) {
      throw new CompileError(`Join table "${j.table}" is not in the source allowlist.`);
    }
    const kind = JOIN_SQL[j.type];
    if (!kind) throw new CompileError(`Unknown join type "${j.type}".`);
    const on =
      j.on.length > 0
        ? j.on.map((c) => `${resolveField(c.left, ctx)} = ${resolveField(c.right, ctx)}`).join(" AND ")
        : "TRUE";
    sql += ` ${kind} ${d.quoteIdent(j.table)} AS ${d.quoteIdent(j.alias)} ON ${on}`;
  }
  return sql;
}

// ── Field resolution ───────────────────────────────────────────────────────────

function resolveField(ref: FieldRef, ctx: Ctx): string {
  switch (ref.kind) {
    case "column": {
      if (!ctx.allowed.has(ref.name)) {
        throw new CompileError(`Column "${ref.name}" is not in the source allowlist.`);
      }
      const qcol = ctx.dialect.quoteIdent(ref.name);
      // Table-qualified refs (joins) → `alias.col`; the qualifier is a
      // query-defined alias, quoted, never interpolated.
      return ref.table ? `${ctx.dialect.quoteIdent(ref.table)}.${qcol}` : qcol;
    }
    case "expression": {
      const sql = ctx.calc.get(ref.name);
      if (sql === undefined) {
        throw new CompileError(`Unknown calculated field "${ref.name}".`);
      }
      return `(${sql})`;
    }
    case "aggregation": {
      const alias = ctx.aggAlias[ref.index];
      if (alias === undefined) {
        throw new CompileError(`Aggregation index ${ref.index} is out of range.`);
      }
      return ctx.dialect.quoteIdent(alias);
    }
  }
}

// ── Dimensions + aggregations ───────────────────────────────────────────────────

function compileDimension(dim: Dimension, ctx: Ctx): string {
  const base = resolveField(dim.field, ctx);
  return dim.temporal ? ctx.dialect.temporalBucket(dim.temporal, base) : base;
}

function compileAggregation(agg: Aggregation, ctx: Ctx): string {
  const argSql = agg.field ? resolveField(agg.field, ctx) : null;
  const distinct = agg.distinct === true || agg.fn === "count_distinct";
  if (agg.fn !== "count" && agg.fn !== "count_distinct" && argSql === null) {
    throw new CompileError(`Aggregation "${agg.fn}" requires a field.`);
  }
  return ctx.dialect.aggregate(agg.fn, argSql, distinct);
}

// ── Expressions (closed algebra; literals inlined) ───────────────────────────────

function compileExpr(expr: Expr, ctx: Ctx): string {
  switch (expr.op) {
    case "field":
      return resolveField(expr.ref, ctx);
    case "lit":
      return literal(expr.value);
    case "binary":
      return `(${compileExpr(expr.left, ctx)} ${expr.operator} ${compileExpr(expr.right, ctx)})`;
    case "fn": {
      const args = expr.args.map((a) => compileExpr(a, ctx));
      return `${expr.name}(${args.join(", ")})`;
    }
    case "case": {
      const whens = expr.whens
        .map((w) => `WHEN ${compileFilter(w.when, ctx)} THEN ${compileExpr(w.then, ctx)}`)
        .join(" ");
      const els = expr.else !== undefined ? ` ELSE ${compileExpr(expr.else, ctx)}` : "";
      return `CASE ${whens}${els} END`;
    }
  }
}

/** Inline a literal with strict escaping (never a bound param — see header). */
function literal(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CompileError("Non-finite numeric literal.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${value.replace(/'/g, "''")}'`;
}

// ── Filters ──────────────────────────────────────────────────────────────────────

function compileFilter(f: Filter, ctx: Ctx): string {
  switch (f.op) {
    case "and":
      if (f.clauses.length === 0) return "TRUE";
      return `(${f.clauses.map((c) => compileFilter(c, ctx)).join(" AND ")})`;
    case "or":
      if (f.clauses.length === 0) return "FALSE";
      return `(${f.clauses.map((c) => compileFilter(c, ctx)).join(" OR ")})`;
    case "not":
      return `NOT (${compileFilter(f.clause, ctx)})`;
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return `${resolveField(f.field, ctx)} ${SCALAR_SQL[f.op]} ${bind(ctx, f.value)}`;
    case "contains":
      return like(ctx, f.field, `%${escapeLike(f.value)}%`);
    case "starts_with":
      return like(ctx, f.field, `${escapeLike(f.value)}%`);
    case "ends_with":
      return like(ctx, f.field, `%${escapeLike(f.value)}`);
    case "in":
    case "not_in": {
      if (f.values.length === 0) return f.op === "in" ? "FALSE" : "TRUE";
      const placeholders = f.values.map((v) => bind(ctx, v)).join(", ");
      const not = f.op === "not_in" ? "NOT " : "";
      return `${resolveField(f.field, ctx)} ${not}IN (${placeholders})`;
    }
    case "between":
      return `${resolveField(f.field, ctx)} BETWEEN ${bind(ctx, f.low)} AND ${bind(ctx, f.high)}`;
    case "is_null":
      return `${resolveField(f.field, ctx)} IS NULL`;
    case "not_null":
      return `${resolveField(f.field, ctx)} IS NOT NULL`;
    case "relative_date":
      return ctx.dialect.relativeDate(f.relative, resolveField(f.field, ctx));
  }
}

function like(ctx: Ctx, field: FieldRef, pattern: string): string {
  return `${resolveField(field, ctx)} LIKE ${bind(ctx, pattern)}${ctx.dialect.likeEscapeClause()}`;
}

/** Escape LIKE metacharacters in a user value (paired with ` ESCAPE '\'`). */
function escapeLike(value: string | number | boolean): string {
  return String(value).replace(/([\\%_])/g, "\\$1");
}

// ── Params ─────────────────────────────────────────────────────────────────────

function bind(ctx: Ctx, value: string | number | boolean): string {
  if (ctx.inline) return literal(value);
  const placeholder = ctx.dialect.placeholder(ctx.params.length);
  ctx.params.push(value);
  return placeholder;
}

// ── Default aliases ──────────────────────────────────────────────────────────────

function deriveName(ref: FieldRef): string {
  switch (ref.kind) {
    case "column":
      return ref.name;
    case "expression":
      return ref.name;
    case "aggregation":
      return `agg_${ref.index}`;
  }
}

function defaultDimAlias(dim: Dimension): string {
  const base = deriveName(dim.field);
  return dim.temporal ? `${base}_${dim.temporal}` : base;
}

function defaultAggAlias(agg: Aggregation, index: number): string {
  if (agg.fn === "count" && !agg.field) return "count";
  return agg.field ? `${agg.fn}_${deriveName(agg.field)}` : `${agg.fn}_${index}`;
}
