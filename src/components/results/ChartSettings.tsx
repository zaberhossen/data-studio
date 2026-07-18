"use client";

/**
 * ChartSettings — the full visualization editor for the query pages
 * (/editor + /sql): the complete chart-type picker + the same `VizFormatPanel`
 * the dashboard uses, bound to the RESULT's columns (not the source schema),
 * so axis/series options always match what the query actually returned.
 */

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VizFormatPanel } from "@/components/dashboard/VizFormatPanel";
import type { Field } from "@/lib/query/schema";
import type { ResultTable } from "@/lib/types/results";
import type { WidgetViz, WidgetVizType } from "@/lib/types/query";

const TYPE_LABELS: Array<[WidgetVizType, string]> = [
  ["bar", "Bar"],
  ["line", "Line"],
  ["area", "Area"],
  ["combo", "Combo (bar + line)"],
  ["pie", "Pie / donut"],
  ["scatter", "Scatter"],
  ["kpi", "KPI number"],
  ["gauge", "Gauge"],
  ["funnel", "Funnel"],
  ["waterfall", "Waterfall"],
  ["map", "Map"],
  ["pivot", "Pivot table"],
  ["table", "Table"],
];

/** Result columns → the Field-ish shape `VizFormatPanel` binds to. */
export function fieldsFromResult(table: ResultTable | null): Field[] {
  if (!table) return [];
  return table.columns.map((c) => ({
    name: c.name,
    label: c.name,
    role: c.type === "number" ? ("metric" as const) : ("dimension" as const),
    dataType: c.type === "number" ? ("number" as const) : ("string" as const),
  }));
}

export function ChartSettings({
  viz,
  table,
  onChange,
}: {
  viz: WidgetViz;
  table: ResultTable | null;
  onChange: (viz: WidgetViz) => void;
}) {
  const fields = React.useMemo(() => fieldsFromResult(table), [table]);
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Chart type
        </span>
        <Select
          value={viz.type}
          onValueChange={(v) => onChange({ ...viz, type: v as WidgetVizType })}
        >
          <SelectTrigger className="h-8 w-full" aria-label="Chart type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPE_LABELS.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <VizFormatPanel viz={viz} fields={fields} onChange={(patch) => onChange({ ...viz, ...patch })} />
    </div>
  );
}
