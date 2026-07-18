/**
 * Advanced (IR) builder draft — the loose, string-typed, UI-facing model the
 * advanced query builder binds to, plus `compileIrDraft` which validates it into
 * a strict `QueryIR`. Pure — safe to run on every keystroke for live preview.
 *
 * The draft mirrors the full IR surface (M12 Stage 1):
 *   • filters as a TREE (AND/OR groups with NOT) — no longer a flat AND list
 *   • HAVING conditions over the metrics (post-aggregation)
 *   • multi-key sort over any OUTPUT column (dimension/metric/window alias)
 *   • dimension + metric aliases
 *   • multi-condition joins with an optional alias
 *   • multi-column window partition/order
 *   • calculated fields as FORMULA TEXT (`expr-text.ts` parses the closed
 *     algebra: arithmetic, functions, case/when)
 *   • limit + offset
 *
 * `irToDraft` is the inverse; with the tree/formula model it is lossless for
 * everything the UI can express, and reports anything it can't via the
 * optional `warnings` collector instead of silently dropping it.
 */

import {
  col,
  isQuerySource,
  type Aggregation,
  type AggFn,
  type CalculatedField,
  type Dimension,
  type Expr,
  type FieldRef,
  type Filter,
  type Join,
  type JoinType,
  type NumericBin,
  type QueryIR,
  type RelativeDate,
  type TemporalUnit,
  type WindowFn,
  type WindowSpec,
} from "@/lib/query/ir";
import { formatExprText, parseExprText } from "@/lib/query/expr-text";
import type { DataType, Field } from "@/lib/query/schema";

// ── Operator + aggregation metadata (IR-level) ───────────────────────────────

/** Filter operators offered by the advanced builder UI. */
export type IrFilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"
  | "between"
  | "is_null"
  | "not_null"
  | "relative_date";

export const IR_OPERATOR_LABELS: Record<IrFilterOp, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
  in: "in",
  not_in: "not in",
  between: "between",
  is_null: "is empty",
  not_null: "is not empty",
  relative_date: "relative date",
};

export const IR_AGG_LABELS: Record<AggFn, string> = {
  sum: "SUM",
  avg: "AVG",
  count: "COUNT",
  count_distinct: "COUNT DISTINCT",
  min: "MIN",
  max: "MAX",
  median: "MEDIAN",
  stddev: "STDDEV",
  variance: "VARIANCE",
  percentile: "PERCENTILE",
  count_if: "COUNT IF",
  sum_if: "SUM IF",
};

export const ALL_IR_AGG_FNS: AggFn[] = [
  "sum",
  "avg",
  "count",
  "count_distinct",
  "min",
  "max",
  "median",
  "stddev",
  "variance",
  "percentile",
  "count_if",
  "sum_if",
];

/** Aggregations that take a conditional predicate (count_if / sum_if). */
const CONDITIONAL_AGG_FNS: ReadonlySet<AggFn> = new Set(["count_if", "sum_if"]);
export function aggIsConditional(fn: AggFn): boolean {
  return CONDITIONAL_AGG_FNS.has(fn);
}
/** Aggregations that need a value column (everything except count / count_if). */
export function aggNeedsColumn(fn: AggFn): boolean {
  return fn !== "count" && fn !== "count_if";
}
/** Aggregations that take a percentile fraction. */
export function aggTakesFraction(fn: AggFn): boolean {
  return fn === "percentile";
}

/** Temporal buckets offered for a date dimension. */
export const TEMPORAL_UNITS: TemporalUnit[] = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "day_of_week",
  "month_of_year",
];

export const TEMPORAL_LABELS: Record<TemporalUnit, string> = {
  minute: "Minute",
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
  day_of_week: "Day of week",
  month_of_year: "Month of year",
};

/** Which IR operators make sense for a column data-type. */
export function irOperatorsFor(dataType: DataType): IrFilterOp[] {
  switch (dataType) {
    case "number":
      return ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "not_in", "is_null", "not_null"];
    case "date":
      return ["eq", "neq", "gt", "gte", "lt", "lte", "between", "relative_date", "is_null", "not_null"];
    case "boolean":
      return ["eq", "neq", "is_null", "not_null"];
    case "string":
    default:
      return ["eq", "neq", "contains", "starts_with", "ends_with", "in", "not_in", "is_null", "not_null"];
  }
}

const NO_VALUE_OPS: ReadonlySet<IrFilterOp> = new Set(["is_null", "not_null"]);
const MULTI_VALUE_OPS: ReadonlySet<IrFilterOp> = new Set(["in", "not_in"]);

export function irOpTakesNoValue(op: IrFilterOp): boolean {
  return NO_VALUE_OPS.has(op);
}
export function irOpTakesMultiValue(op: IrFilterOp): boolean {
  return MULTI_VALUE_OPS.has(op);
}

/** Operators offered for HAVING conditions (metric values are numeric). */
export type HavingOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between";
export const HAVING_OPS: HavingOp[] = ["gt", "gte", "lt", "lte", "eq", "neq", "between"];

// ── Window functions ─────────────────────────────────────────────────────────

export const ALL_WINDOW_FNS: WindowFn[] = [
  "row_number",
  "rank",
  "dense_rank",
  "sum",
  "avg",
  "lag",
  "lead",
  "ntile",
];

export const IR_WINDOW_LABELS: Record<WindowFn, string> = {
  row_number: "Row number",
  rank: "Rank",
  dense_rank: "Dense rank",
  sum: "Running / windowed SUM",
  avg: "Running / windowed AVG",
  lag: "Previous value (lag)",
  lead: "Next value (lead)",
  ntile: "Ntile bucket",
};

const WINDOW_NEEDS_FIELD: ReadonlySet<WindowFn> = new Set(["sum", "avg", "lag", "lead"]);
const WINDOW_TAKES_ARG: ReadonlySet<WindowFn> = new Set(["ntile", "lag", "lead"]);
const WINDOW_FRAMEABLE: ReadonlySet<WindowFn> = new Set(["sum", "avg"]);

