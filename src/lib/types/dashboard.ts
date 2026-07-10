/**
 * Dashboard data models — SERIALIZABLE by construction.
 *
 * The golden rule of this whole system holds here too: a persisted dashboard
 * stores QUERIES, never data. A `Widget` carries the declarative `Query` (or a
 * SQL string) plus its visualization + grid placement; the rows it renders are
 * fetched on demand through the scheduler and live only in the workers. Nothing
 * in this file may ever hold a `Row`, a `ChartPayload`, or a `SqlResult`.
 *
 * These types are the contract for the pluggable store (`@/lib/dashboard/store`)
 * and the grid/widget components. Because they're plain data (no functions, no
 * class instances), a dashboard round-trips cleanly through `JSON.stringify`.
 */

import type { QueryDefinition, QueryKind } from "@/lib/types/query";

export type { WidgetViz, WidgetVizType } from "@/lib/types/query";

export type WidgetQueryKind = QueryKind;

export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── Canvas (free-form) layout model ────────────────────────────────────────────

/** Grid (responsive) or canvas (free-form) placement, toggled per dashboard. */
export type LayoutMode = "grid" | "canvas";

/**
 * Absolute placement on the free-form canvas, in PIXELS (unlike `WidgetLayout`,
 * which is in grid columns/rows). Both persist side-by-side so switching modes
 * is lossless; `canvasLayout` is derived from the grid box the first time a
 * dashboard is switched to canvas.
 */
export interface CanvasLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex?: number;
  /** Rotation in degrees (clockwise). */
  rotation?: number;
}

/** Non-query decoration elements live alongside query widgets on the canvas. */
export type WidgetKind = "query" | "text" | "image" | "shape" | "line";

/** A free-text label element (the only decoration kind in M8 Pass A). */
export interface TextContent {
  kind: "text";
  text: string;
  fontSize?: number;
  align?: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
  /** CSS color (an ink token by default). */
  color?: string;
}

/** Image element (URL-referenced; arrives in Pass B). */
export interface ImageContent {
  kind: "image";
  url: string;
  fit?: "contain" | "cover";
}

/** Rectangle / ellipse element (Pass B). */
export interface ShapeContent {
  kind: "shape";
  shape: "rect" | "ellipse";
  fill?: string;
  stroke?: string;
}

/** Straight line / divider element (Pass B). */
export interface LineContent {
  kind: "line";
  stroke?: string;
  strokeWidth?: number;
}

export type ElementContent = TextContent | ImageContent | ShapeContent | LineContent;

/**
 * A non-query canvas element. Unlike a `Widget` it carries no query/viz — only a
 * `content` payload + its canvas placement. Elements exist ONLY in canvas mode
 * (grid mode shows just query widgets).
 */
export interface CanvasElement {
  id: string;
  kind: Exclude<WidgetKind, "query">;
  canvasLayout: CanvasLayout;
  content: ElementContent;
}

export interface Widget extends QueryDefinition {
  id: string;
  title: string;
  layout: WidgetLayout;
  /** Free-form placement (canvas mode). Derived from `layout` on first switch. */
  canvasLayout?: CanvasLayout;
  /** Always a query widget here; the field is explicit for the persisted row. */
  kind?: "query";
}

// ── Filter model ─────────────────────────────────────────────────────────────

export type FilterKind =
  | "date-range"
  | "select"
  | "multi-select"
  | "number-range"
  | "text";

/** Mirrors the engine Operator set; all are valid for dashboard filters. */
export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "in_list";

/**
 * A filter value in its runtime form.
 *
 * - scalar (string|number|boolean): select, text, single number
 * - string[2]: date-range  [isoStart, isoEnd]
 * - number[2]: number-range [min, max]
 * - string[] / number[]: multi-select items
 */
export type FilterValue =
  | string
  | number
  | boolean
  | string[]
  | number[];

/** Per-widget column mapping inside a filter definition. */
export interface FilterTarget {
  widgetId: string;
  column: string;
}

/**
 * A dashboard-level filter definition (PERSISTED inside `Dashboard.filters`).
 *
 * Defines ONE control in the filter bar. `targets` maps each applicable widget
 * to the column that control filters on. The active VALUE is ephemeral runtime
 * state (ActiveFilters) and is never stored here.
 */
export interface DashboardFilter {
  id: string;
  label: string;
  kind: FilterKind;
  /** Explicit per-widget column mappings. Only widgets listed here are affected. */
  targets: FilterTarget[];
  /** Operator override; defaults per kind if omitted. */
  op?: FilterOperator;
  /** Optional default value shown before user interaction. */
  default?: FilterValue;
}

/**
 * Runtime ephemeral map of active filter values (filterId → value).
 * Never persisted; not part of Dashboard.
 */
export type ActiveFilters = Record<string, FilterValue>;

/**
 * A cross-filter emitted by clicking a chart datum.
 * Ephemeral runtime state; not persisted.
 */
export interface CrossFilter {
  id: string;
  column: string;
  value: FilterValue;
  /** The widget that emitted this cross-filter is EXCLUDED from it. */
  sourceWidgetId: string;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

/** The free-form canvas surface geometry (logical px). */
export interface CanvasConfig {
  width: number;
  height: number;
  background?: string;
}

export const DEFAULT_CANVAS: CanvasConfig = { width: 1200, height: 800 };

export interface Dashboard {
  id: string;
  name: string;
  widgets: Widget[];
  /** Non-query canvas decorations (text/image/shape/line). Canvas mode only. */
  elements?: CanvasElement[];
  /** Grid (default) or free-form canvas. */
  layoutMode?: LayoutMode;
  /** Canvas surface geometry (present once a dashboard uses canvas mode). */
  canvas?: CanvasConfig;
  /** Filter DEFINITIONS (persisted). Active values live in ActiveFilters. */
  filters?: DashboardFilter[];
  updatedAt?: number;
}

export function emptyDashboard(id: string, name = "Untitled dashboard"): Dashboard {
  return { id, name, widgets: [], elements: [], filters: [], layoutMode: "grid" };
}
