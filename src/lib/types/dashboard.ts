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
  /**
   * Persisted group membership: items sharing a `groupId` select and move as one
   * (Figma-style groups). Minted by "Group" (⌘G); cleared by "Ungroup" (⌘⇧G).
   * Frames are never grouped.
   */
  groupId?: string;
  /** Layers panel: excluded from marquee/drag/resize (still selectable there). */
  locked?: boolean;
  /** Layers panel: not rendered on the stage (a query widget also won't run). */
  hidden?: boolean;
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
  /** Render `text` as Markdown (headings/lists/links/bold/italic/code). */
  markdown?: boolean;
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
  /** Stroke width in px (default 2 when a stroke color is set). */
  strokeWidth?: number;
  /** Corner radius in px (rectangles only). */
  radius?: number;
  /** Fill/stroke opacity, 0–1 (default 1). */
  opacity?: number;
  /** Drop shadow. */
  shadow?: boolean;
}

/** Line dash style. */
export type LineDash = "solid" | "dashed" | "dotted";

/** Straight line / divider element (Pass B). */
export interface LineContent {
  kind: "line";
  stroke?: string;
  strokeWidth?: number;
  /** Dash pattern (default solid). */
  dash?: LineDash;
  /** Arrowhead at the start / end of the line. */
  startArrow?: boolean;
  endArrow?: boolean;
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
  /** Which Page-view tab this element lives on (undefined → the first tab). */
  tabId?: string;
  /**
   * Grid placement — present when the element also lives on the PAGE (grid)
   * layout. Only text cards render in grid mode (Metabase-style text/heading
   * cards); other kinds stay canvas-only. Coexists with `canvasLayout` so the
   * Page ⇄ Canvas convert is lossless, mirroring `Widget.layout`.
   */
  layout?: WidgetLayout;
  content: ElementContent;
}

/**
 * What clicking a chart datum / table cell on this widget does. Omitted ⇒
 * `cross-filter` (the default drill interaction). `url` templates `{{value}}`
 * and `{{column}}` from the clicked point; `dashboard` navigates to another
 * dashboard, optionally seeding one of its filters with the clicked value.
 */
export type WidgetClickAction =
  | { type: "cross-filter" }
  | { type: "url"; url: string; newTab?: boolean }
  | { type: "dashboard"; dashboardId: string; filterId?: string };

export interface Widget extends QueryDefinition {
  id: string;
  title: string;
  layout: WidgetLayout;
  /** Free-form placement (canvas mode). Derived from `layout` on first switch. */
  canvasLayout?: CanvasLayout;
  /** Always a query widget here; the field is explicit for the persisted row. */
  kind?: "query";
  /** Which Page-view tab this widget lives on (undefined → the first tab). */
  tabId?: string;
  /** Click-through behavior for a data point (default: cross-filter). */
  clickBehavior?: WidgetClickAction;
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
  /**
   * Must hold a value: the filter bar won't let it be cleared and flags it when
   * empty. (A `default` is the usual companion so it's never empty on load.)
   */
  required?: boolean;
  /**
   * Author-fixed: the value is pinned to `default` and can't be changed in the
   * filter bar (read-only), nor overridden via the URL. Useful for scoping a
   * shared/embedded dashboard.
   */
  locked?: boolean;
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

/**
 * A named artboard on the free-form canvas (Figma-style "frame"). Frames are
 * presentation pages: a bordered region with its own background that items sit
 * on. Membership is DERIVED by geometry (an item whose center lies inside the
 * frame moves with it) — nothing references a frame id, so dragging an item
 * out of a frame needs no bookkeeping.
 */
export interface CanvasFrame {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** CSS color; defaults to the card surface. */
  background?: string;
  /** Layers panel: excluded from marquee/drag/resize. */
  locked?: boolean;
  /** Layers panel: not rendered on the stage. */
  hidden?: boolean;
}

/** The free-form canvas surface geometry (logical px). */
export interface CanvasConfig {
  width: number;
  height: number;
  background?: string;
  /** Artboards (canvas dashboards only). Lives inside the `canvas` jsonb. */
  frames?: CanvasFrame[];
  /** Alignment-grid spacing in logical px (default `DEFAULT_GRID_SIZE`). */
  gridSize?: number;
  /** Paint the alignment grid overlay on the stage (edit mode only). */
  showGrid?: boolean;
  /** Snap drag/resize to the alignment grid. */
  snapToGrid?: boolean;
  /** Show measurement rulers along the viewport's top/left edges (edit mode). */
  showRulers?: boolean;
}

/** Default alignment-grid spacing (px) when a canvas enables the grid. */
export const DEFAULT_GRID_SIZE = 8;

export const DEFAULT_CANVAS: CanvasConfig = { width: 1200, height: 800 };

/**
 * A Page-view tab (Metabase-style). Tabs partition a grid dashboard into
 * separate pages; a widget/element's `tabId` places it on one. When a dashboard
 * has no tabs it's a single implicit page (the common case). Canvas mode ignores
 * tabs — it's one free-form surface.
 */
export interface DashboardTab {
  id: string;
  name: string;
}

export interface Dashboard {
  id: string;
  name: string;
  widgets: Widget[];
  /** Page-view tabs. Absent/empty → a single untabbed page. */
  tabs?: DashboardTab[];
  /** Non-query canvas decorations (text/image/shape/line). Canvas mode only. */
  elements?: CanvasElement[];
  /** Grid (default) or free-form canvas. */
  layoutMode?: LayoutMode;
  /** Canvas surface geometry (present once a dashboard uses canvas mode). */
  canvas?: CanvasConfig;
  /** Filter DEFINITIONS (persisted). Active values live in ActiveFilters. */
  filters?: DashboardFilter[];
  updatedAt?: number;
  /**
   * Optimistic-lock counter (server-assigned). The client echoes it on save; the
   * server rejects the write (409) if the stored version has advanced meanwhile.
   */
  version?: number;
}

export function emptyDashboard(
  id: string,
  name = "Untitled dashboard",
  layoutMode: LayoutMode = "grid",
): Dashboard {
  return {
    id,
    name,
    widgets: [],
    elements: [],
    filters: [],
    layoutMode,
    // A canvas ("free-form") dashboard needs its surface geometry from birth.
    ...(layoutMode === "canvas" ? { canvas: DEFAULT_CANVAS } : {}),
  };
}
