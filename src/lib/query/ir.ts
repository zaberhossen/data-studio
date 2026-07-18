/**
 * Query IR — the advanced builder's canonical representation (MBQL-like).
 *
 * The builder edits a `QueryIR`; the compiler (`compile/`) turns it into
 * dialect-aware SQL that runs LOCAL (DuckDB) or PUSHDOWN (a live DB connector).
 * This IR crosses NO Rust boundary — the legacy `Query` (`types/analytics.ts`)
 * stays frozen as the Rust fast-path shape — so this file uses natural camelCase
 * and is free of serde's snake_case coupling.
 *
 * It is plain, JSON-serializable data (persisted inside `QueryDefinition.ir`).
 * Injection-safety lives in the compiler, but the IR is designed to make it easy:
 * expressions are a CLOSED algebra (no free SQL text), and every column name is
 * validated against the source allowlist at compile time.
 */

/** IR schema version. The legacy `Query` is implicitly v1. */
export const QUERY_IR_VERSION = 2;

// ── References ────────────────────────────────────────────────────────────────

/**
 * A reference to a value in the query.
 * - `column`     → a physical column (optionally table-qualified for joins).
 * - `expression` → a calculated field defined in `QueryIR.calculated`.
 * - `aggregation`→ an ordinal reference to `QueryIR.aggregations[index]` (used by
 *                  `order`/`having` so they don't depend on fragile alias strings).
 */
export type FieldRef =
  | { kind: "column"; table?: string; name: string }
  | { kind: "expression"; name: string }
  | { kind: "aggregation"; index: number };

export function col(name: string, table?: string): FieldRef {
  return table ? { kind: "column", table, name } : { kind: "column", name };
}

// ── Temporal bucketing ───────────────────────────────────────────────────────

export type TemporalUnit =
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | "day_of_week"
  | "month_of_year";

// ── Dimensions + aggregations ────────────────────────────────────────────────

/**
 * Numeric binning for a dimension — groups a numeric field into fixed-width
 * ranges; the group value is the bin's lower edge (`floor(x/width)*width`).
 * Mutually exclusive with `temporal`.
 */
export interface NumericBin {
  /** Bin width (> 0). */
  width: number;
}

export interface Dimension {
  field: FieldRef;
  /** Bucket a date/timestamp field (day/week/month/…). */
  temporal?: TemporalUnit;
  /** Bin a numeric field into fixed-width ranges. Exclusive with `temporal`. */
  bin?: NumericBin;
  /** Output column alias; defaults derived from the field. */
  alias?: string;
}

export type AggFn =
  | "sum"
  | "avg"
  | "count"
  | "count_distinct"
  | "min"
  | "max"
  | "median"
  | "stddev"
  | "variance"
  | "percentile"
  | "count_if"
  | "sum_if";

export interface Aggregation {
  fn: AggFn;
  /** Omitted for `count`/`count_if` (→ COUNT(*) forms). */
  field?: FieldRef;
  alias?: string;
  /** COUNT(DISTINCT …) etc. (also implied by `count_distinct`). */
  distinct?: boolean;
  /** Percentile fraction in (0,1) — required for `percentile`. */
  p?: number;
  /** Conditional predicate — required for `count_if` / `sum_if`. */
  filter?: Filter;
}

// ── Calculated fields (closed expression algebra) ────────────────────────────

export type ExprFn =
  | "coalesce"
  | "concat"
  | "lower"
  | "upper"
  | "abs"
  | "round"
  | "extract"
  | "date_trunc";

export type Expr =
  | { op: "field"; ref: FieldRef }
  | { op: "lit"; value: string | number | boolean | null }
  | { op: "binary"; operator: "+" | "-" | "*" | "/" | "%"; left: Expr; right: Expr }
  | { op: "fn"; name: ExprFn; args: Expr[] }
  | { op: "case"; whens: Array<{ when: Filter; then: Expr }>; else?: Expr };

export interface CalculatedField {
  name: string;
  expr: Expr;
}

// ── Filters ──────────────────────────────────────────────────────────────────

export type ScalarOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts_with"
  | "ends_with";

