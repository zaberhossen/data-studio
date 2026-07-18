/**
 * The shared query CORE — the declarative definition of a question the engines
 * can answer, independent of WHERE it lives (a dashboard tile or a saved query).
 *
 * `QueryDefinition` is the single source of truth for "what to run and how to
 * show it": which source, which engine path, the builder `Query` or the raw
 * `sql`, and the visualization. A dashboard `Widget` is a `QueryDefinition` plus
 * grid placement; a `SavedQuery` is a `QueryDefinition` plus a name + identity +
 * timestamps. Neither ever holds a `Row`, a `ChartPayload`, or a `SqlResult` —
 * the golden rule of the whole system: store DEFINITIONS, never results, and
 * reference a `sourceId` only (credentials stay server-side).
 *
 * These are plain data (no functions, no class instances), so they round-trip
 * cleanly through `JSON.stringify` for either persistence store.
 */

import type { Query } from "@/lib/types/analytics";
import type { QueryIR } from "@/lib/query/ir";

/**
 * How a query's result renders. The original four (`bar`/`line`/`table`/`kpi`)
 * are unchanged; M7 adds the Metabase/Data-Studio breadth. NOTE: there is
 * deliberately NO dual-axis type — two y-scales is a charting anti-pattern; a
 * `combo` is bar+line on ONE shared scale.
 */
export type WidgetVizType =
  | "bar"
  | "line"
  | "area"
  | "pie"
  | "scatter"
  | "combo"
  | "table"
  | "kpi"
  | "pivot"
  | "gauge"
  | "funnel"
  | "waterfall"
  | "map";

/** Value number-formatting (axis ticks, tooltips, KPI, table cells). */
export interface NumberFormat {
  style?: "plain" | "compact" | "currency" | "percent";
  /** ISO 4217 code when `style === "currency"` (default "USD"). */
  currency?: string;
  decimals?: number;
  prefix?: string;
  suffix?: string;
}

/**
 * A conditional-formatting rule (tables + KPI): when the cell/value satisfies
 * the comparison, paint it `color` (a `viz-*` status var or any CSS color).
 */
export interface ConditionalRule {
  /** Target column (table). Omit or "*" → the KPI value / first metric. */
  column?: string;
  op: "gt" | "gte" | "lt" | "lte" | "eq" | "between";
  value: number;
  /** Upper bound for `between`. */
  value2?: number;
  color: string;
}

/**
 * The full visualization config, persisted on a widget/saved-query definition
 * (never any result data). Every field beyond `type` is optional and additive,
 * so pre-M7 definitions (which set only `type`/`xKey`/`yKey`/`unit`) still parse.
 */
export interface WidgetViz {
  type: WidgetVizType;
  /** Category/X axis column. Defaults to the result's first column. */
  xKey?: string;
  /** Single measure column (back-compat). Defaults to the first numeric column. */
  yKey?: string;
  /** Multiple measure columns → multi-series (bar/line/area/combo). */
  yKeys?: string[];
  /** KPI/gauge unit shown after the value (e.g. "$", "%"). */
  unit?: string;
  /** Bar/area stacking mode. */
  stack?: "none" | "stacked" | "percent";
  /** Combo: measure columns drawn as a line (the rest are bars) on one scale. */
  lineKeys?: string[];
  /** Pie: render as a donut (inner radius) instead of a full pie. */
  donut?: boolean;
  /** Pivot: the column-dimension (a second category column); rows use `xKey`. */
  columnKey?: string;
  /** Per-series color overrides (column → CSS color); else the fixed palette order. */
  colors?: Record<string, string>;
  /** Per-series display-name overrides (column → label) for legend/tooltip. */
  seriesLabels?: Record<string, string>;
  /** Draw value labels on marks (bar/line/area/combo). */
  dataLabels?: boolean;
  /** Horizontal reference line on cartesian charts (goal/threshold). */
  refLineValue?: number;
  refLineLabel?: string;
  /** Y-axis domain overrides (linear scale only; omitted → auto). */
  yMin?: number;
  yMax?: number;
  /** Legend placement; "none" hides it (single-series charts need no legend). */
  legend?: "top" | "bottom" | "right" | "none";
  /** Axis titles. */
  xTitle?: string;
  yTitle?: string;
  /** Y scale (default linear). */
  yScale?: "linear" | "log";
  /** Value number formatting. */
  numberFormat?: NumberFormat;
  /** Conditional formatting (tables + KPI). */
  conditional?: ConditionalRule[];
  /** KPI/gauge goal target (drives a progress/delta indicator or gauge marker). */
  goal?: number;
  /** KPI: show a trend delta vs. the previous row/point. */
  showTrend?: boolean;
  /** Gauge lower bound (default 0). */
  gaugeMin?: number;
  /** Gauge upper bound (default: a nice-rounded value above the datum). */
  gaugeMax?: number;
  /** Geo map: which basemap to draw. */
  mapScope?: "world" | "us";
  /** Geo map: the column holding the region name (country / US state). */
  regionKey?: string;
}

/**
 * Which engine path a definition runs through.
 * - `builder` → the legacy single-agg `Query` (Rust engine).
 * - `ir`      → the advanced `QueryIR`, compiled to SQL (DuckDB or pushdown).
 * - `sql`     → a raw SQL string.
 */
export type QueryKind = "builder" | "ir" | "sql";

/** Where an IR/SQL query executes. */
export type ExecutionMode = "local" | "pushdown";

/**
 * The reusable query core shared by dashboard widgets and saved queries.
 *
 * `query` is present when `queryKind === "builder"`; `ir` when
 * `queryKind === "ir"`; `sql` when `queryKind === "sql"`. `viz` records how to
 * render the result so opening a saved query (or dropping it on a dashboard)
 * restores the same visualization.
 */
export interface QueryDefinition {
  /** DatasetId in the keyed registry (== a data source id). */
  sourceId: string;
  queryKind: QueryKind;
  /** Present when `queryKind === "builder"` (legacy Rust fast-path shape). */
  query?: Query;
  /** Present when `queryKind === "ir"` (advanced builder). */
  ir?: QueryIR;
  /** Present when `queryKind === "sql"`. */
  sql?: string;
  /** Preferred execution mode for `ir`/`sql` (auto-chosen if omitted). */
  execution?: ExecutionMode;
  viz: WidgetViz;
}

/**
 * Current on-disk schema version for a persisted `SavedQuery`. Written on every
 * save so a migration can detect and upgrade older records.
 *
 * v1 → v2: builder definitions gain a derived `ir` (see `queryV1ToIR`). The
 * upgrade is lazy + non-destructive — `query` is kept so the Rust fast-path
 * still fires.
 */
export const SAVED_QUERY_SCHEMA_VERSION = 2;

/**
 * A named, persisted query. `QueryDefinition` carries everything needed to
 * re-execute + restore it; the rest is identity + metadata. Timestamps are ISO
 * strings so records sort and round-trip through JSON without a `Date` instance.
 */
export interface SavedQuery extends QueryDefinition {
  id: string;
  name: string;
  description?: string;
  /** Bumped by a migration; equals SAVED_QUERY_SCHEMA_VERSION on every write. */
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}
