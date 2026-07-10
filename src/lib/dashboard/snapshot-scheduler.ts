"use client";

/**
 * SnapshotScheduler — a read-only `QueryScheduler` over a frozen result map.
 *
 * The public page has no compute engine; it renders a `DashboardSnapshot`. This
 * satisfies the same `QueryScheduler` interface the widgets already depend on,
 * so `DashboardView`/`DashboardWidget` render unchanged — `submit` is a no-op and
 * `getSnapshot` just serves the widget's frozen `ResultTable` by id.
 */

import type { ResultTable } from "@/lib/types/results";
import type { QueryScheduler, WidgetResult } from "@/hooks/useQueryScheduler";

const IDLE: WidgetResult = { status: "idle", table: null, payload: null, error: null };

export function createSnapshotScheduler(
  results: Record<string, ResultTable>,
): QueryScheduler {
  // Precompute ONE stable WidgetResult per widget. `getSnapshot` must return a
  // referentially-stable value for unchanged state — building a fresh object per
  // call makes `useSyncExternalStore` re-render forever ("Maximum update depth").
  const snapshots = new Map<string, WidgetResult>();
  for (const [widgetId, table] of Object.entries(results)) {
    snapshots.set(widgetId, {
      status: table.rows.length === 0 ? "empty" : "data",
      table,
      payload: null,
      error: null,
      elapsedMs: table.elapsedMs,
    });
  }

  return {
    submit() {
      /* no-op: results are already frozen */
    },
    forget() {
      /* no-op */
    },
    invalidateSource() {
      /* no-op */
    },
    subscribe() {
      // Results never change, so nothing ever notifies — return an unsubscribe.
      return () => {};
    },
    getSnapshot: (widgetId) => snapshots.get(widgetId) ?? IDLE,
  };
}
