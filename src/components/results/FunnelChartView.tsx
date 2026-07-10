"use client";

/**
 * FunnelChartView — an ordered set of stages narrowing by value (Recharts
 * `Funnel`). Each stage gets a fixed-order categorical hue (never cycled); the
 * stage name sits beside the mark in ink and the value + conversion-from-first
 * ride the segment. Fed `{label,value}[]` via `categoryValues`.
 */

import * as React from "react";
import { Cell, Funnel, FunnelChart, LabelList, ResponsiveContainer, Tooltip } from "recharts";
import type { ResultTable } from "@/lib/types/results";
import type { WidgetViz } from "@/lib/types/query";
import { categoryValues } from "@/lib/viz/chart-data";
import { makeNumberFormatter } from "@/lib/viz/format";
import { seriesColor } from "@/lib/viz/palette";

interface Props {
  table: ResultTable;
  viz: WidgetViz;
}

export function FunnelChartView({ table, viz }: Props) {
  const fmt = React.useMemo(() => makeNumberFormatter(viz.numberFormat), [viz.numberFormat]);
  const rows = categoryValues(table, viz);
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No stages for the funnel.
      </div>
    );
  }

  const data = rows.map((r, i) => ({
    name: r.label,
    value: r.value,
    fill: seriesColor(i),
  }));

  return (
    <div className="h-full min-h-0">
      <ResponsiveContainer width="100%" height="100%">
        <FunnelChart margin={{ left: 8, right: 96, top: 8, bottom: 8 }}>
          <Tooltip
            formatter={(v: number) => fmt(v)}
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Funnel dataKey="value" data={data} isAnimationActive={false} stroke="hsl(var(--card))" strokeWidth={2}>
            {data.map((_, i) => (
              <Cell key={i} fill={seriesColor(i)} />
            ))}
            <LabelList
              position="right"
              dataKey="name"
              fill="hsl(var(--foreground))"
              stroke="none"
              fontSize={12}
            />
            <LabelList
              position="center"
              dataKey="value"
              fill="#fff"
              stroke="none"
              fontSize={11}
              formatter={(v: number) => fmt(v)}
            />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    </div>
  );
}
