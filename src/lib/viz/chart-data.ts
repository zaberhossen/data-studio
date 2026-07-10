/**
 * ResultTable → multi-series chart model.
 *
 * The Rust builder emits a single-series `ChartPayload` ({label,value}[]); the
 * SQL/IR path emits a wide `ResultTable` (a category column + one or more numeric
 * measure columns). To chart multi-metric / stacked / combo, we normalize to a
 * Recharts-friendly shape: an array of row objects keyed by a synthetic category
 * field plus one field per measure series.
 *
 * Series selection mirrors Metabase/Data-Studio defaults and the dataviz method:
 *   • x = `viz.xKey` (else the first column).
 *   • series = `viz.yKeys` (explicit multi) → `viz.yKey` (single) → every OTHER
 *     numeric column. Capped at MAX_SERIES (fixed palette order, never cycled);
 *     any beyond the cap are reported in `dropped` so the caller can disclose it
 *     rather than silently hide data.
 */

import type { ResultTable } from "@/lib/types/results";
import type { WidgetViz } from "@/lib/types/query";
import { MAX_SERIES } from "@/lib/viz/palette";

/** The synthetic per-row key holding the category (x) value. */
export const CATEGORY_KEY = "__x";

export interface ChartSeries {
  /** The row-object field + measure column name. */
  key: string;
  label: string;
}

export interface ChartData {
  /** Recharts rows: `{ [CATEGORY_KEY]: category, [seriesKey]: number, … }`. */
  rows: Array<Record<string, string | number | null>>;
  categoryKey: typeof CATEGORY_KEY;
  categoryLabel: string;
  series: ChartSeries[];
  /** Series that exceeded MAX_SERIES and were not rendered (disclose, don't hide). */
  dropped: number;
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A single labelled category → numeric value (funnel, waterfall, map). */
export interface CategoryValue {
  label: string;
  value: number;
}

/**
 * Extract `{label, value}[]` for the single-measure category charts. The label
 * column is `preferredLabel` (else `viz.xKey`, else the first non-numeric column,
 * else the first column); the value column is `viz.yKey` (else the first numeric
 * column, else the last column). Non-numeric values coerce to 0.
 */
export function categoryValues(
  table: ResultTable,
  viz: WidgetViz,
  preferredLabel?: string,
): CategoryValue[] {
  const cols = table.columns;
  if (cols.length === 0) return [];
  const findCol = (name?: string) =>
    name ? cols.findIndex((c) => c.name === name) : -1;

  let li = findCol(preferredLabel);
  if (li < 0) li = findCol(viz.xKey);
  if (li < 0) li = cols.findIndex((c) => c.type !== "number");
  if (li < 0) li = 0;

  let vi = findCol(viz.yKey);
  if (vi < 0) vi = cols.findIndex((c, i) => c.type === "number" && i !== li);
  if (vi < 0) vi = cols.findIndex((_, i) => i !== li);
  if (vi < 0) vi = cols.length - 1;

  return table.rows.map((r) => ({
    label: String(r[li] ?? "∅"),
    value: toNum(r[vi]) ?? 0,
  }));
}

/**
 * The single headline number (gauge, KPI): the first row's `viz.yKey` column
 * (else the first numeric column, else the last column), coerced to a number.
 */
export function singleValue(table: ResultTable, viz: WidgetViz): number | null {
  const cols = table.columns;
  if (cols.length === 0 || table.rows.length === 0) return null;
  let vi = viz.yKey ? cols.findIndex((c) => c.name === viz.yKey) : -1;
  if (vi < 0) vi = cols.findIndex((c) => c.type === "number");
  if (vi < 0) vi = cols.length - 1;
  return toNum(table.rows[0]?.[vi]);
}

export function resultTableToChartData(table: ResultTable, viz: WidgetViz): ChartData {
  const cols = table.columns;
  const xIdx = viz.xKey ? cols.findIndex((c) => c.name === viz.xKey) : 0;
  const xi = xIdx >= 0 ? xIdx : 0;

  const explicit =
    viz.yKeys && viz.yKeys.length > 0 ? viz.yKeys : viz.yKey ? [viz.yKey] : null;

  let seriesIdx: number[];
  if (explicit) {
    seriesIdx = explicit
      .map((name) => cols.findIndex((c) => c.name === name))
      .filter((i) => i >= 0);
  } else {
    seriesIdx = cols
      .map((c, i) => (c.type === "number" && i !== xi ? i : -1))
      .filter((i) => i >= 0);
  }
  // Guarantee at least one series — fall back to the first non-category column.
  if (seriesIdx.length === 0) {
    const fallback = cols.findIndex((_, i) => i !== xi);
    if (fallback >= 0) seriesIdx = [fallback];
  }

  const kept = seriesIdx.slice(0, MAX_SERIES);
  const series: ChartSeries[] = kept.map((i) => ({ key: cols[i].name, label: cols[i].name }));

  const rows = table.rows.map((r) => {
    const obj: Record<string, string | number | null> = {
      [CATEGORY_KEY]: (r[xi] as string | number | null) ?? "∅",
    };
    for (const i of kept) obj[cols[i].name] = toNum(r[i]);
    return obj;
  });

  return {
    rows,
    categoryKey: CATEGORY_KEY,
    categoryLabel: viz.xTitle ?? cols[xi]?.name ?? "",
    series,
    dropped: Math.max(0, seriesIdx.length - kept.length),
  };
}
