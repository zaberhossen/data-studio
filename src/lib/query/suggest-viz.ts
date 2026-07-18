/**
 * Auto chart suggestion (Metabase-style "auto-viz"): pick a sensible default
 * visualization from the DRAFT's shape. Applied only while the user hasn't
 * chosen a type themselves (`useQueryWorkspace` tracks that).
 */

import type { IrDraft } from "@/lib/query/ir-draft";
import type { Field } from "@/lib/query/schema";
import type { WidgetVizType } from "@/lib/types/query";

export function suggestVizType(draft: IrDraft, fields: Field[]): WidgetVizType {
  const dims = draft.dimensions.filter((d) => d.column);
  const metrics = draft.metrics;
  const aggregated = dims.length > 0 || metrics.length > 0;

  // Raw listing (with or without column selection) → table.
  if (!aggregated) return "table";
  // Metrics over all rows → a single number.
  if (dims.length === 0) return "kpi";

  const byName = new Map(fields.map((f) => [f.name, f]));
  const first = dims[0];
  const temporal = first.temporal !== undefined || byName.get(first.column)?.dataType === "date";

  if (dims.length === 1) return temporal ? "line" : "bar";
  // Two+ breakouts: time series → line (per-series), else grouped bar.
  return temporal ? "line" : "bar";
}
