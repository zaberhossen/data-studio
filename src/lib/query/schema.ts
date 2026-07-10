/**
 * Field schema + query-compilation helpers.
 *
 * This is the UI-side knowledge layer that sits ON TOP of the engine contract
 * (`@/lib/types/analytics`). It does three jobs:
 *
 *   1. Describe each column as a `Field` (role = dimension|metric, dataType).
 *   2. Constrain the UI to ONLY the operators/aggregations the Rust engine
 *      supports, narrowed further by column data-type (you can't `gt` a string).
 *   3. Compile the builder's loose, string-typed `QueryDraft` into the strict
 *      `Query` object that crosses the worker boundary — coercing values to the
 *      right `Cell` type and reporting validation errors.
 *
 * Nothing here touches raw rows; it only manipulates the small declarative
 * query, so it is safe to run in React render/state.
 */

import type {
  AggFn,
  Cell,
  Filter,
  Operator,
  Query,
  SortDir,
} from "@/lib/types/analytics";
import type { SourceColumn } from "@/lib/types/datasource";

// ---------------------------------------------------------------------------
// Field model
// ---------------------------------------------------------------------------

export type FieldRole = "dimension" | "metric";
export type DataType = "string" | "number" | "boolean" | "date";

export interface Field {
  /** Column name exactly as it appears in a Row (the engine key). */
  name: string;
  /** Human label for the UI. */
  label: string;
  role: FieldRole;
  dataType: DataType;
}

export const isDimension = (f: Field) => f.role === "dimension";
export const isMetric = (f: Field) => f.role === "metric";

/** A per-column override layered on top of the heuristic-derived `Field`. */
export interface FieldOverride {
  role?: FieldRole;
  label?: string;
}

/**
 * Layer user overrides on top of heuristic `Field[]` — role/label only.
 * `dataType` stays intrinsic to the column and is never overridable.
 */
export function applyFieldOverrides(
  fields: Field[],
  overrides: Record<string, FieldOverride>,
): Field[] {
  if (Object.keys(overrides).length === 0) return fields;
  return fields.map((f) => {
    const o = overrides[f.name];
    if (!o) return f;
    return {
      ...f,
      role: o.role ?? f.role,
      label: o.label?.trim() ? o.label : f.label,
    };
  });
}

/**
 * Derive UI `Field[]` from an introspected source schema. This is the single
 * adapter from a connector's `SourceColumn[]` into the field browser model, so
 * any source (Postgres, file, …) feeds the existing builder unchanged.
 *
 * Heuristic: numeric columns are metrics (you aggregate them); everything else
 * is a dimension (you group by it). `date` is now a first-class dimension type so
 * the advanced (IR) builder can offer temporal bucketing + relative-date filters;
 * the legacy builder treats it like a categorical string (see `operatorsFor`).
 */
export function fieldsFromColumns(columns: SourceColumn[]): Field[] {
  const labelize = (name: string) =>
    name
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();

  return columns.map((col): Field => {
    switch (col.type) {
      case "number":
        return { name: col.name, label: labelize(col.name), role: "metric", dataType: "number" };
      case "bool":
        return { name: col.name, label: labelize(col.name), role: "dimension", dataType: "boolean" };
      case "date":
        return { name: col.name, label: labelize(col.name), role: "dimension", dataType: "date" };
      case "string":
      default:
        return { name: col.name, label: labelize(col.name), role: "dimension", dataType: "string" };
    }
  });
}

// ---------------------------------------------------------------------------
// Operator / aggregation metadata (engine-supported set ONLY)
// ---------------------------------------------------------------------------

export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  in_list: "in",
};

export const AGG_LABELS: Record<AggFn, string> = {
  sum: "SUM",
  avg: "AVG",
  count: "COUNT",
  min: "MIN",
  max: "MAX",
};

export const ALL_AGG_FNS: AggFn[] = ["sum", "avg", "count", "min", "max"];

/** Which operators make sense for a given column data-type. */
export function operatorsFor(dataType: DataType): Operator[] {
  switch (dataType) {
    case "number":
      return ["eq", "neq", "gt", "gte", "lt", "lte", "in_list"];
    case "boolean":
      return ["eq", "neq"];
    case "string":
    default:
      return ["eq", "neq", "contains", "in_list"];
  }
}

/** The single operator that takes a multi-value (set) target. */
export const isMultiValueOperator = (op: Operator) => op === "in_list";

// ---------------------------------------------------------------------------
// Builder-side draft (loose, string-typed, carries UI ids)
// ---------------------------------------------------------------------------

export interface DraftFilter {
  /** Stable client id for React keys + edits (NOT sent to the engine). */
  id: string;
  column: string;
  operator: Operator;
  /** Scalar input as a raw string (coerced at compile time). */
  value: string;
  /** Multi-value input for `in_list` (coerced at compile time). */
  values: string[];
}

export interface QueryDraft {
  filters: DraftFilter[];
  groupBy: string;
  aggFn: AggFn;
  /** Metric column; ignored for COUNT. */
  metricColumn: string;
  sort: SortDir;
  limit: number;
}

export interface CompileResult {
  /** The strict query, present only when `errors` is empty. */
  query: Query | null;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Coercion + compilation
// ---------------------------------------------------------------------------

/** Coerce a raw string to the field's Cell type. Returns null if invalid. */
function coerce(raw: string, dataType: DataType): Cell | null {
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
    case "string":
    default:
      return v;
  }
}

