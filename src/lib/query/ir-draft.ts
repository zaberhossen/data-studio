/**
 * Advanced (IR) builder draft — the loose, string-typed, UI-facing model the
 * advanced query builder binds to, plus `compileIrDraft` which validates it into
 * a strict `QueryIR` (the inverse-shaped sibling of `compileQuery` for the legacy
 * builder). Pure — safe to run on every keystroke for live preview.
 *
 * Unlike the legacy builder (single dimension + single aggregation), this draft
 * supports MULTIPLE metrics, MULTIPLE dimensions with temporal bucketing, and a
 * richer filter operator set (between / null checks / starts-ends / relative
 * dates). It still emits a flat AND of filters; nested AND/OR groups arrive later.
 */

import {
  col,
  type Aggregation,
  type AggFn,
  type CalculatedField,
  type Dimension,
  type Expr,
  type FieldRef,
  type Filter,
  type Join,
  type JoinType,
  type QueryIR,
  type RelativeDate,
  type TemporalUnit,
  type WindowFn,
  type WindowSpec,
} from "@/lib/query/ir";
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
];

/** Temporal buckets offered for a date dimension. */
export const TEMPORAL_UNITS: TemporalUnit[] = [
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

// ── Calculated fields + window functions (M10) ───────────────────────────────

/** Arithmetic operators offered by the calculated-field editor. */
export type CalcOperator = "+" | "-" | "*" | "/" | "%";
export const CALC_OPERATORS: CalcOperator[] = ["+", "-", "*", "/", "%"];

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

export interface DraftMetric {
  id: string;
  fn: AggFn;
  /** Column to aggregate; ignored for `count`. */
  column: string;
}

export interface DraftDimension {
  id: string;
  column: string;
  /** Temporal bucket (date columns only). */
  temporal?: TemporalUnit;
}

export interface DraftRelative {
  direction: RelativeDate["direction"];
  count: string;
  unit: RelativeDate["unit"];
}

export interface DraftIrFilter {
  id: string;
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

/** One operand of a calculated field: a source column or a numeric literal. */
export interface CalcOperand {
  kind: "column" | "number";
  value: string;
}

/** A calculated field: `name = a <op> b` (binary arithmetic over two operands). */
export interface DraftCalc {
  id: string;
  name: string;
  a: CalcOperand;
  operator: CalcOperator;
  b: CalcOperand;
}

/** A window-function column (running total, rank, lag/lead, ntile…). */
export interface DraftWindow {
  id: string;
  fn: WindowFn;
  /** Value column (for sum/avg/lag/lead) — an OUTPUT column name. */
  column: string;
  /** Single partition column (optional) — an OUTPUT column name. */
  partition: string;
  /** Single order column (optional) — an OUTPUT column name. */
  orderColumn: string;
  orderDir: "asc" | "desc";
  /** Cumulative frame for sum/avg (running total). */
  running: boolean;
  /** Bucket count (ntile) / row offset (lag/lead). */
  arg: string;
  /** Output alias (auto-derived when blank). */
  alias: string;
}

/** A single-key join to another table in the same (live) source. */
export interface DraftJoin {
  id: string;
  /** Physical table to join (validated server-side against the allowlist). */
  table: string;
  type: JoinType;
  /** Base-side key column (a column of the source table). */
  leftColumn: string;
  /** Joined-table key column. */
  rightColumn: string;
}

export interface IrDraft {
  dimensions: DraftDimension[];
  metrics: DraftMetric[];
  filters: DraftIrFilter[];
  /** Joins to other tables (live DB / pushdown only). */
  joins?: DraftJoin[];
  /** Calculated fields (arithmetic over columns/literals). */
  calculated?: DraftCalc[];
  /** Window-function columns (computed over the query's output). */
  windows?: DraftWindow[];
  /** Index into `metrics` to sort by, or null for no explicit sort. */
  sortMetricIndex: number | null;
  sortDir: "asc" | "desc";
  limit: number;
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

export function compileIrDraft(
  draft: IrDraft,
  fields: Field[],
  table = "dataset",
): IrCompileResult {
  const errors: string[] = [];
  const byName = new Map(fields.map((f) => [f.name, f]));

  // --- Dimensions ---
  const dimensions: Dimension[] = [];
  draft.dimensions.forEach((d, i) => {
    const field = byName.get(d.column);
    if (!field) {
      errors.push(`Dimension ${i + 1}: pick a column.`);
      return;
    }
    if (d.temporal && field.dataType !== "date") {
      errors.push(`Dimension ${i + 1}: bucketing is only available on date columns.`);
      return;
    }
    dimensions.push({ field: col(d.column), temporal: d.temporal });
  });

  // --- Metrics ---
  const aggregations: Aggregation[] = [];
  draft.metrics.forEach((m, i) => {
    if (m.fn === "count") {
      aggregations.push({ fn: "count" });
      return;
    }
    if (!m.column) {
      errors.push(`Metric ${i + 1}: ${IR_AGG_LABELS[m.fn]} needs a column.`);
      return;
    }
    const field = byName.get(m.column);
    if (!field) {
      errors.push(`Metric ${i + 1}: unknown column “${m.column}”.`);
      return;
    }
    aggregations.push({
      fn: m.fn,
      field: col(m.column),
      distinct: m.fn === "count_distinct" || undefined,
    });
  });

  // A query needs *something* to select — dims/metrics, or (for a raw listing) a
  // calculated field or a window column.
  if (
    dimensions.length === 0 &&
    aggregations.length === 0 &&
    (draft.calculated ?? []).length === 0 &&
    (draft.windows ?? []).length === 0 &&
    (draft.joins ?? []).length === 0
  ) {
    errors.push("Add at least one metric, dimension, calculated field, or window.");
  }

  // --- Filters (flat AND) ---
  const filterLeaves: Filter[] = [];
  draft.filters.forEach((f, i) => {
    const field = byName.get(f.column);
    if (!field) {
      errors.push(`Filter ${i + 1}: pick a column.`);
      return;
    }
    if (!irOperatorsFor(field.dataType).includes(f.op)) {
      errors.push(`Filter ${i + 1}: “${IR_OPERATOR_LABELS[f.op]}” is not valid for ${field.label}.`);
      return;
    }
    const leaf = compileFilterLeaf(f, field.dataType, i, errors);
    if (leaf) filterLeaves.push(leaf);
  });

  // --- Order ---
  let order: QueryIR["order"];
  if (draft.sortMetricIndex !== null) {
    if (draft.sortMetricIndex < 0 || draft.sortMetricIndex >= aggregations.length) {
      errors.push("Sort refers to a metric that no longer exists.");
    } else {
      order = [{ ref: { kind: "aggregation", index: draft.sortMetricIndex }, dir: draft.sortDir }];
    }
  }

  // --- Joins (single equi-key to another table) ---
  const joins: Join[] = [];
  (draft.joins ?? []).forEach((j, i) => {
    const label = `Join ${i + 1}`;
    const table = j.table.trim();
    if (!table) {
      errors.push(`${label}: name the table to join.`);
      return;
    }
    if (!j.leftColumn || !byName.has(j.leftColumn)) {
      errors.push(`${label}: pick the base column.`);
      return;
    }
    if (!j.rightColumn.trim()) {
      errors.push(`${label}: enter the joined column.`);
      return;
    }
    // Base key stays UNQUALIFIED (the server picks the base table name, which the
    // client doesn't know); the joined key is qualified by the join table.
    joins.push({
      table,
      alias: table,
      type: j.type,
      on: [{ left: col(j.leftColumn), right: col(j.rightColumn.trim(), table) }],
    });
  });

  // --- Calculated fields (binary arithmetic over columns/literals) ---
  const calculated: CalculatedField[] = [];
  const calcNames = new Set<string>();
  (draft.calculated ?? []).forEach((c, i) => {
    const name = c.name.trim();
    if (!name) {
      errors.push(`Calculated field ${i + 1}: give it a name.`);
      return;
    }
    if (calcNames.has(name) || byName.has(name)) {
      errors.push(`Calculated field ${i + 1}: the name “${name}” is already taken.`);
      return;
    }
    const left = operandExpr(c.a, byName, i, errors);
    const right = operandExpr(c.b, byName, i, errors);
    if (!left || !right) return;
    calcNames.add(name);
    calculated.push({ name, expr: { op: "binary", operator: c.operator, left, right } });
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
    if (w.partition && !outputNames.has(w.partition)) {
      errors.push(`${label}: partition “${w.partition}” isn’t an output column.`);
      return;
    }
    if (w.orderColumn && !outputNames.has(w.orderColumn)) {
      errors.push(`${label}: order “${w.orderColumn}” isn’t an output column.`);
      return;
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
      partitionBy: w.partition ? [col(w.partition)] : undefined,
      orderBy: w.orderColumn ? [{ field: col(w.orderColumn), dir: w.orderDir }] : undefined,
      frame: windowFrameable(w.fn) && w.running ? "running" : undefined,
      arg,
      alias,
    });
  });

  if (errors.length > 0) return { ir: null, errors };

  const ir: QueryIR = {
    version: 2,
    source: { table },
    joins: joins.length > 0 ? joins : undefined,
    dimensions: dimensions.length > 0 ? dimensions : undefined,
    aggregations: aggregations.length > 0 ? aggregations : undefined,
    calculated: calculated.length > 0 ? calculated : undefined,
    windows: windows.length > 0 ? windows : undefined,
    filters:
      filterLeaves.length === 0
        ? undefined
        : filterLeaves.length === 1
          ? filterLeaves[0]
          : { op: "and", clauses: filterLeaves },
    order,
    limit: draft.limit > 0 ? draft.limit : undefined,
  };

  return { ir, errors: [] };
}

/** An operand → an `Expr` (numeric literal or a source-column field). */
function operandExpr(
  o: CalcOperand,
  byName: Map<string, Field>,
  i: number,
  errors: string[],
): Expr | null {
  if (o.kind === "number") {
    const n = Number(o.value);
    if (o.value.trim() === "" || !Number.isFinite(n)) {
      errors.push(`Calculated field ${i + 1}: enter a valid number.`);
      return null;
    }
    return { op: "lit", value: n };
  }
  if (!o.value || !byName.has(o.value)) {
    errors.push(`Calculated field ${i + 1}: pick a column.`);
    return null;
  }
  return { op: "field", ref: col(o.value) };
}

function defaultWindowAlias(w: DraftWindow): string {
  if (w.fn === "row_number" || w.fn === "rank" || w.fn === "dense_rank") return w.fn;
  return w.column ? `${w.fn}_${w.column}` : w.fn;
}

/** The alias a dimension will output under (mirrors the compiler). */
export function draftDimAlias(d: DraftDimension): string {
  return d.temporal ? `${d.column}_${d.temporal}` : d.column;
}
/** The alias a metric will output under (mirrors the compiler). */
export function draftMetricAlias(m: DraftMetric, i: number): string {
  if (m.fn === "count" && !m.column) return "count";
  return m.column ? `${m.fn}_${m.column}` : `${m.fn}_${i}`;
}

/**
 * The set of column names a window function (or an outer ORDER BY) may reference:
 * the query's OUTPUT columns — dimension + metric aliases when aggregated, else
 * the raw source columns, plus any calculated-field names (raw listings only).
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
    fields.forEach((f) => names.push(f.name));
    (draft.calculated ?? []).forEach((c) => {
      if (c.name.trim()) names.push(c.name.trim());
    });
  }
  return [...new Set(names)];
}

function compileFilterLeaf(
  f: DraftIrFilter,
  dataType: DataType,
  i: number,
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
        errors.push(`Filter ${i + 1}: add at least one value.`);
        return null;
      }
      return { op: f.op, field, values: coerced };
    }
    case "between": {
      const low = coerce(f.low, dataType);
      const high = coerce(f.high, dataType);
      if (low === null || high === null || typeof low === "boolean" || typeof high === "boolean") {
        errors.push(`Filter ${i + 1}: enter both bounds.`);
        return null;
      }
      return { op: "between", field, low, high };
    }
    case "relative_date": {
      const count = Number(f.relative.count);
      if (f.relative.direction !== "current" && (!Number.isFinite(count) || count <= 0)) {
        errors.push(`Filter ${i + 1}: enter how many ${f.relative.unit}s.`);
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
        errors.push(`Filter ${i + 1}: enter a value.`);
        return null;
      }
      return { op: f.op, field, value: v };
    }
    default: {
      // scalar comparison ops
      const coerced = coerce(f.value, dataType);
      if (coerced === null) {
        errors.push(`Filter ${i + 1}: enter a valid ${dataType} value.`);
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
    column,
    op,
    value: "",
    values: [],
    low: "",
    high: "",
    relative: { direction: "last", count: "7", unit: "day" },
  };
}

export function newDraftJoin(): DraftJoin {
  return { id: draftId("j"), table: "", type: "inner", leftColumn: "", rightColumn: "" };
}

export function newDraftCalc(): DraftCalc {
  return {
    id: draftId("c"),
    name: "",
    a: { kind: "column", value: "" },
    operator: "-",
    b: { kind: "column", value: "" },
  };
}

export function newDraftWindow(fn: WindowFn = "row_number"): DraftWindow {
  return {
    id: draftId("w"),
    fn,
    column: "",
    partition: "",
    orderColumn: "",
    orderDir: "asc",
    running: fn === "sum" || fn === "avg",
    arg: "",
    alias: "",
  };
}

/** A sensible empty advanced draft: first dimension + a COUNT metric. */
export function emptyIrDraft(fields: Field[]): IrDraft {
  const firstDim = fields.find((f) => f.role === "dimension");
  return {
    dimensions: firstDim ? [{ id: draftId("d"), column: firstDim.name }] : [],
    metrics: [{ id: draftId("m"), fn: "count", column: "" }],
    filters: [],
    joins: [],
    calculated: [],
    windows: [],
    sortMetricIndex: 0,
    sortDir: "desc",
    limit: 50,
  };
}

/** Column allowlist for the compiler, derived from the field set. */
export function allowlistFromFields(fields: Field[]): Set<string> {
  return new Set(fields.map((f) => f.name));
}

// ── Reverse: QueryIR → draft (for opening a saved/history IR query) ───────────

/** Name of a column FieldRef, or "" for anything else (expression/aggregation). */
function columnName(ref: FieldRef | undefined): string {
  return ref && ref.kind === "column" ? ref.name : "";
}

/**
 * Flatten a filter tree into the draft's FLAT list. The draft only models a flat
 * AND of leaves, so a top-level AND is unwrapped and its leaves kept; a bare leaf
 * becomes a one-item list. Anything the draft can't represent (OR / NOT / nested
 * groups) is dropped — a lossy but safe best-effort, since the draft itself only
 * ever emits flat ANDs and `queryV1ToIR` is flat, so real round-trips are exact.
 */
function flattenFilters(f: Filter | undefined): Filter[] {
  if (!f) return [];
  if (f.op === "and") return f.clauses.flatMap(flattenFilters);
  if (f.op === "or" || f.op === "not") return [];
  return [f];
}

/** Inverse of {@link compileFilterLeaf}: a compiled leaf → a loose draft filter.
 *  Group nodes (and/or/not) aren't representable in the flat draft → null. */
function leafToDraft(f: Filter): DraftIrFilter | null {
  switch (f.op) {
    case "and":
    case "or":
    case "not":
      return null;
    case "is_null":
    case "not_null":
      return newDraftFilter(columnName(f.field), f.op);
    case "in":
    case "not_in":
      return { ...newDraftFilter(columnName(f.field), f.op), values: f.values.map((v) => String(v)) };
    case "between":
      return { ...newDraftFilter(columnName(f.field), f.op), low: String(f.low), high: String(f.high) };
    case "relative_date":
      return {
        ...newDraftFilter(columnName(f.field), f.op),
        relative: {
          direction: f.relative.direction,
          count: String(f.relative.count ?? ""),
          unit: f.relative.unit,
        },
      };
    default:
      return { ...newDraftFilter(columnName(f.field), f.op), value: String(f.value) };
  }
}

/**
 * Hydrate a loose {@link IrDraft} from a strict {@link QueryIR} — the inverse of
 * {@link compileIrDraft}. Used to re-open a saved/history IR query (or a legacy
 * builder query already migrated to `ir` via `queryV1ToIR`) in the advanced
 * builder. Round-trips exactly for any IR the draft can produce.
 */
export function irToDraft(ir: QueryIR): IrDraft {
  const dimensions: DraftDimension[] = (ir.dimensions ?? []).map((d) => ({
    id: draftId("d"),
    column: columnName(d.field),
    temporal: d.temporal,
  }));

  const metrics: DraftMetric[] = (ir.aggregations ?? []).map((a) => ({
    id: draftId("m"),
    fn: a.fn,
    column: columnName(a.field),
  }));

  const filters = flattenFilters(ir.filters)
    .map(leafToDraft)
    .filter((f): f is DraftIrFilter => f !== null);

  const joins: DraftJoin[] = (ir.joins ?? []).map((j) => ({
    id: draftId("j"),
    table: j.table,
    type: j.type,
    leftColumn: j.on[0] ? columnName(j.on[0].left) : "",
    rightColumn: j.on[0] ? columnName(j.on[0].right) : "",
  }));

  const calculated = (ir.calculated ?? [])
    .map(calcToDraft)
    .filter((c): c is DraftCalc => c !== null);

  const windows: DraftWindow[] = (ir.windows ?? []).map((w) => ({
    id: draftId("w"),
    fn: w.fn,
    column: columnName(w.field),
    partition: w.partitionBy && w.partitionBy[0] ? columnName(w.partitionBy[0]) : "",
    orderColumn: w.orderBy && w.orderBy[0] ? columnName(w.orderBy[0].field) : "",
    orderDir: w.orderBy && w.orderBy[0] ? w.orderBy[0].dir : "asc",
    running: w.frame === "running",
    arg: w.arg != null ? String(w.arg) : "",
    alias: w.alias,
  }));

  let sortMetricIndex: number | null = null;
  let sortDir: "asc" | "desc" = "desc";
  const firstOrder = ir.order?.[0];
  if (firstOrder && firstOrder.ref.kind === "aggregation") {
    sortMetricIndex = firstOrder.ref.index;
    sortDir = firstOrder.dir;
  }

  return {
    dimensions,
    metrics,
    filters,
    joins,
    calculated,
    windows,
    sortMetricIndex,
    sortDir,
    limit: ir.limit ?? 50,
  };
}

/** An `Expr` operand → a loose draft operand, or null if not representable. */
function operandFromExpr(e: Expr): CalcOperand | null {
  if (e.op === "field" && e.ref.kind === "column") return { kind: "column", value: e.ref.name };
  if (e.op === "lit" && typeof e.value === "number") return { kind: "number", value: String(e.value) };
  return null;
}

/** Inverse of the calc compile: a binary CalculatedField → a draft row (or null
 *  when the expression is richer than the flat two-operand editor can model). */
function calcToDraft(cf: CalculatedField): DraftCalc | null {
  if (cf.expr.op !== "binary") return null;
  const a = operandFromExpr(cf.expr.left);
  const b = operandFromExpr(cf.expr.right);
  if (!a || !b) return null;
  return { id: draftId("c"), name: cf.name, a, operator: cf.expr.operator, b };
}