export function windowNeedsField(fn: WindowFn): boolean {
  return WINDOW_NEEDS_FIELD.has(fn);
}
export function windowTakesArg(fn: WindowFn): boolean {
  return WINDOW_TAKES_ARG.has(fn);
}
export function windowFrameable(fn: WindowFn): boolean {
  return WINDOW_FRAMEABLE.has(fn);
}

// ── Draft model (loose, string-typed, carries UI ids) ────────────────────────

/** A single condition for a conditional aggregate (count_if / sum_if). */
export interface DraftMetricCond {
  column: string;
  op: IrFilterOp;
  value: string;
}

export interface DraftMetric {
  id: string;
  fn: AggFn;
  /** Column to aggregate; ignored for `count` / `count_if`. */
  column: string;
  /** Output alias (defaults derived from fn + column). */
  alias?: string;
  /** Percentile fraction input (accepts 0–1 or 0–100), for `percentile`. */
  p?: string;
  /** Predicate for `count_if` / `sum_if`. */
  cond?: DraftMetricCond;
}

export interface DraftDimension {
  id: string;
  column: string;
  /** Temporal bucket (date columns only). */
  temporal?: TemporalUnit;
  /** Numeric bin width input (numeric columns only). Exclusive with temporal. */
  bin?: string;
  /** Output alias (defaults derived from column + bucket/bin). */
  alias?: string;
}

export interface DraftRelative {
  direction: RelativeDate["direction"];
  count: string;
  unit: RelativeDate["unit"];
}

/** A leaf condition in the filter tree. */
export interface DraftIrFilter {
  id: string;
  kind: "leaf";
  column: string;
  op: IrFilterOp;
  /** Scalar input (raw string, coerced at compile time). */
  value: string;
  /** Multi-value input for in / not_in. */
  values: string[];
  /** between bounds. */
  low: string;
  high: string;
  /** relative_date input. */
  relative: DraftRelative;
}

/** An AND/OR group in the filter tree (optionally negated). */
export interface DraftFilterGroup {
  id: string;
  kind: "group";
  op: "and" | "or";
  not: boolean;
  children: DraftFilterNode[];
}

export type DraftFilterNode = DraftIrFilter | DraftFilterGroup;

export function isDraftGroup(node: DraftFilterNode): node is DraftFilterGroup {
  return node.kind === "group";
}

/** A post-aggregation condition over one of the metrics. */
export interface DraftHaving {
  id: string;
  /** Index into `metrics`. */
  metricIndex: number | null;
  op: HavingOp;
  value: string;
  low: string;
  high: string;
}

/** One sort key over an OUTPUT column (dimension/metric/window alias). */
export interface DraftSort {
  id: string;
  column: string;
  dir: "asc" | "desc";
}

/** A calculated field: a named formula over the closed expression algebra. */
export interface DraftCalc {
  id: string;
  name: string;
  /** Formula text, e.g. `[revenue] - [cost]` or `case when [qty] > 9 then 'big' else 'small' end`. */
  text: string;
}

/** A window-function column (running total, rank, lag/lead, ntile…). */
export interface DraftWindow {
  id: string;
  fn: WindowFn;
  /** Value column (for sum/avg/lag/lead) — an OUTPUT column name. */
  column: string;
  /** Partition columns (OUTPUT column names). */
  partitions: string[];
  /** Order keys (OUTPUT column names). */
  orders: Array<{ id: string; column: string; dir: "asc" | "desc" }>;
  /** Cumulative frame for sum/avg (running total). */
  running: boolean;
  /** Bucket count (ntile) / row offset (lag/lead). */
  arg: string;
  /** Output alias (auto-derived when blank). */
  alias: string;
}

/** One equi-condition of a join. */
export interface DraftJoinCondition {
  id: string;
  /** Base-side key column (a column of the source table). */
  left: string;
  /** Joined-table key column. */
  right: string;
}

/** A join to another table in the same (live) source. */
export interface DraftJoin {
  id: string;
  /** Physical table to join (validated server-side against the allowlist). */
  table: string;
  /** Optional alias (defaults to the table name). */
  alias?: string;
  type: JoinType;
  /** Equi-conditions, ANDed together. */
  conditions: DraftJoinCondition[];
}

export interface IrDraft {
  /**
   * Raw-mode column selection (the data step's column picker): the source
   * columns a non-aggregated listing keeps. Empty ⇒ all columns. Ignored when
   * the query aggregates.
   */
  rawColumns?: string[];
  dimensions: DraftDimension[];
  metrics: DraftMetric[];
  /** Filter tree roots — ANDed together at the top level. */
  filters: DraftFilterNode[];
  /** Post-aggregation conditions (ANDed). */
  having: DraftHaving[];
  /** Joins to other tables (live DB / pushdown only). */
  joins?: DraftJoin[];
  /** Calculated fields (formulas over the closed algebra). */
  calculated?: DraftCalc[];
  /** Window-function columns (computed over the query's output). */
  windows?: DraftWindow[];
  /** Sort keys over output columns, applied in order. */
  sort: DraftSort[];
  limit: number;
  offset: number;
  /**
   * A follow-up stage (multi-stage query): another draft that runs over THIS
   * stage's output columns. Compiles to a nested-query source (subquery). The
   * base stage's limit/offset are dropped when it feeds a next stage.
   */
  nextStage?: IrDraft;
}

export interface IrCompileResult {
  ir: QueryIR | null;
  errors: string[];
}

// ── Coercion + compilation ───────────────────────────────────────────────────

type Scalar = string | number | boolean;

