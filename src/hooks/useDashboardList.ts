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
import type { Dashboard } from "@/lib/types/dashboard";
import { getDashboardStore } from "@/lib/dashboard/store";

export type DashboardSummary = Pick<Dashboard, "id" | "name" | "updatedAt">;

export interface DashboardListApi {
  list: DashboardSummary[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  select: (id: string) => void;
  create: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Re-fetch summaries (e.g. after renaming the active dashboard). */
  refresh: () => Promise<void>;
}

export function useDashboardList(): DashboardListApi {
  const store = React.useMemo(() => getDashboardStore(), []);
  const [list, setList] = React.useState<DashboardSummary[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
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
          items = [{ id: created.id, name: created.name, updatedAt: created.updatedAt }];
        }
        if (cancelled) return;
        setList(items);
        setActiveId((cur) => cur ?? items[0]?.id ?? null);
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

  const select = React.useCallback((id: string) => setActiveId(id), []);

  const create = React.useCallback(async () => {
    const created = await store.create("Untitled dashboard");
    await refresh();
    setActiveId(created.id);
  }, [store, refresh]);

  const remove = React.useCallback(
    async (id: string) => {
      await store.remove(id);
      let items = await store.list();
      // Never leave the org with zero dashboards.
      if (items.length === 0) {
        const created = await store.create("My dashboard");
        items = [{ id: created.id, name: created.name, updatedAt: created.updatedAt }];
      }
      setList(items);
      setActiveId((cur) => (cur === id ? items[0]?.id ?? null : cur));
    },
    [store],
  );

  return { list, activeId, loading, error, select, create, remove, refresh };
}
