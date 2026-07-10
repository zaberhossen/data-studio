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
  children: React.ReactNode;
}

export function DashboardFilterProvider({
  filterDefs,
  children,
}: DashboardFilterProviderProps) {
  const [activeFilters, setActiveFilters] = React.useState<ActiveFilters>({});
  const [debouncedFilters, setDebouncedFilters] = React.useState<ActiveFilters>({});
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

  const setFilter = React.useCallback(
    (filterId: string, value: FilterValue | undefined, immediate = false) => {
      setActiveFilters((prev) => {
        const next = { ...prev };
        if (value === undefined) delete next[filterId];
        else next[filterId] = value;
        applyDebounced(next, immediate);
        return next;
      });
    },
    [applyDebounced],
  );

  const clearFilter = React.useCallback(
    (filterId: string) => {
      setFilter(filterId, undefined, true);
    },
    [setFilter],
  );

  const clearAllFilters = React.useCallback(() => {
    setActiveFilters({});
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setDebouncedFilters({});
  }, []);

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
