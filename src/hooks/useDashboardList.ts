"use client";

/**
 * useDashboardList — owns the COLLECTION of dashboards (the picker), separate
 * from `useDashboard` which owns the one active dashboard's editable state.
 *
 * On mount it lists the org's dashboards; if there are none it creates a first
 * one so the panel always has something to show. It tracks the active id and
 * exposes create / delete / refresh. Persistence goes through the same pluggable
 * `DashboardStore` (API-backed from M6), so this is backend-agnostic.
 */

import * as React from "react";
import type { Dashboard, LayoutMode } from "@/lib/types/dashboard";
import { getDashboardStore } from "@/lib/dashboard/store";
import { nextWidgetId } from "@/lib/dashboard/layout";
import { nextElementId } from "@/lib/dashboard/canvas";

export type DashboardSummary = Pick<Dashboard, "id" | "name" | "updatedAt" | "layoutMode">;

export interface DashboardListApi {
  list: DashboardSummary[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  select: (id: string) => void;
  /** Create a dashboard of the chosen type (Page = "grid", Canvas = "canvas"). */
  create: (input?: { name?: string; layoutMode?: LayoutMode }) => Promise<void>;
  /** Deep-copy a dashboard (widgets/elements get fresh ids; filters remapped). */
  duplicate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Re-fetch summaries (e.g. after renaming the active dashboard). */
  refresh: () => Promise<void>;
}

/** The dashboard id requested in the URL (`?d=<id>`), or null. */
function dashboardIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("d");
}

/** Reflect the active dashboard id into the URL (`?d=`), preserving other params. */
function writeDashboardIdToUrl(id: string): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("d") === id) return;
  params.set("d", id);
  const { pathname, hash } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}?${params.toString()}${hash}`);
}

export function useDashboardList(): DashboardListApi {
  const store = React.useMemo(() => getDashboardStore(), []);
  const [list, setList] = React.useState<DashboardSummary[]>([]);
  // Seed the active dashboard from `?d=<id>` so go-to-dashboard links + reloads
  // land on the right one (validated against the loaded list below).
  const [activeId, setActiveId] = React.useState<string | null>(() => dashboardIdFromUrl());
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const items = await store.list();
    setList(items);
  }, [store]);

  // Initial load: list, seeding a first dashboard if the org has none.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        let items = await store.list();
        if (items.length === 0) {
          const created = await store.create("My dashboard");
          items = [
            {
              id: created.id,
              name: created.name,
              updatedAt: created.updatedAt,
              layoutMode: created.layoutMode,
            },
          ];
        }
        if (cancelled) return;
        setList(items);
        // Keep a valid current/URL-seeded selection; else fall back to the first.
        setActiveId((cur) =>
          cur && items.some((i) => i.id === cur) ? cur : items[0]?.id ?? null,
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load dashboards.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  const select = React.useCallback((id: string) => {
    setActiveId(id);
    writeDashboardIdToUrl(id);
  }, []);

  const create = React.useCallback<DashboardListApi["create"]>(
    async (input) => {
      const created = await store.create(
        input?.name?.trim() || "Untitled dashboard",
        input?.layoutMode ?? "grid",
      );
      await refresh();
      setActiveId(created.id);
    },
    [store, refresh],
  );

  const duplicate = React.useCallback(
    async (id: string) => {
      const src = await store.get(id);
      if (!src) return;
      const created = await store.create(`${src.name} (copy)`, src.layoutMode ?? "grid");
      // Widget/element ids are GLOBALLY unique (widgets.id is the table PK), so
      // the copy mints fresh ids and remaps filter targets onto them.
      const widgetIdMap = new Map(src.widgets.map((w) => [w.id, nextWidgetId()]));
      const copy: Dashboard = {
        ...src,
        id: created.id,
        name: created.name,
        widgets: src.widgets.map((w) => ({ ...w, id: widgetIdMap.get(w.id)! })),
        elements: (src.elements ?? []).map((e) => ({ ...e, id: nextElementId() })),
        filters: (src.filters ?? []).map((f) => ({
          ...f,
          targets: f.targets
            .filter((t) => widgetIdMap.has(t.widgetId))
            .map((t) => ({ ...t, widgetId: widgetIdMap.get(t.widgetId)! })),
        })),
      };
      await store.save(copy);
      await refresh();
      setActiveId(created.id);
    },
    [store, refresh],
  );

  const remove = React.useCallback(
    async (id: string) => {
      await store.remove(id);
      let items = await store.list();
      // Never leave the org with zero dashboards.
      if (items.length === 0) {
        const created = await store.create("My dashboard");
        items = [
          {
            id: created.id,
            name: created.name,
            updatedAt: created.updatedAt,
            layoutMode: created.layoutMode,
          },
        ];
      }
      setList(items);
      setActiveId((cur) => (cur === id ? items[0]?.id ?? null : cur));
    },
    [store],
  );

  return { list, activeId, loading, error, select, create, duplicate, remove, refresh };
}
