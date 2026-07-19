/**
 * Drill-through — Metabase-style click actions as PURE IrDraft rewrites.
 *
 * Every action takes the current draft + fields and returns a NEW draft (or
 * null when the action doesn't apply); the caller compiles and runs it through
 * the normal LOCAL pipeline, so drills are instant and never touch a server.
 *
 * Temporal dimensions filter as a half-open range [bucketStart, nextBucket)
 * computed in UTC from the clicked bucket value — the same value DuckDB's
 * date_trunc emitted — so "zoom into this month" is exact.
 */

import type { TemporalUnit } from "@/lib/query/ir";
import {
  draftDimAlias,
  draftMetricAlias,
  newDraftDimension,
  newDraftFilter,
  newDraftMetric,
  newDraftSort,
  type DraftIrFilter,
  type IrDraft,
} from "@/lib/query/ir-draft";
import type { Field } from "@/lib/query/schema";

// ── Column resolution ────────────────────────────────────────────────────────

export type ResolvedColumn =
  | { kind: "dimension"; index: number }
  | { kind: "metric"; index: number }
  | { kind: "raw"; field: Field }
  | { kind: "other" };

/** Map a RESULT column name back to what it is in the draft. */
export function resolveResultColumn(
  draft: IrDraft,
  fields: Field[],
  name: string,
): ResolvedColumn {
  const aggregated = draft.dimensions.length > 0 || draft.metrics.length > 0;
  if (aggregated) {
    const di = draft.dimensions.findIndex((d) => d.column && draftDimAlias(d) === name);
    if (di >= 0) return { kind: "dimension", index: di };
    const mi = draft.metrics.findIndex((m, i) => draftMetricAlias(m, i) === name);
    if (mi >= 0) return { kind: "metric", index: mi };
    return { kind: "other" };
  }
  const field = fields.find((f) => f.name === name);
  return field ? { kind: "raw", field } : { kind: "other" };
}

// ── Temporal bucket ranges ───────────────────────────────────────────────────

/** Units whose buckets are a contiguous range (derived units like DOW aren't). */
const RANGE_UNITS: ReadonlySet<TemporalUnit> = new Set([
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
]);

/** Zoom ladder: the next finer bucket. */
export const ZOOM_NEXT: Partial<Record<TemporalUnit, TemporalUnit>> = {
  year: "quarter",
  quarter: "month",
  month: "week",
  week: "day",
  day: "hour",
  hour: "minute",
};

function toUtcDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== "string") return null;
  let s = value.trim();
  if (!s) return null;
  // "YYYY-MM-DD[ HH:MM:SS]" → strict UTC ISO so local timezone never shifts it.
  if (!s.includes("T")) s = s.replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  if (!s.includes("T")) s += "T00:00:00";
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** [bucketStart, nextBucketStart) for a clicked temporal bucket value. */
export function bucketRange(
  value: unknown,
  unit: TemporalUnit,
): { low: string; high: string } | null {
  if (!RANGE_UNITS.has(unit)) return null;
  const start = toUtcDate(value);
  if (!start) return null;
  const end = new Date(start);
  switch (unit) {
    case "year":
      end.setUTCFullYear(end.getUTCFullYear() + 1);
      break;
    case "quarter":
      end.setUTCMonth(end.getUTCMonth() + 3);
      break;
    case "month":
      end.setUTCMonth(end.getUTCMonth() + 1);
      break;
    case "week":
      end.setUTCDate(end.getUTCDate() + 7);
      break;
    case "day":
      end.setUTCDate(end.getUTCDate() + 1);
      break;
    case "hour":
      end.setUTCHours(end.getUTCHours() + 1);
      break;
    case "minute":
      end.setUTCMinutes(end.getUTCMinutes() + 1);
      break;
    default:
      return null;
  }
  return { low: fmtUtc(start), high: fmtUtc(end) };
}

// ── Filter-leaf builders ─────────────────────────────────────────────────────

