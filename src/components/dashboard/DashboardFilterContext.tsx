"use client";

/**
 * DashboardFilterContext — ephemeral filter runtime state for a dashboard.
 *
 * Manages two independent filter axes:
 *   1. Dashboard filters: user-defined controls in the filter bar (ActiveFilters).
 *   2. Cross-filters: transient filters emitted by clicking chart data points.
 *
 * The context exposes two views of active filter values:
 *   - `activeFilters`:   updated immediately (drives the filter bar UI).
 *   - `debouncedFilters`: debounced 300 ms (used to compute effective queries;
 *                         prevents a re-run storm on range sliders / typing).
 *
 * Filter DEFINITIONS live in the Dashboard model (persisted). This context
 * holds only the runtime VALUES and cross-filter events — never persisted.
 */

import * as React from "react";
import type {
  ActiveFilters,
  CrossFilter,
  DashboardFilter,
  FilterValue,
} from "@/lib/types/dashboard";
import { filtersFromSearch, searchWithFilters } from "@/lib/dashboard/filter-url";

// ── Context shape ─────────────────────────────────────────────────────────────

export interface DashboardFilterContextValue {
  /** Persisted filter definitions from the Dashboard model. */
  filterDefs: DashboardFilter[];

  /** Immediate (non-debounced) active values — drives filter bar UI. */
  activeFilters: ActiveFilters;
  /**
   * Debounced (300 ms) active values — drives effective query computation.
   * Widgets read this, not `activeFilters`, to avoid re-run storms.
   */
  debouncedFilters: ActiveFilters;

  /** Transient cross-filter events from chart clicks. */
  crossFilters: CrossFilter[];

  /**
   * Set (or clear) a dashboard-filter value.
   * Pass `undefined` to deactivate the filter.
   * `immediate` skips the debounce (for selects; range/text use the delay).
   */
  setFilter: (filterId: string, value: FilterValue | undefined, immediate?: boolean) => void;

  /** Deactivate a single dashboard filter. */
  clearFilter: (filterId: string) => void;

  /** Deactivate all dashboard filters at once. */
  clearAllFilters: () => void;

  /**
   * Emit a cross-filter from a chart data point click.
   * `sourceWidgetId` is excluded from the cross-filter by the loop guard.
   */
  onCrossFilter: (sourceWidgetId: string, column: string, value: FilterValue) => void;

  /** Remove one cross-filter by id. */
  removeCrossFilter: (id: string) => void;

  /** Clear every active cross-filter. */
  clearAllCrossFilters: () => void;

  /** True if any filter (dashboard or cross) is currently active. */
  hasActiveFilters: boolean;
}

const DashboardFilterContext =
  React.createContext<DashboardFilterContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

let crossFilterSeq = 0;

interface DashboardFilterProviderProps {
  filterDefs: DashboardFilter[];
  /**
   * Mirror active filter values into the page URL (`?f.<id>=…`) so a filtered
   * view is shareable/bookmarkable, and seed initial values from the URL.
   * Locked filters are never URL-driven (author-pinned). Off for public/embed.
   */
  urlSync?: boolean;
  children: React.ReactNode;
}

/**
 * The initial active values: each definition's persisted `default`, then (when
 * `urlSync`) overridden by any `f.<id>` URL param — except LOCKED filters, which
 * are pinned to their default and ignore the URL.
 */
function initialActive(filterDefs: DashboardFilter[], urlSync: boolean): ActiveFilters {
  const seed: ActiveFilters = {};
  for (const def of filterDefs) {
    if (def.default !== undefined) seed[def.id] = def.default;
  }
  if (urlSync && typeof window !== "undefined") {
    const fromUrl = filtersFromSearch(window.location.search);
    const byId = new Map(filterDefs.map((d) => [d.id, d]));
    for (const [id, value] of Object.entries(fromUrl)) {
      const def = byId.get(id);
      if (def && !def.locked) seed[id] = value;
    }
  }
  return seed;
}

