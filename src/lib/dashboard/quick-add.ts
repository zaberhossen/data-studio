/**
 * "Add to dashboard" — turn a `QueryDefinition` into a `Widget` and drop it into
 * a dashboard's next free slot.
 *
 * Cheap now that `Widget = QueryDefinition + { id, title, layout }`: the whole
 * definition (source + query/sql + viz) transfers verbatim; we only mint an id,
 * a title, and a grid box. It goes straight through the pluggable
 * `DashboardStore`, so it works whether or not the dashboard panel is mounted
 * (only one panel mounts at a time — `useDashboard` reloads from the store when
 * the user next opens it, so there's no stale-state race).
 */

import type { QueryDefinition } from "@/lib/types/query";
import type { Dashboard, Widget } from "@/lib/types/dashboard";
import { defaultSize, nextSlot, nextWidgetId } from "@/lib/dashboard/layout";
import { getDashboardStore } from "@/lib/dashboard/store";

/**
 * Append a widget built from `def` (titled `title`) to the org's most-recent
 * dashboard, creating a first dashboard if none exist yet. Resolves with the
 * saved dashboard so the caller can report the widget count / navigate.
 */
export async function addDefinitionToDashboard(
  title: string,
  def: QueryDefinition,
): Promise<Dashboard> {
  const store = getDashboardStore();
  const summaries = await store.list();
  // `list()` is most-recent-first; fall back to a fresh dashboard when empty.
  const target =
    (summaries[0] && (await store.get(summaries[0].id))) ||
    (await store.create("My dashboard"));
  const widget: Widget = {
    ...def,
    id: nextWidgetId(),
    title,
    layout: nextSlot(target.widgets, defaultSize(def.viz.type)),
  };
  return store.save({ ...target, widgets: [...target.widgets, widget] });
}
