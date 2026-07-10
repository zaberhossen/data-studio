"use client";

/**
 * Client-side snapshot capture for sharing.
 *
 * A share link freezes the dashboard's currently-computed widget results so a
 * public viewer renders static data (see `types/share.ts` for the security
 * rationale). `buildSnapshot` waits for every widget to reach a terminal result
 * in the scheduler, then projects a secret-free shell + collects each result
 * page. This runs in the authed browser, which already holds every widget's
 * rows — so it works uniformly for CSV/demo AND live-DB sources.
 */

import type { Dashboard } from "@/lib/types/dashboard";
import type { DashboardSnapshot, PublicDashboard } from "@/lib/types/share";
import type { QueryScheduler } from "@/hooks/useQueryScheduler";

/** Project a dashboard to its secret-free public shell (no source/query detail). */
export function projectPublicDashboard(d: Dashboard): PublicDashboard {
  return {
    name: d.name,
    layoutMode: d.layoutMode,
    canvas: d.canvas,
    widgets: d.widgets.map((w) => ({
      id: w.id,
      title: w.title,
      viz: w.viz,
      queryKind: w.queryKind,
      layout: w.layout,
      canvasLayout: w.canvasLayout,
      kind: "query" as const,
    })),
    elements: d.elements,
  };
}

/**
 * Resolve once every widget has a terminal result (data/empty/error) in the
 * scheduler, or the timeout fires. Submits each widget to ensure it runs.
 */
export function waitForResults(
  scheduler: QueryScheduler,
  widgetIds: string[],
  timeoutMs = 12_000,
): Promise<void> {
  return new Promise((resolve) => {
    const pending = new Set(widgetIds);
    const unsubs: Array<() => void> = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      unsubs.forEach((u) => u());
      clearTimeout(timer);
      resolve();
    };

    const check = (id: string) => {
      const s = scheduler.getSnapshot(id).status;
      if (s === "data" || s === "empty" || s === "error") pending.delete(id);
      if (pending.size === 0) finish();
    };

    const timer = setTimeout(finish, timeoutMs);

    for (const id of widgetIds) {
      unsubs.push(scheduler.subscribe(id, () => check(id)));
    }
    // Kick everything, then check for already-cached results.
    for (const id of widgetIds) check(id);
    if (pending.size === 0) finish();
  });
}

/**
 * Build a frozen snapshot of `dashboard` from the scheduler's current results.
 * Widgets without a result page (e.g. an errored query) are simply omitted.
 */
export async function buildSnapshot(
  dashboard: Dashboard,
  scheduler: QueryScheduler,
  timeoutMs = 12_000,
): Promise<DashboardSnapshot> {
  const ids = dashboard.widgets.map((w) => w.id);
  await waitForResults(scheduler, ids, timeoutMs);

  const results: DashboardSnapshot["results"] = {};
  for (const id of ids) {
    const table = scheduler.getSnapshot(id).table;
    if (table) results[id] = table;
  }

  return {
    dashboard: projectPublicDashboard(dashboard),
    results,
    createdAt: new Date().toISOString(),
  };
}
