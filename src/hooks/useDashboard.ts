"use client";

/**
 * useDashboard — owns ONE active dashboard's editable state + persistence.
 *
 * It holds only the serializable `Dashboard` (queries + layout + viz — never
 * rows), the edit/view mode, and save status. Layout edits mutate only each
 * widget's `layout` box; because a widget only re-queries when its
 * source/query/sql changes (the scheduler keys on those), dragging/resizing
 * never triggers a re-run — a hard requirement for 60 FPS interaction.
 *
 * Persistence goes through the pluggable `DashboardStore` (localStorage MVP),
 * so swapping to `/api/dashboards` is a one-line change in the store module.
 */

import * as React from "react";
import type {
  CanvasElement,
  CanvasLayout,
  Dashboard,
  DashboardFilter,
  ElementContent,
  LayoutMode,
  Widget,
  WidgetLayout,
} from "@/lib/types/dashboard";
import { DEFAULT_CANVAS, emptyDashboard } from "@/lib/types/dashboard";
import { getDashboardStore } from "@/lib/dashboard/store";
import { GRID_COLS, defaultSize, nextSlot, nextWidgetId } from "@/lib/dashboard/layout";
import { defaultElement, ensureCanvasReady, gridToCanvas, nextCanvasY } from "@/lib/dashboard/canvas";

export type DashboardMode = "edit" | "view";

export { GRID_COLS };

export interface UseDashboard {
  dashboard: Dashboard;
  mode: DashboardMode;
  setMode: (mode: DashboardMode) => void;
  loading: boolean;
  saving: boolean;
  rename: (name: string) => void;
  /** Add a fully-formed widget (layout auto-placed if omitted). */
  addWidget: (widget: Omit<Widget, "id" | "layout"> & { layout?: WidgetLayout }) => void;
  updateWidget: (id: string, patch: Partial<Omit<Widget, "id">>) => void;
  duplicateWidget: (id: string) => void;
  removeWidget: (id: string) => void;
  /** Apply grid layout boxes back onto widgets (drag/resize) — no re-query. */
  applyLayout: (boxes: Record<string, WidgetLayout>) => void;
  /** Switch grid ⇄ canvas (derives canvas boxes from the grid on first switch). */
  setLayoutMode: (mode: LayoutMode) => void;
  /** Apply canvas pixel boxes back onto widgets AND elements — no re-query. */
  applyCanvasLayout: (boxes: Record<string, CanvasLayout>) => void;
  /** Add a decoration element (text/image/shape/line) at the next free slot. */
  addElement: (kind: CanvasElement["kind"]) => void;
  /** Patch an element's content and/or placement. */
  updateElement: (id: string, patch: Partial<Pick<CanvasElement, "canvasLayout">> & { content?: ElementContent }) => void;
  /** Remove a decoration element. */
  removeElement: (id: string) => void;
  /** Add a filter definition (persisted in Dashboard.filters). */
  addFilter: (filter: DashboardFilter) => void;
  /** Update fields on an existing filter definition by id. */
  updateFilter: (id: string, patch: Partial<DashboardFilter>) => void;
  /** Remove a filter definition by id. */
  removeFilter: (id: string) => void;
  save: () => Promise<void>;
}

/**
 * @param dashboardId  the dashboard to load/create
 * @param onWidgetRemoved  called when a widget leaves, so the scheduler can
 *   forget it (and evict its source if now unused). Kept as a callback so this
 *   hook stays independent of the scheduler.
 */
