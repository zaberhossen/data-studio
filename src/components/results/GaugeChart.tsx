"use client";

/**
 * GaugeChart — a single value against a range, drawn as a 180° radial gauge
 * (Recharts `RadialBarChart` + `PolarAngleAxis`, the standard gauge recipe). The
 * value + min/max labels are overlaid as ink text (never a series color).
 *
 * Dataviz notes: one hue for the fill (magnitude), a recessive track, and an
 * optional status color from conditional rules (state, reserved). Range is
 * `viz.gaugeMin`..`viz.gaugeMax` (else 0..a nice value above the datum, or the
 * goal when set); an optional goal draws a thin marker on the arc.
 */

import * as React from "react";
import {
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
} from "recharts";
import type { ResultTable } from "@/lib/types/results";
import type { WidgetViz } from "@/lib/types/query";
import { singleValue } from "@/lib/viz/chart-data";
import { makeNumberFormatter, conditionalColor } from "@/lib/viz/format";

/** Round `n` up to the nearest 1/2/5 × 10^k so the gauge ends on a clean tick. */
function niceCeil(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const f = n / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * mag;
}

interface Props {
  table: ResultTable;
  viz: WidgetViz;
}

export function GaugeChart({ table, viz }: Props) {
  const raw = singleValue(table, viz);
  const fmt = React.useMemo(
    () => makeNumberFormatter(viz.numberFormat),
    [viz.numberFormat],
  );

  if (raw == null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No value for the gauge.
      </div>
    );
  }

  const min = viz.gaugeMin ?? 0;
  const max =
    viz.gaugeMax ??
    (viz.goal && viz.goal > raw ? viz.goal : niceCeil(Math.max(raw, min + 1)));
  const span = Math.max(1e-9, max - min);
  const clamped = Math.max(min, Math.min(max, raw));

  const color =
    conditionalColor(raw, viz.conditional) ?? "var(--viz-1)";

  const data = [{ name: "value", value: clamped }];
  const goalPct =
    viz.goal != null && viz.goal >= min && viz.goal <= max
      ? (viz.goal - min) / span
      : null;

  return (
    <div className="relative h-full min-h-0">
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          data={data}
          startAngle={180}
          endAngle={0}
          innerRadius="68%"
          outerRadius="100%"
          barSize={22}
          cy="72%"
        >
          <PolarAngleAxis
            type="number"
            domain={[min, max]}
            angleAxisId={0}
            tick={false}
            axisLine={false}
          />
          <RadialBar
            background={{ fill: "var(--viz-grid)" }}
            dataKey="value"
            cornerRadius={4}
            fill={color}
            isAnimationActive={false}
          />
        </RadialBarChart>
      </ResponsiveContainer>

      {/* Value + range overlay (ink text) */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end pb-[14%]">
        <div
          className="text-3xl font-semibold tabular-nums tracking-tight"
          style={{ color: color === "var(--viz-1)" ? undefined : color }}
        >
          {fmt(raw)}
          {viz.unit ? (
            <span className="ml-1 text-lg text-muted-foreground">{viz.unit}</span>
          ) : null}
        </div>
        {goalPct != null && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            goal {fmt(viz.goal)}
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-[6%] left-0 right-0 flex justify-between px-[12%] text-[11px] tabular-nums text-muted-foreground">
        <span>{fmt(min)}</span>
        <span>{fmt(max)}</span>
      </div>
    </div>
  );
}
