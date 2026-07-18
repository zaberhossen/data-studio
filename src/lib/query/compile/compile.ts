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
 * Joins compile with table/column allowlist validation (`CompileOptions.
 * allowedTables`); window functions compile as an outer SELECT wrapper over
 * the aggregated base query.
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
import { isAggregated, isQuerySource } from "@/lib/query/ir";
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

/**
 * Validate + return a percentile fraction in (0,1). Inlined into SQL directly
 * (a finite number, never user text), so dialects can splice it safely.
 */
export function percentileFraction(p: number | undefined): number {
  if (p === undefined || !Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new CompileError("Percentile requires a fraction strictly between 0 and 1.");
  }
  return p;
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
  /** The IR's aggregations (for re-emitting the aggregate expression in HAVING). */
  aggs: Aggregation[];
  /**
   * How an aggregation ref renders: `"alias"` (SELECT/ORDER BY scope) or
   * `"expr"` (HAVING scope — Postgres forbids SELECT aliases in HAVING, so the
   * aggregate expression is repeated there; valid in every dialect).
   */
  aggMode: "alias" | "expr";
}

export function compileIR(
  ir: QueryIR,
  dialect: Dialect,
  allowedColumns: Set<string>,
  options: CompileOptions = {},
): CompiledSql {
  const root: Ctx = {
    dialect,
    allowed: allowedColumns,
    allowedTables: options.allowedTables,
    params: [],
    inline: options.inline === true,
    calc: new Map(),
    aggAlias: [],
    aggs: [],
    aggMode: "alias",
  };
  const { sql, columns } = compileQuery(ir, root);
  return { sql, params: root.params, columns };
}

/**
 * Compile one query LEVEL. Multi-stage queries recurse through `fromClause`
 * (a nested-query source), each level getting a fresh ctx that SHARES the
 * parent's `params` array (so bound params stay in emission order) but resets
 * the per-level calc/aggregation scope.
 */
function compileQuery(ir: QueryIR, parent: Ctx): { sql: string; columns: CompiledColumn[] } {
  const ctx: Ctx = {
    ...parent,
    calc: new Map(),
    aggAlias: [],
    aggs: ir.aggregations ?? [],
    aggMode: "alias",
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
      selectParts.push(`${compileDimension(dim, ctx)} AS ${ctx.dialect.quoteIdent(alias)}`);
      columns.push({ name: alias, role: "dimension" });
      outputCols.add(alias);
    });
    aggs.forEach((agg, i) => {
      const alias = ctx.aggAlias[i];
      selectParts.push(`${compileAggregation(agg, ctx)} AS ${ctx.dialect.quoteIdent(alias)}`);
      columns.push({ name: alias, role: "metric" });
      outputCols.add(alias);
    });
  } else if (ir.fields && ir.fields.length > 0) {
    // Explicit raw-mode column selection.
    for (const ref of ir.fields) {
      if (ref.kind === "aggregation") {
        throw new CompileError("`fields` cannot reference an aggregation.");
      }
      const name = ref.name;
      selectParts.push(
        ref.kind === "column"
          ? resolveField(ref, ctx)
          : `${resolveField(ref, ctx)} AS ${ctx.dialect.quoteIdent(name)}`,
      );
      columns.push({ name, role: "raw" });
      outputCols.add(name);
    }
    for (const cf of ir.calculated ?? []) {
      if (outputCols.has(cf.name)) continue; // already selected via `fields`
      selectParts.push(`${ctx.calc.get(cf.name)} AS ${ctx.dialect.quoteIdent(cf.name)}`);
      columns.push({ name: cf.name, role: "raw" });
      outputCols.add(cf.name);
    }
  } else {
    selectParts.push("*");
    for (const name of ctx.allowed) outputCols.add(name); // SELECT * exposes them
    for (const cf of ir.calculated ?? []) {
      selectParts.push(`${ctx.calc.get(cf.name)} AS ${ctx.dialect.quoteIdent(cf.name)}`);
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

  // 7. HAVING — aggregation refs render as the aggregate EXPRESSION here (see
  //    Ctx.aggMode): Postgres rejects SELECT aliases inside HAVING.
  ctx.aggMode = "expr";
  const having = ir.having ? compileFilter(ir.having, ctx) : null;
  ctx.aggMode = "alias";

  const wins = ir.windows ?? [];
  const windowed = wins.length > 0;

  // Window functions wrap the base query: they're computed in an OUTER SELECT
  // over the (grouped/raw) base, so they see its output columns and run
  // post-aggregation. ORDER BY / LIMIT then apply to the windowed result.
  wins.forEach((w) => outputCols.add(w.alias));

  // 8. ORDER BY — resolves against output columns when windowed (the outer
  //    query's scope). Otherwise output ALIASES win first for aggregated
  //    queries (every dialect lets ORDER BY reference SELECT aliases, and a
  //    bucketed dimension's raw column would be invalid under GROUP BY),
  //    falling back to base-field resolution.
  const resolveOrder = (ref: FieldRef): string => {
    if (windowed) return resolveOutput(ref, ctx, outputCols);
    if (aggregated && ref.kind === "column" && !ref.table && outputCols.has(ref.name)) {
      return ctx.dialect.quoteIdent(ref.name);
    }
    return resolveField(ref, ctx);
  };
  const orderBy =
    ir.order && ir.order.length > 0
      ? ir.order
          .map((o) => `${resolveOrder(o.ref)} ${o.dir === "desc" ? "DESC" : "ASC"}`)
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
      .map((w) => `${compileWindow(w, ctx, outputCols)} AS ${ctx.dialect.quoteIdent(w.alias)}`)
      .join(", ");
    wins.forEach((w) => columns.push({ name: w.alias, role: "window" }));
    sql = `SELECT *, ${winSelect} FROM (${base}) AS ${ctx.dialect.quoteIdent("__base")}`;
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

  return { sql, columns };
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
  let sql: string;
  if (isQuerySource(ir.source)) {
    // Multi-stage: the inner query compiles as a subquery; its params emit here
    // (textually before the outer WHERE), preserving positional order. The alias
    // is required so the outer stage can reference the subquery's columns.
    const alias = ir.source.alias ?? "__stage";
    const inner = compileQuery(ir.source.query, ctx);
    sql = `(${inner.sql}) AS ${d.quoteIdent(alias)}`;
  } else {
    sql = d.quoteIdent(ir.source.table);
    if (ir.source.alias) sql += ` AS ${d.quoteIdent(ir.source.alias)}`;
  }

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
      const agg = ctx.aggs[ref.index];
      if (agg === undefined) {
        throw new CompileError(`Aggregation index ${ref.index} is out of range.`);
      }
      return ctx.aggMode === "expr"
        ? compileAggregation(agg, ctx)
        : ctx.dialect.quoteIdent(ctx.aggAlias[ref.index]);
    }
  }
}

