/**
 * Turn any normalized `ResultTable` into a `ChartPayload` so chart/KPI viz works
 * for EVERY engine (Rust builder, DuckDB SQL, and pushed-down IR) — not just the
 * builder path that natively produces a `ChartPayload`.
 *
 * Column selection mirrors Metabase/Data-Studio defaults: an explicit `xKey`/
 * `yKey` (from the widget's viz config) wins; otherwise the first column is the
 * category axis and the first OTHER numeric column is the measure.
 */

import type { ChartPayload } from "@/lib/types/analytics";
import type { ResultTable } from "@/lib/types/results";

/** Just the fields of `WidgetViz` this adapter needs. */
export interface ChartAxes {
  xKey?: string;
  yKey?: string;
}

export function resultTableToChartPayload(
  table: ResultTable,
  viz: ChartAxes = {},
): ChartPayload {
  const cols = table.columns;
  const xIdx = viz.xKey ? cols.findIndex((c) => c.name === viz.xKey) : 0;
  const xi = xIdx >= 0 ? xIdx : 0;
  const yIdx = viz.yKey
    ? cols.findIndex((c) => c.name === viz.yKey)
    : cols.findIndex((c, i) => c.type === "number" && i !== xi);
  const yi = yIdx >= 0 ? yIdx : Math.min(1, cols.length - 1);
  const points = table.rows.map((r) => ({
    label: String(r[xi] ?? "∅"),
    value: Number(r[yi] ?? 0),
  }));
  return {
    points,
    rows_matched: table.totalRows,
    rows_total: table.totalRows,
    metric_label: cols[yi]?.name ?? "value",
  };
}