function coerce(raw: string, dataType: DataType): Scalar | null {
  const v = raw.trim();
  if (v === "") return null;
  switch (dataType) {
    case "number": {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      if (v === "true") return true;
      if (v === "false") return false;
      return null;
    case "date":
    case "string":
    default:
      return v;
  }
}

export interface CompileDraftOptions {
  /**
   * Allow a bare `SELECT *` listing with no dims/metrics/calc/windows/joins —
   * used by the per-step preview (the data step IS a bare listing).
   */
  allowBare?: boolean;
}

export function compileIrDraft(
  draft: IrDraft,
  fields: Field[],
  table = "dataset",
  options: CompileDraftOptions = {},
): IrCompileResult {
  const errors: string[] = [];
  const byName = new Map(fields.map((f) => [f.name, f]));

  // --- Calculated fields (formulas; may reference earlier calc fields) ---
  const calculated: CalculatedField[] = [];
  const calcNames = new Set<string>();
  (draft.calculated ?? []).forEach((c, i) => {
    const label = `Calculated field ${i + 1}`;
    const name = c.name.trim();
    if (!name) {
      errors.push(`${label}: give it a name.`);
      return;
    }
    if (calcNames.has(name) || byName.has(name)) {
      errors.push(`${label}: the name “${name}” is already taken.`);
      return;
    }
    const { expr, error } = parseExprText(c.text);
    if (!expr) {
      errors.push(`${label}: ${error ?? "invalid formula."}`);
      return;
    }
    const resolved = resolveExprRefs(expr, byName, calcNames, label, errors);
    if (!resolved) return;
    calcNames.add(name);
    calculated.push({ name, expr: resolved });
  });

  // --- Dimensions (a dimension may be a source column or a calculated field) ---
  const dimensions: Dimension[] = [];
  draft.dimensions.forEach((d, i) => {
    const isCalc = calcNames.has(d.column);
    const field = byName.get(d.column);
    if (!field && !isCalc) {
      errors.push(`Dimension ${i + 1}: pick a column.`);
      return;
    }
    if (d.temporal && field?.dataType !== "date") {
      errors.push(`Dimension ${i + 1}: bucketing is only available on date columns.`);
      return;
    }
    let bin: NumericBin | undefined;
    if (d.bin != null && d.bin.trim() !== "") {
      if (d.temporal) {
        errors.push(`Dimension ${i + 1}: use either a temporal bucket or a numeric bin, not both.`);
        return;
      }
      if (!isCalc && field?.dataType !== "number") {
        errors.push(`Dimension ${i + 1}: binning is only available on numeric columns.`);
        return;
      }
      const width = Number(d.bin);
      if (!Number.isFinite(width) || width <= 0) {
        errors.push(`Dimension ${i + 1}: bin size must be a positive number.`);
        return;
      }
      bin = { width };
    }
    dimensions.push({
      field: isCalc ? { kind: "expression", name: d.column } : col(d.column),
      temporal: d.temporal,
      bin,
      alias: d.alias?.trim() || undefined,
    });
  });

  // --- Metrics ---
  const aggregations: Aggregation[] = [];
  draft.metrics.forEach((m, i) => {
    const label = `Metric ${i + 1}`;
    const alias = m.alias?.trim() || undefined;

    // count / count_if take no value column.
    if (!aggNeedsColumn(m.fn)) {
      if (m.fn === "count_if") {
        const filter = compileMetricCond(m.cond, byName, label, errors);
        if (!filter) return;
        aggregations.push({ fn: "count_if", filter, alias });
        return;
      }
      aggregations.push({ fn: "count", alias });
      return;
    }

    if (!m.column) {
      errors.push(`${label}: ${IR_AGG_LABELS[m.fn]} needs a column.`);
      return;
    }
    const isCalc = calcNames.has(m.column);
    if (!isCalc && !byName.has(m.column)) {
      errors.push(`${label}: unknown column “${m.column}”.`);
      return;
    }
    const field: FieldRef = isCalc ? { kind: "expression", name: m.column } : col(m.column);

    // Percentile: parse the fraction (accept 0–1 or a 0–100 percentage).
    let p: number | undefined;
    if (aggTakesFraction(m.fn)) {
      const raw = Number((m.p ?? "").trim());
      if (!Number.isFinite(raw) || raw <= 0) {
        errors.push(`${label}: enter a percentile between 0 and 100 (e.g. 90).`);
        return;
      }
      p = raw > 1 ? raw / 100 : raw;
      if (p <= 0 || p >= 1) {
        errors.push(`${label}: percentile must be strictly between 0 and 100.`);
        return;
      }
    }

    // sum_if: needs a predicate too.
    let filter: Filter | undefined;
    if (m.fn === "sum_if") {
      const f = compileMetricCond(m.cond, byName, label, errors);
      if (!f) return;
      filter = f;
    }

    aggregations.push({
      fn: m.fn,
      field,
      distinct: m.fn === "count_distinct" || undefined,
      p,
      filter,
      alias,
    });
  });

  // A query needs *something* to select — dims/metrics, or (for a raw listing) a
  // calculated field, window column, or an explicit column selection.
  if (
    !options.allowBare &&
    dimensions.length === 0 &&
    aggregations.length === 0 &&
    (draft.calculated ?? []).length === 0 &&
    (draft.windows ?? []).length === 0 &&
    (draft.joins ?? []).length === 0 &&
    (draft.rawColumns ?? []).length === 0
  ) {
    errors.push("Add at least one metric, dimension, calculated field, or window.");
  }

  // --- Raw-mode column selection (data step) ---
  const aggregatedDraft = draft.dimensions.length > 0 || draft.metrics.length > 0;
  const rawFields: FieldRef[] = [];
  if (!aggregatedDraft) {
    (draft.rawColumns ?? []).forEach((name) => {
      if (!byName.has(name)) {
        errors.push(`Columns: unknown column “${name}”.`);
        return;
      }
      rawFields.push(col(name));
    });
  }

  // Duplicate output names confuse charts + windows — reject early.
  {
    const seen = new Set<string>();
    const dupCheck = (name: string, what: string) => {
      if (seen.has(name)) errors.push(`${what}: the output name “${name}” is used twice — set an alias.`);
      seen.add(name);
    };
    draft.dimensions.forEach((d, i) => {
      if (d.column) dupCheck(draftDimAlias(d), `Dimension ${i + 1}`);
    });
    draft.metrics.forEach((m, i) => dupCheck(draftMetricAlias(m, i), `Metric ${i + 1}`));
  }

  // --- Filters (tree; top-level nodes are ANDed) ---
  const filterClauses: Filter[] = [];
  let filterFailed = false;
  draft.filters.forEach((node, i) => {
    const compiled = compileFilterNode(node, byName, `Filter ${i + 1}`, errors);
    if (compiled) filterClauses.push(compiled);
    else filterFailed = true;
  });

  // --- Having (ANDed conditions over metric ordinals) ---
  const havingClauses: Filter[] = [];
  draft.having.forEach((h, i) => {
    const label = `Having ${i + 1}`;
    if (h.metricIndex === null || h.metricIndex < 0 || h.metricIndex >= aggregations.length) {
      errors.push(`${label}: pick a metric.`);
      return;
    }
    const field: FieldRef = { kind: "aggregation", index: h.metricIndex };
    if (h.op === "between") {
      const low = Number(h.low);
      const high = Number(h.high);
      if (h.low.trim() === "" || h.high.trim() === "" || !Number.isFinite(low) || !Number.isFinite(high)) {
        errors.push(`${label}: enter both numeric bounds.`);
        return;
      }
      havingClauses.push({ op: "between", field, low, high });
      return;
    }
    const value = Number(h.value);
    if (h.value.trim() === "" || !Number.isFinite(value)) {
      errors.push(`${label}: enter a number.`);
      return;
    }
    havingClauses.push({ op: h.op, field, value });
  });

  // --- Joins ---
  const joins: Join[] = [];
  (draft.joins ?? []).forEach((j, i) => {
    const label = `Join ${i + 1}`;
    const joinTable = j.table.trim();
    if (!joinTable) {
      errors.push(`${label}: name the table to join.`);
      return;
    }
    const alias = j.alias?.trim() || joinTable;
    const on: Join["on"] = [];
    if (j.conditions.length === 0) {
      errors.push(`${label}: add at least one join condition.`);
      return;
    }
    let ok = true;
    j.conditions.forEach((c, ci) => {
      if (!c.left || !byName.has(c.left)) {
        errors.push(`${label}, condition ${ci + 1}: pick the base column.`);
        ok = false;
        return;
      }
      if (!c.right.trim()) {
        errors.push(`${label}, condition ${ci + 1}: enter the joined column.`);
        ok = false;
        return;
      }
      // Base key stays UNQUALIFIED (the server picks the base table name, which
      // the client doesn't know); the joined key is qualified by the join alias.
      on.push({ left: col(c.left), right: col(c.right.trim(), alias) });
    });
    if (!ok) return;
    joins.push({ table: joinTable, alias, type: j.type, on });
  });

  // --- Window functions (computed over the query's output columns) ---
  const outputNames = new Set(outputNamesForDraft(draft, fields));
  const windows: WindowSpec[] = [];
  const winAliases = new Set<string>();
  (draft.windows ?? []).forEach((w, i) => {
    const label = `Window ${i + 1}`;
    let field: FieldRef | undefined;
    if (windowNeedsField(w.fn)) {
      if (!w.column) {
        errors.push(`${label}: pick a value column.`);
        return;
      }
      if (!outputNames.has(w.column)) {
        errors.push(`${label}: “${w.column}” isn’t one of the query’s output columns.`);
        return;
      }
      field = col(w.column);
    }
    const partitions = w.partitions.filter((p) => p !== "");
    for (const p of partitions) {
      if (!outputNames.has(p)) {
        errors.push(`${label}: partition “${p}” isn’t an output column.`);
        return;
      }
    }
    const orders = w.orders.filter((o) => o.column !== "");
    for (const o of orders) {
      if (!outputNames.has(o.column)) {
        errors.push(`${label}: order “${o.column}” isn’t an output column.`);
        return;
      }
    }
    const alias = w.alias.trim() || defaultWindowAlias(w);
    if (winAliases.has(alias) || outputNames.has(alias)) {
      errors.push(`${label}: the name “${alias}” collides — rename it.`);
      return;
    }
    winAliases.add(alias);
    let arg: number | undefined;
    if (windowTakesArg(w.fn) && w.arg.trim() !== "") {
      const n = Number(w.arg);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push(`${label}: enter a positive number.`);
        return;
      }
      arg = Math.floor(n);
    }
    windows.push({
      fn: w.fn,
      field,
      partitionBy: partitions.length > 0 ? partitions.map((p) => col(p)) : undefined,
      orderBy: orders.length > 0 ? orders.map((o) => ({ field: col(o.column), dir: o.dir })) : undefined,
      frame: windowFrameable(w.fn) && w.running ? "running" : undefined,
      arg,
      alias,
    });
  });

  // --- Sort (keys over output columns; metric aliases map to ordinals) ---
  const metricAliasToIndex = new Map<string, number>();
  draft.metrics.forEach((m, i) => metricAliasToIndex.set(draftMetricAlias(m, i), i));
  const sortable = new Set(sortableNamesForDraft(draft, fields));
  const order: QueryIR["order"] = [];
  draft.sort.forEach((s, i) => {
    if (!s.column) {
      errors.push(`Sort ${i + 1}: pick a column.`);
      return;
    }
    if (!sortable.has(s.column)) {
      errors.push(`Sort ${i + 1}: “${s.column}” isn’t one of the query’s output columns.`);
      return;
    }
    const metricIdx = metricAliasToIndex.get(s.column);
    const ref: FieldRef =
      metricIdx !== undefined
        ? { kind: "aggregation", index: metricIdx }
        : !aggregatedDraft && calcNames.has(s.column)
          ? { kind: "expression", name: s.column }
          : col(s.column);
    order.push({ ref, dir: s.dir });
  });

  if (errors.length > 0 || filterFailed) return { ir: null, errors };

  const ir: QueryIR = {
    version: 2,
    source: { table },
    joins: joins.length > 0 ? joins : undefined,
    fields: rawFields.length > 0 ? rawFields : undefined,
    dimensions: dimensions.length > 0 ? dimensions : undefined,
    aggregations: aggregations.length > 0 ? aggregations : undefined,
    calculated: calculated.length > 0 ? calculated : undefined,
    windows: windows.length > 0 ? windows : undefined,
    filters:
      filterClauses.length === 0
        ? undefined
        : filterClauses.length === 1
          ? filterClauses[0]
          : { op: "and", clauses: filterClauses },
    having:
      havingClauses.length === 0
        ? undefined
        : havingClauses.length === 1
          ? havingClauses[0]
          : { op: "and", clauses: havingClauses },
    order: order.length > 0 ? order : undefined,
    limit: draft.limit > 0 ? draft.limit : undefined,
    offset: draft.offset > 0 ? draft.offset : undefined,
  };

  // Multi-stage: compile the next stage over THIS stage's output columns, then
  // nest this stage as its subquery source. The base stage's limit/offset are
  // dropped so it doesn't truncate rows before the next stage re-aggregates.
  if (draft.nextStage) {
    const innerIr: QueryIR = { ...ir, limit: undefined, offset: undefined };
    const stageFields = stageOutputFields(draft, fields);
    const outer = compileIrDraft(draft.nextStage, stageFields, "__stage", options);
    if (!outer.ir) {
      return { ir: null, errors: outer.errors.map((e) => `Stage 2 — ${e}`) };
    }
    return {
      ir: { ...outer.ir, source: { query: innerIr, alias: "__stage" } },
      errors: [],
    };
  }

  return { ir, errors: [] };
}