export function DashboardFilterProvider({
  filterDefs,
  urlSync = false,
  children,
}: DashboardFilterProviderProps) {
  // Ids whose values are author-pinned — never written to the URL.
  const lockedIds = React.useMemo(
    () => new Set(filterDefs.filter((d) => d.locked).map((d) => d.id)),
    [filterDefs],
  );

  // Defaults (+ URL overrides) are applied ONCE, at mount — the provider is keyed
  // by dashboard id (see DashboardPanel), so switching dashboards remounts with
  // fresh defaults and never leaks another dashboard's active values.
  const [activeFilters, setActiveFilters] = React.useState<ActiveFilters>(() =>
    initialActive(filterDefs, urlSync),
  );
  const [debouncedFilters, setDebouncedFilters] = React.useState<ActiveFilters>(
    () => activeFilters,
  );
  const [crossFilters, setCrossFilters] = React.useState<CrossFilter[]>([]);

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flush the debounced filters to match a new active state.
  const applyDebounced = React.useCallback(
    (next: ActiveFilters, immediate: boolean) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (immediate) {
        setDebouncedFilters(next);
      } else {
        debounceRef.current = setTimeout(() => setDebouncedFilters(next), 300);
      }
    },
    [],
  );

  React.useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Mirror active values into the URL (replaceState — no history spam). Locked
  // filters are excluded (author-pinned, not shareable state).
  React.useEffect(() => {
    if (!urlSync || typeof window === "undefined") return;
    const query = searchWithFilters(window.location.search, activeFilters, lockedIds);
    const { pathname, hash } = window.location;
    const url = `${pathname}${query ? `?${query}` : ""}${hash}`;
    window.history.replaceState(window.history.state, "", url);
  }, [urlSync, activeFilters, lockedIds]);

  const setFilter = React.useCallback(
    (filterId: string, value: FilterValue | undefined, immediate = false) => {
      if (lockedIds.has(filterId)) return; // author-pinned: not user-editable
      setActiveFilters((prev) => {
        const next = { ...prev };
        if (value === undefined) delete next[filterId];
        else next[filterId] = value;
        applyDebounced(next, immediate);
        return next;
      });
    },
    [applyDebounced, lockedIds],
  );

  const clearFilter = React.useCallback(
    (filterId: string) => {
      // Required (and locked) filters reset to their default rather than empty.
      const def = filterDefs.find((d) => d.id === filterId);
      if (def && (def.required || def.locked)) {
        setFilter(filterId, def.default, true);
        return;
      }
      setFilter(filterId, undefined, true);
    },
    [setFilter, filterDefs],
  );

  const clearAllFilters = React.useCallback(() => {
    // Keep locked + required filters at their default; clear the rest.
    const floor: ActiveFilters = {};
    for (const def of filterDefs) {
      if ((def.locked || def.required) && def.default !== undefined) floor[def.id] = def.default;
    }
    setActiveFilters(floor);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setDebouncedFilters(floor);
  }, [filterDefs]);

  const onCrossFilter = React.useCallback(
    (sourceWidgetId: string, column: string, value: FilterValue) => {
      setCrossFilters((prev) => {
        // Replace any existing cross-filter for the same column from the same source.
        const filtered = prev.filter(
          (cf) => !(cf.sourceWidgetId === sourceWidgetId && cf.column === column),
        );
        return [
          ...filtered,
          {
            id: `cf-${++crossFilterSeq}`,
            column,
            value,
            sourceWidgetId,
          },
        ];
      });
    },
    [],
  );

  const removeCrossFilter = React.useCallback((id: string) => {
    setCrossFilters((prev) => prev.filter((cf) => cf.id !== id));
  }, []);

  const clearAllCrossFilters = React.useCallback(() => {
    setCrossFilters([]);
  }, []);

  const hasActiveFilters =
    Object.keys(activeFilters).length > 0 || crossFilters.length > 0;

  const value = React.useMemo<DashboardFilterContextValue>(
    () => ({
      filterDefs,
      activeFilters,
      debouncedFilters,
      crossFilters,
      setFilter,
      clearFilter,
      clearAllFilters,
      onCrossFilter,
      removeCrossFilter,
      clearAllCrossFilters,
      hasActiveFilters,
    }),
    [
      filterDefs,
      activeFilters,
      debouncedFilters,
      crossFilters,
      setFilter,
      clearFilter,
      clearAllFilters,
      onCrossFilter,
      removeCrossFilter,
      clearAllCrossFilters,
      hasActiveFilters,
    ],
  );

  return (
    <DashboardFilterContext.Provider value={value}>
      {children}
    </DashboardFilterContext.Provider>
  );
}

// ── Consumer hook ─────────────────────────────────────────────────────────────

export function useFilterContext(): DashboardFilterContextValue {
  const ctx = React.useContext(DashboardFilterContext);
  if (!ctx) {
    throw new Error("useFilterContext must be used inside DashboardFilterProvider");
  }
  return ctx;
}