/** Leaves that pin `column` to a clicked value (range for temporal buckets). */
function leavesForValue(
  column: string,
  value: unknown,
  temporal: TemporalUnit | undefined,
  fields: Field[],
): DraftIrFilter[] | null {
  if (!fields.some((f) => f.name === column)) return null; // calc/window dims can't filter
  if (value == null) return [newDraftFilter(column, "is_null")];
  if (temporal) {
    const range = bucketRange(value, temporal);
    if (!range) return null;
    return [
      { ...newDraftFilter(column, "gte"), value: range.low },
      { ...newDraftFilter(column, "lt"), value: range.high },
    ];
  }
  return [{ ...newDraftFilter(column, "eq"), value: String(value) }];
}

// ── Drill actions (draft → new draft, or null when unavailable) ──────────────

/** Filter the current query to a clicked value (keeps everything else). */
export function drillFilterEq(
  draft: IrDraft,
  fields: Field[],
  columnName: string,
  value: unknown,
): IrDraft | null {
  const resolved = resolveResultColumn(draft, fields, columnName);
  let leaves: DraftIrFilter[] | null = null;
  if (resolved.kind === "dimension") {
    const dim = draft.dimensions[resolved.index];
    leaves = leavesForValue(dim.column, value, dim.temporal, fields);
  } else if (resolved.kind === "raw") {
    leaves = leavesForValue(resolved.field.name, value, undefined, fields);
  }
  if (!leaves) return null;
  return { ...draft, filters: [...draft.filters, ...leaves], offset: 0 };
}

/** A numeric BETWEEN leaf, min/max-ordered; null if either bound isn't a number. */
function numericBetween(column: string, a: unknown, b: unknown): DraftIrFilter[] | null {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return null;
  const low = Math.min(na, nb);
  const high = Math.max(na, nb);
  return [{ ...newDraftFilter(column, "between"), low: String(low), high: String(high) }];
}

/**
 * Range-select on a continuous axis (chart drag): filter `column` to the span
 * between two boundary values `a` and `b` (order-independent). A temporal
 * dimension filters `[min bucket start, max bucket next-start)`; a raw numeric
 * column filters `BETWEEN`. Returns null for anything without a meaningful
 * continuous range (categorical breakouts, calc/window columns, non-numeric raw).
 * Like every drill, a pure draft→draft LOCAL rewrite — it only appends filters.
 */
export function drillFilterRange(
  draft: IrDraft,
  fields: Field[],
  columnName: string,
  a: unknown,
  b: unknown,
): IrDraft | null {
  const resolved = resolveResultColumn(draft, fields, columnName);
  let leaves: DraftIrFilter[] | null = null;

  if (resolved.kind === "dimension") {
    const dim = draft.dimensions[resolved.index];
    if (!fields.some((f) => f.name === dim.column)) return null; // calc/window dims
    if (dim.temporal) {
      const ra = bucketRange(a, dim.temporal);
      const rb = bucketRange(b, dim.temporal);
      if (!ra || !rb) return null;
      const low = ra.low <= rb.low ? ra.low : rb.low;
      const high = ra.high >= rb.high ? ra.high : rb.high;
      leaves = [
        { ...newDraftFilter(dim.column, "gte"), value: low },
        { ...newDraftFilter(dim.column, "lt"), value: high },
      ];
    } else {
      // A categorical breakout has no continuous range; only numeric qualifies.
      if (fields.find((f) => f.name === dim.column)?.dataType !== "number") return null;
      leaves = numericBetween(dim.column, a, b);
    }
  } else if (resolved.kind === "raw") {
    if (resolved.field.dataType !== "number") return null;
    leaves = numericBetween(resolved.field.name, a, b);
  }

  if (!leaves) return null;
  return { ...draft, filters: [...draft.filters, ...leaves], offset: 0 };
}