/**
 * The synthetic `Field[]` describing a stage's OUTPUT columns — the schema the
 * NEXT stage builds against. Dimensions keep their (bucketed/binned) type;
 * aggregations + windows are numeric.
 */
export function stageOutputFields(draft: IrDraft, fields: Field[]): Field[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Field[] = [];
  const aggregated = draft.dimensions.length > 0 || draft.metrics.length > 0;

  if (aggregated) {
    draft.dimensions.forEach((d) => {
      if (!d.column) return;
      let dataType: DataType = byName.get(d.column)?.dataType ?? "string";
      if (d.temporal) {
        dataType = d.temporal === "day_of_week" || d.temporal === "month_of_year" ? "number" : "date";
      } else if (d.bin != null && d.bin.trim() !== "") {
        dataType = "number";
      }
      const name = draftDimAlias(d);
      out.push({ name, label: name, role: "dimension", dataType });
    });
    draft.metrics.forEach((m, i) => {
      const name = draftMetricAlias(m, i);
      out.push({ name, label: name, role: "metric", dataType: "number" });
    });
  } else {
    const selected = (draft.rawColumns ?? []).length > 0 ? draft.rawColumns! : fields.map((f) => f.name);
    selected.forEach((n) => {
      const src = byName.get(n);
      out.push({ name: n, label: src?.label ?? n, role: src?.role ?? "dimension", dataType: src?.dataType ?? "string" });
    });
    (draft.calculated ?? []).forEach((c) => {
      const name = c.name.trim();
      if (name) out.push({ name, label: name, role: "dimension", dataType: "string" });
    });
  }

  (draft.windows ?? []).forEach((w) => {
    const name = w.alias.trim() || defaultWindowAlias(w);
    if (name) out.push({ name, label: name, role: "metric", dataType: "number" });
  });

  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.name) ? false : (seen.add(f.name), true)));
}