export interface RelativeDate {
  direction: "last" | "next" | "current";
  /** Number of units (ignored for `current`). */
  count?: number;
  unit: "day" | "week" | "month" | "quarter" | "year";
}

export type Filter =
  | { op: ScalarOp; field: FieldRef; value: string | number | boolean }
  | { op: "in" | "not_in"; field: FieldRef; values: Array<string | number | boolean> }
  | { op: "between"; field: FieldRef; low: number | string; high: number | string }
  | { op: "is_null" | "not_null"; field: FieldRef }
  | { op: "relative_date"; field: FieldRef; relative: RelativeDate }
  | { op: "and" | "or"; clauses: Filter[] }
  | { op: "not"; clause: Filter };

// ── Joins ────────────────────────────────────────────────────────────────────

export type JoinType = "inner" | "left" | "right" | "full";

export interface Join {
  table: string;
  alias: string;
  type: JoinType;
  /** Equi-conditions, ANDed together. */
  on: Array<{ left: FieldRef; right: FieldRef }>;
}

// ── Window functions ─────────────────────────────────────────────────────────

export type WindowFn =
  | "row_number"
  | "rank"
  | "dense_rank"
  | "sum"
  | "avg"
  | "lag"
  | "lead"
  | "ntile";

export interface WindowSpec {
  fn: WindowFn;
  field?: FieldRef;
  partitionBy?: FieldRef[];
  orderBy?: Array<{ field: FieldRef; dir: "asc" | "desc" }>;
  /** running total = rows unbounded-preceding → current row. */
  frame?: "running" | "unbounded";
  /** Integer arg: bucket count for `ntile`, row offset for `lag`/`lead`. */
  arg?: number;
  alias: string;
}

// ── Order ────────────────────────────────────────────────────────────────────

export interface OrderBy {
  ref: FieldRef;
  dir: "asc" | "desc";
}

// ── The query ────────────────────────────────────────────────────────────────

/**
 * A query's FROM target. Either a physical `table` or a nested `query` (a
 * MULTI-STAGE query: the inner query is compiled as a subquery, and the outer
 * stage references its OUTPUT columns). Nested queries run LOCAL only.
 */
export type QuerySource =
  | { table: string; alias?: string }
  | { query: QueryIR; alias?: string };

/** Narrow a source to its nested-query variant. */
export function isQuerySource(
  s: QuerySource,
): s is { query: QueryIR; alias?: string } {
  return "query" in s;
}

export interface QueryIR {
  version: 2;
  source: QuerySource;
  joins?: Join[];
  calculated?: CalculatedField[];
  /**
   * Raw-mode column selection (unaggregated listings only): the columns the
   * SELECT list keeps, in order. Omitted/empty ⇒ `SELECT *`. Ignored when the
   * query aggregates (dimensions/aggregations define the output there).
   */
  fields?: FieldRef[];
  filters?: Filter;
  /** GROUP BY set. Empty + no aggregations ⇒ a raw row listing. */
  dimensions?: Dimension[];
  aggregations?: Aggregation[];
  /** Computed post-aggregation. */
  windows?: WindowSpec[];
  having?: Filter;
  order?: OrderBy[];
  limit?: number;
  offset?: number;
}

/** True if the IR aggregates (has dimensions or aggregations). */
export function isAggregated(ir: QueryIR): boolean {
  return Boolean(
    (ir.dimensions && ir.dimensions.length > 0) ||
      (ir.aggregations && ir.aggregations.length > 0),
  );
}

/**
 * Every column identifier referenced anywhere in an IR (a deep walk collecting
 * `{ kind: "column" }` FieldRefs). Used as the compiler allowlist when running a
 * TRUSTED, already-validated IR locally — the identifiers are exactly the ones
 * the validated draft produced, so this is a faithful (not permissive) allowlist.
 */
export function irColumns(ir: QueryIR): Set<string> {
  const cols = new Set<string>();
  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    const o = v as Record<string, unknown>;
    if (o.kind === "column" && typeof o.name === "string") cols.add(o.name);
    for (const key of Object.keys(o)) visit(o[key]);
  };
  visit(ir);
  return cols;
}
