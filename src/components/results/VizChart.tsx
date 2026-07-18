"use client";

/**
 * VizChart — the single multi-series chart renderer (Recharts), driven by a
 * `ResultTable` + a `WidgetViz` config. Replaces the old single-series
 * `ResultsChart` for bar/line/area/pie/scatter/combo.
 *
 * Dataviz rules baked in (see the dataviz skill):
 *   • Categorical colors in FIXED palette order, never cycled; pie folds a long
 *     tail into "Other" rather than reusing a hue.
 *   • A legend is present for ≥ 2 series (a single series is named by the title).
 *   • ONE y-axis only — `combo` is bar + line on a shared scale (never dual-axis).
 *   • Recessive grid/axis; a hover tooltip on every type; values wear the number
 *     format; axis/tick text uses muted INK, never a series color.
 */

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Label,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { ResultTable } from "@/lib/types/results";
import type { WidgetViz } from "@/lib/types/query";
import { resultTableToChartData, CATEGORY_KEY } from "@/lib/viz/chart-data";
import { seriesColor, MAX_SERIES } from "@/lib/viz/palette";
import { makeNumberFormatter, compactFormat } from "@/lib/viz/format";
import { GaugeChart } from "./GaugeChart";
import { FunnelChartView } from "./FunnelChartView";
import { WaterfallChart } from "./WaterfallChart";
import { GeoMapLazy } from "./GeoMapLazy";

const AXIS = "var(--viz-axis)";
const GRID = "var(--viz-grid)";
const TICK = { fontSize: 11, fill: "hsl(var(--muted-foreground))" } as const;

interface Props {
  table: ResultTable | null;
  viz: WidgetViz;
  /** Click a mark → emit its category value (cross-filter). */
  onCategoryClick?: (value: string) => void;
}

function Empty({ note = "No chartable data." }: { note?: string }) {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center text-sm text-muted-foreground">
      {note}
    </div>
  );
}