/**
 * Rewrite bare column refs in a parsed formula: names matching an EARLIER
 * calculated field become `expression` refs; everything else must be a real
 * source column. Returns null (and pushes errors) on unknown names.
 */
function resolveExprRefs(
  expr: Expr,
  byName: Map<string, Field>,
  calcNames: ReadonlySet<string>,
  label: string,
  errors: string[],
): Expr | null {
  let failed = false;
  const mapRef = (ref: FieldRef): FieldRef => {
    if (ref.kind !== "column") return ref;
    if (calcNames.has(ref.name)) return { kind: "expression", name: ref.name };
    if (!byName.has(ref.name)) {
      errors.push(`${label}: unknown column “${ref.name}”.`);
      failed = true;
    }
    return ref;
  };
  const mapFilter = (f: Filter): Filter => {
    switch (f.op) {
      case "and":
      case "or":
        return { op: f.op, clauses: f.clauses.map(mapFilter) };
      case "not":
        return { op: "not", clause: mapFilter(f.clause) };
      default:
        return { ...f, field: mapRef(f.field) };
    }
  };
  const walk = (e: Expr): Expr => {
    switch (e.op) {
      case "field":
        return { op: "field", ref: mapRef(e.ref) };
      case "lit":
        return e;
      case "binary":
        return { ...e, left: walk(e.left), right: walk(e.right) };
      case "fn":
        return { ...e, args: e.args.map(walk) };
      case "case":
        return {
          op: "case",
          whens: e.whens.map((w) => ({ when: mapFilter(w.when), then: walk(w.then) })),
          else: e.else !== undefined ? walk(e.else) : undefined,
        };
    }
  };
  const out = walk(expr);
  return failed ? null : out;
}

/** Compile one filter-tree node (leaf or group) to an IR `Filter`. */
function compileFilterNode(
  node: DraftFilterNode,
  byName: Map<string, Field>,
  path: string,
  errors: string[],
): Filter | null {
  if (isDraftGroup(node)) {
    if (node.children.length === 0) {
      errors.push(`${path}: the group is empty — add a condition or remove it.`);
      return null;
    }
    const clauses: Filter[] = [];
    let failed = false;
    node.children.forEach((child, i) => {
      const compiled = compileFilterNode(child, byName, `${path}.${i + 1}`, errors);
      if (compiled) clauses.push(compiled);
      else failed = true;
    });
    if (failed) return null;
    const inner: Filter = clauses.length === 1 ? clauses[0] : { op: node.op, clauses };
    return node.not ? { op: "not", clause: inner } : inner;
  }

  const field = byName.get(node.column);
  if (!field) {
    errors.push(`${path}: pick a column.`);
    return null;
  }
  if (!irOperatorsFor(field.dataType).includes(node.op)) {
    errors.push(`${path}: “${IR_OPERATOR_LABELS[node.op]}” is not valid for ${field.label}.`);
    return null;
  }
  return compileFilterLeaf(node, field.dataType, path, errors);
}