export function useDashboard(
  dashboardId: string,
  onWidgetRemoved?: (widget: Widget, remaining: Widget[]) => void,
): UseDashboard {
  const store = React.useMemo(() => getDashboardStore(), []);
  const [dashboard, setDashboard] = React.useState<Dashboard>(() =>
    emptyDashboard(dashboardId),
  );
  const [mode, setMode] = React.useState<DashboardMode>("view");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  // Load the dashboard once per id. An empty id means "not resolved yet" (the
  // panel is still fetching the dashboard list) — stay loading, touch nothing.
  React.useEffect(() => {
    if (!dashboardId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async load on mount; not derivable during render
      setLoading(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void store.get(dashboardId).then((found) => {
      if (cancelled) return;
      setDashboard(found ?? emptyDashboard(dashboardId));
      // A brand-new (empty) dashboard opens in edit mode so the user can build.
      setMode(found && found.widgets.length > 0 ? "view" : "edit");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [dashboardId, store]);

  const persist = React.useCallback(
    async (next: Dashboard) => {
      setSaving(true);
      try {
        await store.save(next);
      } finally {
        setSaving(false);
      }
    },
    [store],
  );

  // Debounced autosave on every change (skips the initial load).
  const firstRun = React.useRef(true);
  React.useEffect(() => {
    if (loading) return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => void persist(dashboard), 600);
    return () => clearTimeout(t);
  }, [dashboard, loading, persist]);

  const rename = React.useCallback(
    (name: string) => setDashboard((d) => ({ ...d, name })),
    [],
  );

  const addWidget = React.useCallback<UseDashboard["addWidget"]>((input) => {
    setDashboard((d) => {
      const size = defaultSize(input.viz.type);
      const layout = input.layout ?? nextSlot(d.widgets, size);
      const widget: Widget = {
        ...input,
        id: nextWidgetId(),
        layout,
        // Give it a canvas box too when the dashboard is currently free-form,
        // so it appears immediately (otherwise derived on the next mode switch).
        ...(d.layoutMode === "canvas"
          ? { canvasLayout: { ...gridToCanvas(layout, (d.canvas ?? DEFAULT_CANVAS).width), y: nextCanvasY(d) } }
          : {}),
      };
      return { ...d, widgets: [...d.widgets, widget] };
    });
  }, []);

  const updateWidget = React.useCallback<UseDashboard["updateWidget"]>(
    (id, patch) => {
      setDashboard((d) => ({
        ...d,
        widgets: d.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)),
      }));
    },
    [],
  );

  const duplicateWidget = React.useCallback((id: string) => {
    setDashboard((d) => {
      const src = d.widgets.find((w) => w.id === id);
      if (!src) return d;
      const size = { w: src.layout.w, h: src.layout.h };
      const copy: Widget = {
        ...src,
        id: nextWidgetId(),
        title: `${src.title} (copy)`,
        layout: nextSlot(d.widgets, size),
        ...(src.canvasLayout
          ? { canvasLayout: { ...src.canvasLayout, x: src.canvasLayout.x + 24, y: nextCanvasY(d) } }
          : {}),
      };
      return { ...d, widgets: [...d.widgets, copy] };
    });
  }, []);

  const removeWidget = React.useCallback(
    (id: string) => {
      setDashboard((d) => {
        const removed = d.widgets.find((w) => w.id === id);
        const widgets = d.widgets.filter((w) => w.id !== id);
        if (removed) onWidgetRemoved?.(removed, widgets);
        return { ...d, widgets };
      });
    },
    [onWidgetRemoved],
  );

  const applyLayout = React.useCallback((boxes: Record<string, WidgetLayout>) => {
    setDashboard((d) => {
      let changed = false;
      const widgets = d.widgets.map((w) => {
        const box = boxes[w.id];
        if (!box) return w;
        const { x, y, w: cw, h } = box;
        if (x === w.layout.x && y === w.layout.y && cw === w.layout.w && h === w.layout.h) {
          return w;
        }
        changed = true;
        return { ...w, layout: { x, y, w: cw, h } };
      });
      return changed ? { ...d, widgets } : d;
    });
  }, []);

  const setLayoutMode = React.useCallback((next: LayoutMode) => {
    setDashboard((d) => {
      if ((d.layoutMode ?? "grid") === next) return d;
      // Switching to canvas: make sure a surface + per-widget pixel boxes exist.
      const ready = next === "canvas" ? ensureCanvasReady(d) : d;
      return { ...ready, layoutMode: next };
    });
  }, []);

  const applyCanvasLayout = React.useCallback((boxes: Record<string, CanvasLayout>) => {
    setDashboard((d) => {
      let changed = false;
      const same = (a: CanvasLayout | undefined, b: CanvasLayout) =>
        !!a && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h &&
        (a.zIndex ?? 1) === (b.zIndex ?? 1) && (a.rotation ?? 0) === (b.rotation ?? 0);

      const widgets = d.widgets.map((w) => {
        const box = boxes[w.id];
        if (!box || same(w.canvasLayout, box)) return w;
        changed = true;
        return { ...w, canvasLayout: box };
      });
      const elements = (d.elements ?? []).map((e) => {
        const box = boxes[e.id];
        if (!box || same(e.canvasLayout, box)) return e;
        changed = true;
        return { ...e, canvasLayout: box };
      });
      return changed ? { ...d, widgets, elements } : d;
    });
  }, []);

  const addElement = React.useCallback((kind: CanvasElement["kind"]) => {
    setDashboard((d) => {
      const el = defaultElement(kind, { x: 40, y: nextCanvasY(d) });
      return { ...d, elements: [...(d.elements ?? []), el] };
    });
  }, []);

  const updateElement = React.useCallback<UseDashboard["updateElement"]>((id, patch) => {
    setDashboard((d) => ({
      ...d,
      elements: (d.elements ?? []).map((e) =>
        e.id === id
          ? {
              ...e,
              canvasLayout: patch.canvasLayout ?? e.canvasLayout,
              content: patch.content ?? e.content,
            }
          : e,
      ),
    }));
  }, []);

  const removeElement = React.useCallback((id: string) => {
    setDashboard((d) => ({
      ...d,
      elements: (d.elements ?? []).filter((e) => e.id !== id),
    }));
  }, []);

  const addFilter = React.useCallback((filter: DashboardFilter) => {
    setDashboard((d) => ({ ...d, filters: [...(d.filters ?? []), filter] }));
  }, []);

  const updateFilter = React.useCallback(
    (id: string, patch: Partial<DashboardFilter>) => {
      setDashboard((d) => ({
        ...d,
        filters: (d.filters ?? []).map((f) =>
          f.id === id ? { ...f, ...patch } : f,
        ),
      }));
    },
    [],
  );

  const removeFilter = React.useCallback((id: string) => {
    setDashboard((d) => ({
      ...d,
      filters: (d.filters ?? []).filter((f) => f.id !== id),
    }));
  }, []);

  const save = React.useCallback(async () => {
    await persist(dashboard);
  }, [persist, dashboard]);

  return {
    dashboard,
    mode,
    setMode,
    loading,
    saving,
    rename,
    addWidget,
    updateWidget,
    duplicateWidget,
    removeWidget,
    applyLayout,
    setLayoutMode,
    applyCanvasLayout,
    addElement,
    updateElement,
    removeElement,
    addFilter,
    updateFilter,
    removeFilter,
    save,
  };
}