export function VizChart({ table, viz, onCategoryClick }: Props) {
  const fmt = React.useMemo(() => makeNumberFormatter(viz.numberFormat), [viz.numberFormat]);
  const axisFmt = viz.numberFormat ? fmt : (v: unknown) => compactFormat(v);

  if (!table || table.rows.length === 0) return <Empty />;
  if (viz.type === "scatter") return <ScatterView table={table} viz={viz} fmt={fmt} />;
  if (viz.type === "gauge") return <GaugeChart table={table} viz={viz} />;
  if (viz.type === "funnel") return <FunnelChartView table={table} viz={viz} />;
  if (viz.type === "waterfall") return <WaterfallChart table={table} viz={viz} />;
  if (viz.type === "map") return <GeoMapLazy table={table} viz={viz} />;

  const data = resultTableToChartData(table, viz);
  if (data.series.length === 0) return <Empty />;

  const color = (key: string, i: number) => viz.colors?.[key] ?? seriesColor(i);
  const seriesName = (s: { key: string; label: string }) =>
    viz.seriesLabels?.[s.key] ?? s.label;
  const showLegend = data.series.length >= 2 && viz.legend !== "none";
  const legendEl = showLegend ? <Legend {...legendProps(viz.legend)} /> : null;
  const percent = viz.stack === "percent";
  const stacked = viz.stack === "stacked" || percent;
  const yTickFmt = percent ? (v: number) => `${Math.round(v * 100)}%` : axisFmt;
  // Data labels (bar/line/area/combo, skipped for percent-stacks where they
  // would read as raw values on a 0–1 axis).
  const markLabels =
    viz.dataLabels && !percent ? (
      <LabelList
        position="top"
        fontSize={10}
        fill="hsl(var(--muted-foreground))"
        formatter={(v: React.ReactNode) => (typeof v === "number" ? axisFmt(v) : String(v ?? ""))}
      />
    ) : null;
  const refLine =
    viz.refLineValue !== undefined && !percent ? (
      <ReferenceLine
        y={viz.refLineValue}
        stroke="hsl(var(--muted-foreground))"
        strokeDasharray="4 4"
        ifOverflow="extendDomain"
        label={
          viz.refLineLabel
            ? { value: viz.refLineLabel, position: "insideTopRight", fontSize: 10, fill: "hsl(var(--muted-foreground))" }
            : undefined
        }
      />
    ) : null;

  const handleClick =
    onCategoryClick && viz.type !== "pie"
      ? (e: { activeLabel?: string | number }) => {
          if (e?.activeLabel != null) onCategoryClick(String(e.activeLabel));
        }
      : undefined;

  const xAxis = (
    <XAxis dataKey={CATEGORY_KEY} tick={TICK} tickLine={false} axisLine={{ stroke: AXIS }}>
      {viz.xTitle ? <Label value={viz.xTitle} position="insideBottom" offset={-4} fill="hsl(var(--muted-foreground))" fontSize={11} /> : null}
    </XAxis>
  );
  const linearDomain =
    viz.yMin !== undefined || viz.yMax !== undefined
      ? ([viz.yMin ?? "auto", viz.yMax ?? "auto"] as [number | "auto", number | "auto"])
      : undefined;
  const yAxis = (
    <YAxis
      tick={TICK}
      tickLine={false}
      axisLine={false}
      width={56}
      tickFormatter={yTickFmt as (v: number) => string}
      scale={viz.yScale === "log" ? "log" : "auto"}
      domain={viz.yScale === "log" ? [1, "auto"] : linearDomain}
      allowDataOverflow={viz.yScale === "log" || linearDomain !== undefined}
    >
      {viz.yTitle ? <Label value={viz.yTitle} angle={-90} position="insideLeft" fill="hsl(var(--muted-foreground))" fontSize={11} /> : null}
    </YAxis>
  );
  const tooltip = (
    <Tooltip
      formatter={(v: number) => fmt(v)}
      cursor={{ fill: "rgba(127,127,127,0.08)" }}
      contentStyle={{
        background: "hsl(var(--popover))",
        border: "1px solid hsl(var(--border))",
        borderRadius: 8,
        fontSize: 12,
      }}
    />
  );
  const grid = <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {data.dropped > 0 && (
        <p className="shrink-0 pb-1 text-right text-[10px] text-muted-foreground">
          +{data.dropped} series beyond the palette cap not shown — narrow the series
          selection to choose which.
        </p>
      )}
      <div className="min-h-0 flex-1">
      <ResponsiveContainer width="100%" height="100%">
        {viz.type === "pie" ? (
          <PieChart>
            {tooltip}
            {legendEl}
            <Pie
              data={pieSlices(data)}
              dataKey="value"
              nameKey="name"
              innerRadius={viz.donut ? "55%" : 0}
              outerRadius="80%"
              paddingAngle={1}
              isAnimationActive={false}
              stroke="hsl(var(--card))"
              strokeWidth={2}
            >
              {pieSlices(data).map((_, i) => (
                <Cell key={i} fill={seriesColor(i)} />
              ))}
            </Pie>
          </PieChart>
        ) : viz.type === "line" ? (
          <LineChart data={data.rows} onClick={handleClick}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {legendEl}
            {refLine}
            {data.series.map((s, i) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={seriesName(s)} stroke={color(s.key, i)} strokeWidth={2} dot={false} isAnimationActive={false}>
                {markLabels}
              </Line>
            ))}
          </LineChart>
        ) : viz.type === "area" ? (
          <AreaChart data={data.rows} onClick={handleClick} stackOffset={percent ? "expand" : undefined}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {legendEl}
            {refLine}
            {data.series.map((s, i) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={seriesName(s)}
                stackId={stacked ? "a" : undefined}
                stroke={color(s.key, i)}
                fill={color(s.key, i)}
                fillOpacity={0.25}
                strokeWidth={2}
                isAnimationActive={false}
              >
                {markLabels}
              </Area>
            ))}
          </AreaChart>
        ) : viz.type === "combo" ? (
          <ComposedChart data={data.rows} onClick={handleClick}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {legendEl}
            {refLine}
            {data.series.map((s, i) =>
              viz.lineKeys?.includes(s.key) ? (
                <Line key={s.key} type="monotone" dataKey={s.key} name={seriesName(s)} stroke={color(s.key, i)} strokeWidth={2} dot={false} isAnimationActive={false}>
                  {markLabels}
                </Line>
              ) : (
                <Bar key={s.key} dataKey={s.key} name={seriesName(s)} fill={color(s.key, i)} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {markLabels}
                </Bar>
              ),
            )}
          </ComposedChart>
        ) : (
          // bar (grouped / stacked / percent)
          <BarChart data={data.rows} onClick={handleClick} stackOffset={percent ? "expand" : undefined}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {legendEl}
            {refLine}
            {data.series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={seriesName(s)}
                fill={color(s.key, i)}
                stackId={stacked ? "a" : undefined}
                radius={stacked ? 0 : [4, 4, 0, 0]}
                isAnimationActive={false}
              >
                {markLabels}
              </Bar>
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Legend placement → Recharts props. */
function legendProps(pos: WidgetViz["legend"]) {
  const base = { wrapperStyle: { fontSize: 12 } as React.CSSProperties };
  if (pos === "right") return { ...base, layout: "vertical" as const, align: "right" as const, verticalAlign: "middle" as const };
  if (pos === "top") return { ...base, verticalAlign: "top" as const, align: "center" as const };
  return { ...base, verticalAlign: "bottom" as const, align: "center" as const };
}

/**
 * Pie slices from the first series: fold a long tail into "Other" so colors are
 * never cycled past the fixed palette (dataviz non-negotiable).
 */
function pieSlices(data: ReturnType<typeof resultTableToChartData>): Array<{ name: string; value: number }> {
  const key = data.series[0]?.key;
  if (!key) return [];
  const slices = data.rows
    .map((r) => ({ name: String(r[CATEGORY_KEY] ?? "∅"), value: Number(r[key] ?? 0) }))
    .sort((a, b) => b.value - a.value);
  if (slices.length <= MAX_SERIES) return slices;
  const head = slices.slice(0, MAX_SERIES - 1);
  const other = slices.slice(MAX_SERIES - 1).reduce((sum, s) => sum + s.value, 0);
  return [...head, { name: "Other", value: other }];
}

/**
 * Scatter / bubble: x = first numeric column, y = second, optional bubble size =
 * third. A category (string/date) column labels each point in the tooltip.
 */
function ScatterView({
  table,
  viz,
  fmt,
}: {
  table: ResultTable;
  viz: WidgetViz;
  fmt: (v: unknown) => string;
}) {
  const nums = table.columns.map((c, i) => ({ c, i })).filter(({ c }) => c.type === "number");
  if (nums.length < 2) return <Empty note="Scatter needs at least two numeric columns." />;
  const xi = nums[0].i;
  const yi = nums[1].i;
  const zi = nums[2]?.i;
  const labelIdx = table.columns.findIndex((c) => c.type !== "number");
  const points = table.rows.map((r) => ({
    x: Number(r[xi] ?? 0),
    y: Number(r[yi] ?? 0),
    z: zi != null ? Number(r[zi] ?? 0) : 1,
    label: labelIdx >= 0 ? String(r[labelIdx] ?? "") : "",
  }));

  return (
    <div className="h-full min-h-0">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
          <XAxis type="number" dataKey="x" name={table.columns[xi].name} tick={TICK} tickLine={false} axisLine={{ stroke: AXIS }} tickFormatter={(v) => compactFormat(v)}>
            <Label value={viz.xTitle ?? table.columns[xi].name} position="insideBottom" offset={-4} fill="hsl(var(--muted-foreground))" fontSize={11} />
          </XAxis>
          <YAxis type="number" dataKey="y" name={table.columns[yi].name} tick={TICK} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => compactFormat(v)}>
            <Label value={viz.yTitle ?? table.columns[yi].name} angle={-90} position="insideLeft" fill="hsl(var(--muted-foreground))" fontSize={11} />
          </YAxis>
          {zi != null ? <ZAxis type="number" dataKey="z" range={[40, 400]} name={table.columns[zi].name} /> : null}
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            formatter={(v: number) => fmt(v)}
            contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
          />
          <Scatter data={points} fill={seriesColor(0)} isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