/**
 * Compile a conditional aggregate's single predicate (count_if / sum_if) to an
 * IR `Filter`. Reuses the leaf compiler by shimming a `DraftIrFilter`, so value
 * coercion and operator validation match ordinary filters.
 */
function compileMetricCond(
  cond: DraftMetricCond | undefined,
  byName: Map<string, Field>,
  label: string,
  errors: string[],
): Filter | null {
  if (!cond || !cond.column) {
    errors.push(`${label}: choose a condition column.`);
    return null;
  }
  const field = byName.get(cond.column);
  if (!field) {
    errors.push(`${label}: unknown condition column “${cond.column}”.`);
    return null;
  }
  if (!irOperatorsFor(field.dataType).includes(cond.op)) {
    errors.push(`${label}: “${IR_OPERATOR_LABELS[cond.op]}” isn’t valid for ${field.label}.`);
    return null;
  }
  const leaf: DraftIrFilter = {
    id: "cond",
    kind: "leaf",
    column: cond.column,
    op: cond.op,
    value: cond.value,
    values: cond.value ? cond.value.split(",").map((s) => s.trim()).filter(Boolean) : [],
    low: "",
    high: "",
    relative: { direction: "last", count: "7", unit: "day" },
  };
  return compileFilterLeaf(leaf, field.dataType, label, errors);
}

function defaultWindowAlias(w: DraftWindow): string {
  if (w.fn === "row_number" || w.fn === "rank" || w.fn === "dense_rank") return w.fn;
  return w.column ? `${w.fn}_${w.column}` : w.fn;
}

/** The alias a dimension will output under (mirrors the compiler). */
export function draftDimAlias(d: DraftDimension): string {
  const explicit = d.alias?.trim();
  if (explicit) return explicit;
  if (d.temporal) return `${d.column}_${d.temporal}`;
  if (d.bin != null && d.bin.trim() !== "") return `${d.column}_bin`;
  return d.column;
}
/** The alias a metric will output under (mirrors the compiler). */
export function draftMetricAlias(m: DraftMetric, i: number): string {
  const explicit = m.alias?.trim();
  if (explicit) return explicit;
  if (m.fn === "count" && !m.column) return "count";
  if (m.fn === "count_if") return "count_if";
  return m.column ? `${m.fn}_${m.column}` : `${m.fn}_${i}`;
}

/**
 * The set of column names a window function may reference: the query's OUTPUT
 * columns — dimension + metric aliases when aggregated, else the raw source
 * columns plus any calculated-field names.
 */
export function outputNamesForDraft(draft: IrDraft, fields: Field[]): string[] {
  const aggregated = draft.dimensions.length > 0 || draft.metrics.length > 0;
  const names: string[] = [];
  if (aggregated) {
    draft.dimensions.forEach((d) => {
      if (d.column) names.push(draftDimAlias(d));
    });
    draft.metrics.forEach((m, i) => names.push(draftMetricAlias(m, i)));
  } else {
    const selected = draft.rawColumns ?? [];
    if (selected.length > 0) names.push(...selected);
    else fields.forEach((f) => names.push(f.name));
    (draft.calculated ?? []).forEach((c) => {
      if (c.name.trim()) names.push(c.name.trim());
    });
  }
  return [...new Set(names)];
}

/** Output names PLUS window aliases — everything a sort key may target. */
export function sortableNamesForDraft(draft: IrDraft, fields: Field[]): string[] {
  const names = outputNamesForDraft(draft, fields);
  (draft.windows ?? []).forEach((w) => {
    const alias = w.alias.trim() || defaultWindowAlias(w);
    if (alias) names.push(alias);
  });
  return [...new Set(names)];
}

function compileFilterLeaf(
  f: DraftIrFilter,
  dataType: DataType,
  path: string,
  errors: string[],
): Filter | null {
  const field = col(f.column);

  switch (f.op) {
    case "is_null":
      return { op: "is_null", field };
    case "not_null":
      return { op: "not_null", field };
    case "in":
    case "not_in": {
      const coerced = f.values
        .map((v) => coerce(v, dataType))
        .filter((v): v is Scalar => v !== null);
      if (coerced.length === 0) {
        errors.push(`${path}: add at least one value.`);
        return null;
      }
      return { op: f.op, field, values: coerced };
    }
    case "between": {
      const low = coerce(f.low, dataType);
      const high = coerce(f.high, dataType);
      if (low === null || high === null || typeof low === "boolean" || typeof high === "boolean") {
        errors.push(`${path}: enter both bounds.`);
        return null;
      }
      return { op: "between", field, low, high };
    }
    case "relative_date": {
      const count = Number(f.relative.count);
      if (f.relative.direction !== "current" && (!Number.isFinite(count) || count <= 0)) {
        errors.push(`${path}: enter how many ${f.relative.unit}s.`);
        return null;
      }
      const relative: RelativeDate = {
        direction: f.relative.direction,
        unit: f.relative.unit,
        count: f.relative.direction === "current" ? undefined : Math.floor(count),
      };
      return { op: "relative_date", field, relative };
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      const v = f.value.trim();
      if (v === "") {
        errors.push(`${path}: enter a value.`);
        return null;
      }
      return { op: f.op, field, value: v };
    }
    default: {
      // scalar comparison ops
      const coerced = coerce(f.value, dataType);
      if (coerced === null) {
        errors.push(`${path}: enter a valid ${dataType} value.`);
        return null;
      }
      return { op: f.op, field, value: coerced };
    }
  }
}

// ── Draft factories ──────────────────────────────────────────────────────────

