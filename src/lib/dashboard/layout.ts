/**
 * Grid-layout math shared by the dashboard hook and the "add to dashboard"
 * quick-action, plus the client-only id generator.
 *
 * These were private to `useDashboard`; extracting them lets a saved query be
 * dropped onto a dashboard's next free slot with the SAME placement rules the
 * hook uses, without duplicating the geometry.
 */

import type { Widget, WidgetLayout, WidgetViz } from "@/lib/types/dashboard";

/** Grid width in columns (matches the grid's `lg` breakpoint). */
export const GRID_COLS = 12;

/** Sensible default size (in grid units) for a freshly-added widget by viz. */
export function defaultSize(viz: WidgetViz["type"]): { w: number; h: number } {
  switch (viz) {
    case "kpi":
      return { w: 3, h: 4 };
    case "table":
      return { w: 6, h: 8 };
    default:
      return { w: 6, h: 7 }; // bar / line
  }
}

/** Place a new widget on a fresh row below everything else. */
export function nextSlot(
  widgets: Widget[],
  size: { w: number; h: number },
): WidgetLayout {
  const bottom = widgets.reduce(
    (max, w) => Math.max(max, w.layout.y + w.layout.h),
    0,
  );
  return { x: 0, y: bottom, w: size.w, h: size.h };
}

/**
 * Collision-free widget id. A module counter would reset on reload and clash
 * with ids already persisted in the saved dashboard, so we use the same
 * `crypto.randomUUID()` the data-source layer relies on (client-only).
 */
export function nextWidgetId(prefix = "w"): string {
  const uuid =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Math.floor(performance.now())}-${Math.round(performance.now() * 1000) % 1000}`;
  return `${prefix}_${uuid}`;
}