/** Temporal zoom: pin the clicked bucket AND re-bucket one step finer. */
export function drillZoomIn(
  draft: IrDraft,
  fields: Field[],
  columnName: string,
  value: unknown,
): IrDraft | null {
  const resolved = resolveResultColumn(draft, fields, columnName);
  if (resolved.kind !== "dimension") return null;
  const dim = draft.dimensions[resolved.index];
  if (!dim.temporal) return null;
  const next = ZOOM_NEXT[dim.temporal];
  if (!next) return null;
  const leaves = leavesForValue(dim.column, value, dim.temporal, fields);
  if (!leaves) return null;
  return {
    ...draft,
    dimensions: draft.dimensions.map((d, i) =>
      i === resolved.index ? { ...d, temporal: next, alias: undefined } : d,
    ),
    filters: [...draft.filters, ...leaves],
    // Old sort keys referenced the previous bucket alias; drop stale ones.
    sort: draft.sort.filter((s) => s.column !== draftDimAlias(dim)),
    offset: 0,
  };
}

/**
 * "View these records": the RAW rows behind an aggregated result row. The
 * clicked row's dimension cells become filters; the summarize layer is
 * removed (joins/calculated/filters are kept).
 */
export function drillViewRecords(
  draft: IrDraft,
  fields: Field[],
  rowCells: Array<{ column: string; value: unknown }>,
): IrDraft | null {
  const aggregated = draft.dimensions.length > 0 || draft.metrics.length > 0;
  if (!aggregated) return null;
  const added: DraftIrFilter[] = [];
  for (const cell of rowCells) {
    const resolved = resolveResultColumn(draft, fields, cell.column);
    if (resolved.kind !== "dimension") continue;
    const dim = draft.dimensions[resolved.index];
    const leaves = leavesForValue(dim.column, cell.value, dim.temporal, fields);
    if (leaves) added.push(...leaves);
  }
  return {
    ...draft,
    rawColumns: [],
    dimensions: [],
    metrics: [],
    having: [],
    windows: [],
    sort: [],
    filters: [...draft.filters, ...added],
    limit: 100,
    offset: 0,
  };
}

/**
 * Distribution of a column: COUNT grouped by it (dates bucket by month).
 * Numeric columns need binning (M12 Stage 3) — unavailable for now.
 */
export function drillDistribution(
  draft: IrDraft,
  fields: Field[],
  columnName: string,
): IrDraft | null {
  const underlying = underlyingColumn(draft, fields, columnName);
  if (!underlying || underlying.dataType === "number") return null;
  return {
    ...draft,
    rawColumns: [],
    dimensions: [
      {
        ...newDraftDimension(underlying.name),
        temporal: underlying.dataType === "date" ? "month" : undefined,
      },
    ],
    metrics: [newDraftMetric("count")],
    having: [],
    windows: [],
    sort: [newDraftSort("count", "desc")],
    limit: 50,
    offset: 0,
  };
}

/** Summarize a column over the current filters (sum/avg/distinct → a KPI). */
export function drillSummarize(
  draft: IrDraft,
  fields: Field[],
  columnName: string,
  fn: "sum" | "avg" | "count_distinct",
): IrDraft | null {
  const underlying = underlyingColumn(draft, fields, columnName);
  if (!underlying) return null;
  if ((fn === "sum" || fn === "avg") && underlying.dataType !== "number") return null;
  return {
    ...draft,
    rawColumns: [],
    dimensions: [],
    metrics: [newDraftMetric(fn, underlying.name)],
    having: [],
    windows: [],
    sort: [],
    limit: 50,
    offset: 0,
  };
}

/** The SOURCE column behind a result column (dimension alias or raw name). */
function underlyingColumn(
  draft: IrDraft,
  fields: Field[],
  columnName: string,
): Field | null {
  const resolved = resolveResultColumn(draft, fields, columnName);
  if (resolved.kind === "raw") return resolved.field;
  if (resolved.kind === "dimension") {
    const dim = draft.dimensions[resolved.index];
    return fields.find((f) => f.name === dim.column) ?? null;
  }
  return null;
}