let seq = 0;
function draftId(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}`;
}

export function newDraftMetric(fn: AggFn = "count", column = ""): DraftMetric {
  return { id: draftId("m"), fn, column };
}

export function newDraftDimension(column = ""): DraftDimension {
  return { id: draftId("d"), column };
}

export function newDraftFilter(column = "", op: IrFilterOp = "eq"): DraftIrFilter {
  return {
    id: draftId("f"),
    kind: "leaf",
    column,
    op,
    value: "",
    values: [],
    low: "",
    high: "",
    relative: { direction: "last", count: "7", unit: "day" },
  };
}

export function newDraftFilterGroup(op: "and" | "or" = "or"): DraftFilterGroup {
  return { id: draftId("g"), kind: "group", op, not: false, children: [newDraftFilter()] };
}

export function newDraftHaving(): DraftHaving {
  return { id: draftId("h"), metricIndex: 0, op: "gt", value: "", low: "", high: "" };
}

export function newDraftSort(column = "", dir: "asc" | "desc" = "desc"): DraftSort {
  return { id: draftId("s"), column, dir };
}

export function newDraftJoinCondition(): DraftJoinCondition {
  return { id: draftId("jc"), left: "", right: "" };
}

export function newDraftJoin(): DraftJoin {
  return { id: draftId("j"), table: "", type: "inner", conditions: [newDraftJoinCondition()] };
}

export function newDraftCalc(): DraftCalc {
  return { id: draftId("c"), name: "", text: "" };
}

export function newDraftWindowOrder(
  column = "",
  dir: "asc" | "desc" = "asc",
): DraftWindow["orders"][number] {
  return { id: draftId("wo"), column, dir };
}

export function newDraftWindow(fn: WindowFn = "row_number"): DraftWindow {
  return {
    id: draftId("w"),
    fn,
    column: "",
    partitions: [],
    orders: [],
    running: fn === "sum" || fn === "avg",
    arg: "",
    alias: "",
  };
}

/** A sensible empty advanced draft: first dimension + a COUNT metric. */
export function emptyIrDraft(fields: Field[]): IrDraft {
  const firstDim = fields.find((f) => f.role === "dimension");
  return {
    rawColumns: [],
    dimensions: firstDim ? [{ id: draftId("d"), column: firstDim.name }] : [],
    metrics: [{ id: draftId("m"), fn: "count", column: "" }],
    filters: [],
    having: [],
    joins: [],
    calculated: [],
    windows: [],
    sort: [{ id: draftId("s"), column: "count", dir: "desc" }],
    limit: 50,
    offset: 0,
  };
}

/** Column allowlist for the compiler, derived from the field set. */
export function allowlistFromFields(fields: Field[]): Set<string> {
  return new Set(fields.map((f) => f.name));
}

// ── Reverse: QueryIR → draft (for opening a saved/history IR query) ───────────

/** Name of a column/expression FieldRef, or "" for aggregation ordinals. */
function refName(ref: FieldRef | undefined): string {
  if (!ref) return "";
  return ref.kind === "aggregation" ? "" : ref.name;
}

/**
 * Inverse of {@link compileMetricCond}: a conditional aggregate's IR predicate →
 * the single-condition draft shape. Only simple scalar/null leaves round-trip;
 * anything richer is reported (the metric opens with an empty condition to reset).
 */
function filterToMetricCond(
  f: Filter | undefined,
  warn: (msg: string) => void,
): DraftMetricCond | undefined {
  if (!f) return undefined;
  switch (f.op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains":
    case "starts_with":
    case "ends_with":
      return { column: refName(f.field), op: f.op, value: String(f.value) };
    case "is_null":
    case "not_null":
      return { column: refName(f.field), op: f.op, value: "" };
    default:
      warn("A conditional aggregate used a predicate the builder can’t show — re-set its condition.");
      return undefined;
  }
}

/** Inverse of {@link compileFilterLeaf}: a compiled leaf → a loose draft leaf. */
function leafToDraft(f: Filter, warn: (msg: string) => void): DraftIrFilter | null {
  switch (f.op) {
    case "and":
    case "or":
    case "not":
      return null; // handled by filterToNode
    case "is_null":
    case "not_null":
      return newDraftFilter(refName(f.field), f.op);
    case "in":
    case "not_in":
      return { ...newDraftFilter(refName(f.field), f.op), values: f.values.map((v) => String(v)) };
    case "between":
      return { ...newDraftFilter(refName(f.field), f.op), low: String(f.low), high: String(f.high) };
    case "relative_date":
      return {
        ...newDraftFilter(refName(f.field), f.op),
        relative: {
          direction: f.relative.direction,
          count: String(f.relative.count ?? ""),
          unit: f.relative.unit,
        },
      };
    default: {
      if (f.field.kind === "aggregation") {
        warn("A filter over an aggregation was moved out of the WHERE tree.");
        return null;
      }
      return { ...newDraftFilter(refName(f.field), f.op), value: String(f.value) };
    }
  }
}

/** A filter tree node → a draft node (group or leaf). */
function filterToNode(f: Filter, warn: (msg: string) => void): DraftFilterNode | null {
  if (f.op === "and" || f.op === "or") {
    const children = f.clauses
      .map((c) => filterToNode(c, warn))
      .filter((c): c is DraftFilterNode => c !== null);
    return { id: newDraftFilterGroup().id, kind: "group", op: f.op, not: false, children };
  }
  if (f.op === "not") {
    const inner = f.clause;
    if (inner.op === "and" || inner.op === "or") {
      const group = filterToNode(inner, warn) as DraftFilterGroup | null;
      if (group) group.not = true;
      return group;
    }
    const leaf = leafToDraft(inner, warn);
    if (!leaf) return null;
    return { id: newDraftFilterGroup().id, kind: "group", op: "and", not: true, children: [leaf] };
  }
  return leafToDraft(f, warn);
}

/** ir.filters → the draft's top-level node list (a top-level AND unwraps). */
function filtersToNodes(f: Filter | undefined, warn: (msg: string) => void): DraftFilterNode[] {
  if (!f) return [];
  if (f.op === "and") {
    return f.clauses.map((c) => filterToNode(c, warn)).filter((c): c is DraftFilterNode => c !== null);
  }
  const node = filterToNode(f, warn);
  return node ? [node] : [];
}

/** ir.having → flat DraftHaving list (flat AND of metric-ordinal comparisons). */
function havingToDraft(f: Filter | undefined, warn: (msg: string) => void): DraftHaving[] {
  if (!f) return [];
  const leaves = f.op === "and" ? f.clauses : [f];
  const out: DraftHaving[] = [];
  for (const leaf of leaves) {
    if (
      (leaf.op === "eq" || leaf.op === "neq" || leaf.op === "gt" || leaf.op === "gte" ||
        leaf.op === "lt" || leaf.op === "lte") &&
      leaf.field.kind === "aggregation"
    ) {
      out.push({
        ...newDraftHaving(),
        metricIndex: leaf.field.index,
        op: leaf.op,
        value: String(leaf.value),
      });
    } else if (leaf.op === "between" && leaf.field.kind === "aggregation") {
      out.push({
        ...newDraftHaving(),
        metricIndex: leaf.field.index,
        op: "between",
        low: String(leaf.low),
        high: String(leaf.high),
      });
    } else {
      warn("Part of the HAVING clause is more complex than the builder can show and was dropped.");
    }
  }
  return out;
}

/**
 * Hydrate a loose {@link IrDraft} from a strict {@link QueryIR} — the inverse of
 * {@link compileIrDraft}. Used to re-open a saved/history IR query in the
 * advanced builder. Lossless for anything the builder can express; anything it
 * can't is reported through `warnings` instead of silently vanishing.
 */
export function irToDraft(ir: QueryIR, warnings?: string[]): IrDraft {
  const warn = (msg: string) => {
    if (warnings && !warnings.includes(msg)) warnings.push(msg);
  };

  // Multi-stage: unwrap a nested-query source into (base draft) + nextStage.
  // The inner query becomes the base; this level (its source swapped for a table
  // placeholder) becomes the follow-up stage over the base's output columns.
  if (isQuerySource(ir.source)) {
    const base = irToDraft(ir.source.query, warnings);
    const outer = irToDraft({ ...ir, source: { table: "__stage" } }, warnings);
    return { ...base, nextStage: outer };
  }

  const rawColumns = (ir.fields ?? [])
    .map(refName)
    .filter((n) => n !== "");

  const dimensions: DraftDimension[] = (ir.dimensions ?? []).map((d) => ({
    id: draftId("d"),
    column: refName(d.field),
    temporal: d.temporal,
    bin: d.bin ? String(d.bin.width) : undefined,
    alias: d.alias,
  }));

  const metrics: DraftMetric[] = (ir.aggregations ?? []).map((a) => ({
    id: draftId("m"),
    fn: a.fn,
    column: refName(a.field),
    alias: a.alias,
    p: a.p != null ? String(a.p) : undefined,
    cond: filterToMetricCond(a.filter, warn),
  }));

  const filters = filtersToNodes(ir.filters, warn);
  const having = havingToDraft(ir.having, warn);

  const joins: DraftJoin[] = (ir.joins ?? []).map((j) => ({
    id: draftId("j"),
    table: j.table,
    alias: j.alias !== j.table ? j.alias : undefined,
    type: j.type,
    conditions: j.on.map((c) => ({
      id: draftId("jc"),
      left: refName(c.left),
      right: refName(c.right),
    })),
  }));

  const calculated: DraftCalc[] = [];
  (ir.calculated ?? []).forEach((cf) => {
    const text = formatExprText(cf.expr);
    if (text === null) {
      warn(`The calculated field “${cf.name}” uses features the formula editor can't show and was dropped.`);
      return;
    }
    calculated.push({ id: draftId("c"), name: cf.name, text });
  });

  const windows: DraftWindow[] = (ir.windows ?? []).map((w) => ({
    id: draftId("w"),
    fn: w.fn,
    column: refName(w.field),
    partitions: (w.partitionBy ?? []).map(refName).filter((n) => n !== ""),
    orders: (w.orderBy ?? []).map((o) => ({
      id: draftId("wo"),
      column: refName(o.field),
      dir: o.dir,
    })),
    running: w.frame === "running",
    arg: w.arg != null ? String(w.arg) : "",
    alias: w.alias,
  }));

  // Sort keys: aggregation ordinals map back to the metric's output alias;
  // column/expression refs keep their name.
  const sort: DraftSort[] = [];
  (ir.order ?? []).forEach((o) => {
    if (o.ref.kind === "aggregation") {
      const m = metrics[o.ref.index];
      if (!m) {
        warn("A sort key referenced a metric that no longer exists and was dropped.");
        return;
      }
      sort.push({ id: draftId("s"), column: draftMetricAlias(m, o.ref.index), dir: o.dir });
      return;
    }
    sort.push({ id: draftId("s"), column: o.ref.name, dir: o.dir });
  });

  return {
    rawColumns,
    dimensions,
    metrics,
    filters,
    having,
    joins,
    calculated,
    windows,
    sort,
    limit: ir.limit ?? 50,
    offset: ir.offset ?? 0,
  };
}

