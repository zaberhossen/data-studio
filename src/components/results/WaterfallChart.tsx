"use client";

/**
 * WaterfallChart — running cumulative of signed steps, drawn with the classic
 * stacked-bar technique: an invisible `base` bar lifts a visible `delta` bar to
 * the right height. A final "Total" bar sums the run.
 *
 * Dataviz notes: direction is a state, so increases wear `--viz-good` and
 * decreases `--viz-critical` (reserved status colors, legitimate for gain/loss),
 * the total a neutral categorical hue; a legend + on-bar signed labels make the
 * encoding non-color-alone. ONE axis. Fed `{label,value}[]` via `categoryValues`.
 */

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ResultTable } from "@/lib/types/results";
import type { WidgetViz } from "@/lib/types/query";
import { categoryValues } from "@/lib/viz/chart-data";
import { makeNumberFormatter, compactFormat } from "@/lib/viz/format";

const AXIS = "var(--viz-axis)";
const GRID = "var(--viz-grid)";
const TICK = { fontSize: 11, fill: "hsl(var(--muted-foreground))" } as const;
const UP = "var(--viz-good)";
const DOWN = "var(--viz-critical)";
const TOTAL = "var(--viz-3)";

interface Props {
  table: ResultTable;
  viz: WidgetViz;
}

interface Bucket {
  name: string;
  base: number;
  delta: number;
  value: number;
  color: string;
}

export function WaterfallChart({ table, viz }: Props) {
  const fmt = React.useMemo(() => makeNumberFormatter(viz.numberFormat), [viz.numberFormat]);
  const axisFmt = viz.numberFormat ? fmt : (v: unknown) => compactFormat(v);

  const rows = categoryValues(table, viz);
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No steps for the waterfall.
      </div>
    );
  }

  // Build cumulative buckets in a single pass. A plain for-loop (no closure
  // capturing `cum`) keeps the running total local to the render computation.
  const buckets: Bucket[] = [];
  let cum = 0;
  for (const r of rows) {
    const start = cum;
    const end = cum + r.value;
    cum = end;
    buckets.push({
      name: r.label,
      base: Math.min(start, end),
      delta: Math.abs(r.value),
      value: r.value,
      color: r.value >= 0 ? UP : DOWN,
    });
  }
  buckets.push({ name: "Total", base: 0, delta: Math.abs(cum), value: cum, color: TOTAL });

  return (
    <div className="h-full min-h-0">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={buckets} margin={{ top: 12, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tick={TICK} tickLine={false} axisLine={{ stroke: AXIS }} />
          <YAxis
            tick={TICK}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={axisFmt as (v: number) => string}
          />
          <Tooltip cursor={{ fill: "rgba(127,127,127,0.08)" }} content={<WaterfallTooltip fmt={fmt} />} />
          <Legend
            payload={[
              { value: "Increase", type: "square", id: "up", color: UP },
              { value: "Decrease", type: "square", id: "down", color: DOWN },
              { value: "Total", type: "square", id: "total", color: TOTAL },
            ]}
            wrapperStyle={{ fontSize: 12 }}
          />
          {/* Invisible lifter */}
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          {/* Visible step */}
          <Bar dataKey="delta" stackId="w" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {buckets.map((b, i) => (
              <Cell key={i} fill={b.color} />
            ))}
            <LabelList
              dataKey="value"
              position="top"
              fontSize={11}
              fill="hsl(var(--muted-foreground))"
              formatter={(v: number) => (v >= 0 ? "+" : "") + fmt(v)}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function WaterfallTooltip({
  active,
  payload,
  fmt,
}: {
  active?: boolean;
  payload?: Array<{ payload: Bucket }>;
  fmt: (v: unknown) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const b = payload[0].payload;
  return (
    <div
      style={{
        background: "hsl(var(--popover))",
        border: "1px solid hsl(var(--border))",
        borderRadius: 8,
        fontSize: 12,
        padding: "6px 10px",
      }}
    >
      <div className="font-medium">{b.name}</div>
      <div className="tabular-nums text-muted-foreground">
        {b.value >= 0 ? "+" : ""}
        {fmt(b.value)}
      </div>
    </div>
  );
}