// ── Dimensions + aggregations ───────────────────────────────────────────────────

function compileDimension(dim: Dimension, ctx: Ctx): string {
  const base = resolveField(dim.field, ctx);
  if (dim.temporal) return ctx.dialect.temporalBucket(dim.temporal, base);
  if (dim.bin) {
    const w = dim.bin.width;
    if (!Number.isFinite(w) || w <= 0) {
      throw new CompileError("Bin width must be a positive number.");
    }
    return ctx.dialect.numericBin(w, base);
  }
  return base;
}

function compileAggregation(agg: Aggregation, ctx: Ctx): string {
  // Conditional aggregates compile to CASE expressions (uniform across dialects).
  // Their predicate literals are always INLINED (never bound): the aggregate may
  // be re-emitted in HAVING (aggMode "expr"), and bound params would desync.
  if (agg.fn === "count_if" || agg.fn === "sum_if") {
    if (!agg.filter) throw new CompileError(`"${agg.fn}" requires a condition.`);
    const cond = compileFilter(agg.filter, { ...ctx, inline: true });
    if (agg.fn === "count_if") return `count(CASE WHEN ${cond} THEN 1 END)`;
    if (!agg.field) throw new CompileError(`"sum_if" requires a field.`);
    return `sum(CASE WHEN ${cond} THEN ${resolveField(agg.field, ctx)} END)`;
  }

  const argSql = agg.field ? resolveField(agg.field, ctx) : null;
  const distinct = agg.distinct === true || agg.fn === "count_distinct";
  if (agg.fn !== "count" && agg.fn !== "count_distinct" && argSql === null) {
    throw new CompileError(`Aggregation "${agg.fn}" requires a field.`);
  }
  return ctx.dialect.aggregate(agg.fn, argSql, distinct, agg.p);
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
  if (dim.temporal) return `${base}_${dim.temporal}`;
  if (dim.bin) return `${base}_bin`;
  return base;
}

function defaultAggAlias(agg: Aggregation, index: number): string {
  if (agg.fn === "count" && !agg.field) return "count";
  if (agg.fn === "count_if") return "count_if";
  return agg.field ? `${agg.fn}_${deriveName(agg.field)}` : `${agg.fn}_${index}`;
}