/**
 * Compile a loose draft into the strict engine `Query`, validating along the
 * way. Pure — safe to call on every keystroke for live preview.
 */
export function compileQuery(
  draft: QueryDraft,
  fields: Field[],
): CompileResult {
  const errors: string[] = [];
  const byName = new Map(fields.map((f) => [f.name, f]));

  // --- GROUP BY (required dimension) ---
  if (!draft.groupBy) {
    errors.push("Choose a dimension to group by.");
  } else if (!byName.has(draft.groupBy)) {
    errors.push(`Unknown group-by column “${draft.groupBy}”.`);
  }

  // --- Aggregation ---
  if (draft.aggFn !== "count") {
    if (!draft.metricColumn) {
      errors.push(`${AGG_LABELS[draft.aggFn]} needs a metric column.`);
    } else if (!byName.has(draft.metricColumn)) {
      errors.push(`Unknown metric column “${draft.metricColumn}”.`);
    }
  }

  // --- Filters ---
  const filters: Filter[] = [];
  draft.filters.forEach((f, i) => {
    const field = byName.get(f.column);
    if (!field) {
      errors.push(`Filter ${i + 1}: pick a column.`);
      return;
    }
    if (!operatorsFor(field.dataType).includes(f.operator)) {
      errors.push(
        `Filter ${i + 1}: “${OPERATOR_LABELS[f.operator]}” is not valid for ${field.label}.`,
      );
      return;
    }

    if (isMultiValueOperator(f.operator)) {
      const coerced = f.values
        .map((v) => coerce(v, field.dataType))
        .filter((v): v is Cell => v !== null);
      if (coerced.length === 0) {
        errors.push(`Filter ${i + 1}: add at least one value.`);
        return;
      }
      filters.push({
        column: f.column,
        operator: f.operator,
        values: coerced,
      });
    } else {
      const coerced = coerce(f.value, field.dataType);
      if (coerced === null) {
        errors.push(`Filter ${i + 1}: enter a valid ${field.dataType} value.`);
        return;
      }
      filters.push({
        column: f.column,
        operator: f.operator,
        value: coerced,
      });
    }
  });

  if (errors.length > 0) return { query: null, errors };

  const query: Query = {
    // Always an array, never `undefined` — the Rust side's `filters: Vec<Filter>`
    // expects a present (possibly empty) array; a key present with value
    // `undefined` survives postMessage's structured clone and breaks
    // serde_wasm_bindgen's deserialization ("Reflect.get called on non-object").
    filters,
    group_by: draft.groupBy,
    aggregation: {
      func: draft.aggFn,
      column: draft.aggFn === "count" ? undefined : draft.metricColumn,
    },
    sort: draft.sort,
    limit: draft.limit,
  };

  return { query, errors: [] };
}

/** Render a `Cell` as the raw string the builder inputs expect. */
function cellToString(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return "";
  return String(cell);
}

/**
 * Decompile a strict `Query` back into a loose `QueryDraft` for the builder.
 *
 * The inverse of {@link compileQuery}, used when the SQL→Builder bridge returns
 * a representable query and we need to populate the visual controls. Unknown
 * columns are kept as-is (the builder's own validation will flag them); missing
 * sort/limit fall back to the empty-draft defaults.
 */
export function queryToDraft(query: Query, fields: Field[]): QueryDraft {
  const base = emptyDraft(fields);
  const filters: DraftFilter[] = (query.filters ?? []).map((f, i) => {
    const multi = isMultiValueOperator(f.operator);
    return {
      id: `f${i + 1}`,
      column: f.column,
      operator: f.operator,
      value: multi ? "" : cellToString(f.value ?? undefined),
      values: multi ? (f.values ?? []).map((v) => cellToString(v ?? undefined)) : [],
    };
  });

  return {
    filters,
    groupBy: query.group_by,
    aggFn: query.aggregation.func,
    metricColumn: query.aggregation.column ?? base.metricColumn,
    sort: query.sort ?? base.sort,
    limit: query.limit ?? base.limit,
  };
}

/** A sensible empty draft for first render. */
export function emptyDraft(fields: Field[]): QueryDraft {
  const firstDim = fields.find(isDimension);
  const firstMetric = fields.find(isMetric);
  return {
    filters: [],
    groupBy: firstDim?.name ?? "",
    aggFn: "sum",
    metricColumn: firstMetric?.name ?? "",
    sort: "desc",
    limit: 50,
  };
}

/**
 * A runnable example statement for the given schema — "SUM(first metric) by
 * first dimension" — generated purely in TS (no worker round-trip, so it never
 * touches the Rust bridge). Seeds the SQL editor so a fresh source never opens
 * to a blank tab. Mirrors the Rust bridge's `query_to_sql` quoting/aliasing so
 * it reads like real generated SQL. Returns "" when the schema has no
 * dimension+metric pair to build one from.
 */
export function sampleSql(fields: Field[], tableName: string): string {
  const dim = fields.find(isDimension);
  const metric = fields.find(isMetric);
  if (!dim || !metric) return "";
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const alias = quote(`sum_${metric.name}`);
  return [
    `SELECT ${quote(dim.name)}, SUM(${quote(metric.name)}) AS ${alias}`,
    `FROM ${quote(tableName)}`,
    `GROUP BY ${quote(dim.name)}`,
    `ORDER BY ${alias} DESC`,
    `LIMIT 10`,
  ].join("\n");
}
