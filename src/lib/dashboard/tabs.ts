/**
 * Page-view tab helpers.
 *
 * Tabs partition a grid dashboard into pages. Membership is by `tabId`, with one
 * rule everywhere: an item with no `tabId` belongs to the FIRST tab (so a
 * pre-tabs dashboard's widgets all land on tab 1 the moment tabs appear, with no
 * migration/backfill). When a dashboard has no tabs it's a single page and every
 * item shows. Canvas mode ignores tabs entirely.
 */

import type { DashboardTab } from "@/lib/types/dashboard";
import { nextWidgetId } from "./layout";

/** A fresh tab id (distinct prefix so it never collides with a widget/element). */
export function nextTabId(): string {
  return nextWidgetId("tab");
}

/**
 * The tab an item is on: its own `tabId`, or the first tab when it has none.
 * Undefined when the dashboard has no tabs.
 */
export function itemTabId(
  item: { tabId?: string },
  tabs: DashboardTab[] | undefined,
): string | undefined {
  if (!tabs || tabs.length === 0) return undefined;
  return item.tabId ?? tabs[0].id;
}

/**
 * Items shown on `activeTabId`. With no tabs (or no active tab) everything shows
 * — the single-page case is a pass-through.
 */
export function itemsOnTab<T extends { tabId?: string }>(
  items: T[],
  tabs: DashboardTab[] | undefined,
  activeTabId: string | null,
): T[] {
  if (!tabs || tabs.length === 0 || !activeTabId) return items;
  return items.filter((it) => (it.tabId ?? tabs[0].id) === activeTabId);
}

/** Resolve the effective active tab: the chosen one if valid, else the first. */
export function resolveActiveTab(
  tabs: DashboardTab[] | undefined,
  chosen: string | null,
): string | null {
  if (!tabs || tabs.length === 0) return null;
  if (chosen && tabs.some((t) => t.id === chosen)) return chosen;
  return tabs[0].id;
}
