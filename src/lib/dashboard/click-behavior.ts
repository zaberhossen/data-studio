/**
 * Per-widget click behavior — turns a clicked data point (column + value) into a
 * concrete action: emit a cross-filter, open a templated URL, or navigate to
 * another dashboard (seeding one of its filters with the clicked value).
 *
 * Pure functions over the widget's `clickBehavior` config so the dispatch is
 * unit-testable; the widget component performs the actual navigation/emit.
 */

import type { WidgetClickAction } from "@/lib/types/dashboard";

/** The clicked datum a behavior acts on. */
export interface ClickPoint {
  column: string;
  value: string | number;
}

/** The resolved thing to do — the widget executes it (emit / open / navigate). */
export type ResolvedClick =
  | { kind: "cross-filter"; column: string; value: string | number }
  | { kind: "open-url"; url: string; newTab: boolean }
  | { kind: "navigate"; href: string };

/**
 * Substitute `{{value}}` and `{{column}}` (URL-encoded) in a custom URL.
 * Unknown placeholders are left intact. Also supports the unbraced-safe forms
 * `{{ value }}` with surrounding spaces.
 */
export function templateUrl(url: string, point: ClickPoint): string {
  return url.replace(/\{\{\s*(value|column)\s*\}\}/g, (_m, key: string) =>
    encodeURIComponent(String(key === "value" ? point.value : point.column)),
  );
}

/**
 * Build the href to another dashboard: `/dashboards?d=<id>` plus, when a
 * `filterId` is given, `&f.<filterId>=<json>` so the target seeds that filter
 * from the URL (see `filter-url.ts` / DashboardFilterProvider urlSync).
 */
export function dashboardHref(
  dashboardId: string,
  filterId: string | undefined,
  value: string | number,
): string {
  const params = new URLSearchParams();
  params.set("d", dashboardId);
  if (filterId) params.set(`f.${filterId}`, JSON.stringify(value));
  return `/dashboards?${params.toString()}`;
}

/**
 * Resolve a widget's click into an action. Returns null when there's nothing to
 * do (e.g. a URL/dashboard behavior that isn't configured yet) — the caller
 * then does nothing rather than falling back to a cross-filter.
 */
export function resolveClick(
  behavior: WidgetClickAction | undefined,
  point: ClickPoint,
): ResolvedClick | null {
  if (!behavior || behavior.type === "cross-filter") {
    return { kind: "cross-filter", column: point.column, value: point.value };
  }
  if (behavior.type === "url") {
    const url = behavior.url.trim();
    if (!url) return null;
    return { kind: "open-url", url: templateUrl(url, point), newTab: behavior.newTab !== false };
  }
  // dashboard
  if (!behavior.dashboardId) return null;
  return { kind: "navigate", href: dashboardHref(behavior.dashboardId, behavior.filterId, point.value) };
}