// ── Per-step preview (notebook UX) ───────────────────────────────────────────

/**
 * The notebook's fixed step order. A preview at step N runs the draft with
 * every LATER step emptied — "the first rows of the data as of this step".
 */
export type BuilderStep =
  | "data"
  | "joins"
  | "calculated"
  | "filters"
  | "summarize"
  | "having"
  | "windows"
  | "sort";

const STEP_ORDER: BuilderStep[] = [
  "data",
  "joins",
  "calculated",
  "filters",
  "summarize",
  "having",
  "windows",
  "sort",
];

/**
 * Truncate a draft to everything up to AND including `step`, capped for a
 * 10-row preview. Compile the result with `{ allowBare: true }` — the data
 * step is a bare `SELECT *`.
 */
export function draftUpToStep(draft: IrDraft, step: BuilderStep): IrDraft {
  const idx = STEP_ORDER.indexOf(step);
  const keep = (s: BuilderStep) => STEP_ORDER.indexOf(s) <= idx;
  return {
    rawColumns: draft.rawColumns,
    joins: keep("joins") ? draft.joins : [],
    calculated: keep("calculated") ? draft.calculated : [],
    filters: keep("filters") ? draft.filters : [],
    dimensions: keep("summarize") ? draft.dimensions : [],
    metrics: keep("summarize") ? draft.metrics : [],
    having: keep("having") ? draft.having : [],
    windows: keep("windows") ? draft.windows : [],
    sort: keep("sort") ? draft.sort : [],
    limit: 10,
    offset: 0,
  };
}
