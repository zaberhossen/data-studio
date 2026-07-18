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
import { DashboardConflictError, getDashboardStore } from "@/lib/dashboard/store";
import { GRID_COLS, defaultSize, nextSlot, nextWidgetId } from "@/lib/dashboard/layout";
import {
  defaultElement,
  defaultFrame,
  ensureCanvasReady,
  ensureGridReady,
  gridToCanvas,
  nextCanvasY,
  nextElementId,
} from "@/lib/dashboard/canvas";
import type { CanvasConfig, CanvasFrame, DashboardTab } from "@/lib/types/dashboard";
import type { CanvasClipboard } from "@/lib/dashboard/clipboard";
import { nextTabId, resolveActiveTab } from "@/lib/dashboard/tabs";

export type DashboardMode = "edit" | "view";

export { GRID_COLS };

export interface UseDashboard {
  dashboard: Dashboard;
  mode: DashboardMode;
  setMode: (mode: DashboardMode) => void;
  loading: boolean;
  saving: boolean;
  /** A concurrent edit was detected on save; autosave is paused until resolved. */
  conflict: boolean;
  /** Resolve a save conflict by reloading the server copy or overwriting it. */
  resolveConflict: (strategy: "reload" | "overwrite") => Promise<void>;
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
  /** Copy a decoration element (fresh id, +16px offset). */
  duplicateElement: (id: string) => void;
  /** Toggle a canvas item's (widget/element/frame) lock or hidden flag. */
  setItemFlags: (id: string, patch: { locked?: boolean; hidden?: boolean }) => void;
  /** Paste clipboard widgets + elements (fresh ids, +24px). Returns the new ids. */
  pasteItems: (payload: CanvasClipboard) => string[];
  /** Group items (widgets/elements) under one fresh groupId; returns that id. */
  groupItems: (ids: string[]) => string | null;
  /** Clear group membership from the given items (and their group siblings). */
  ungroupItems: (ids: string[]) => void;
  /** Add a named frame (artboard) to the canvas. */
  addFrame: () => void;
  /** Patch a frame's name/box/background. Items are untouched (geometry-derived). */
  updateFrame: (id: string, patch: Partial<Omit<CanvasFrame, "id">>) => void;
  /** Remove a frame; the items on it stay on the canvas. */
  removeFrame: (id: string) => void;
  /** Patch the canvas surface config (size/background/grid/rulers). */
  updateCanvas: (patch: Partial<Omit<CanvasConfig, "frames">>) => void;
  /** Add a filter definition (persisted in Dashboard.filters). */
  addFilter: (filter: DashboardFilter) => void;
  /** Update fields on an existing filter definition by id. */
  updateFilter: (id: string, patch: Partial<DashboardFilter>) => void;
  /** Remove a filter definition by id. */
  removeFilter: (id: string) => void;
  // ── Page-view tabs ──────────────────────────────────────────────────────────
  /** The effective active tab id (resolved to a valid tab, or null when none). */
  activeTabId: string | null;
  setActiveTab: (id: string) => void;
  /** Add a tab (the first call also wraps existing content into "Tab 1"). */
  addTab: () => void;
  renameTab: (id: string, name: string) => void;
  /** Remove a tab AND its widgets/elements (undoable). */
  removeTab: (id: string) => void;
  save: () => Promise<void>;
  /** Undo/redo over every dashboard edit (add/move/style/delete/filters). */
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
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
  // Optimistic-lock state: the last server version we hold (echoed on save) and
  // whether a concurrent edit was detected (autosave pauses until resolved).
  const versionRef = React.useRef<number | undefined>(undefined);
  const [conflict, setConflict] = React.useState(false);
  // Ephemeral active Page-view tab (null → derive the first tab).
  const [activeTabChoice, setActiveTabChoice] = React.useState<string | null>(null);
  // Latest active tab, read by add/duplicate/paste to stamp new items' tabId.
  const activeTabRef = React.useRef<string | null>(null);

  // ── Undo/redo (snapshot history — a Dashboard is small, serializable data) ──
  // The mirrors live OUTSIDE setState updaters so React StrictMode's double-
  // invoked updaters can never double-push a history entry.
  const dashRef = React.useRef(dashboard);
  const past = React.useRef<Dashboard[]>([]);
  const future = React.useRef<Dashboard[]>([]);
  /** Coalescing key of the last mutation (e.g. per-keystroke renames = 1 entry). */
  const lastKey = React.useRef<string | null>(null);
  const [hist, setHist] = React.useState({ past: 0, future: 0 });

  /** Replace the dashboard WITHOUT recording history (load, undo, redo). */
  const resetTo = React.useCallback((next: Dashboard, clearHistory: boolean) => {
    dashRef.current = next;
    setDashboard(next);
    if (clearHistory) {
      past.current = [];
      future.current = [];
      lastKey.current = null;
    }
    setHist({ past: past.current.length, future: future.current.length });
  }, []);

  /**
   * Apply a mutation, recording the previous state for undo. Successive
   * mutations sharing a `coalesce` key collapse into one history entry.
   */
  const mutate = React.useCallback(
    (updater: (d: Dashboard) => Dashboard, coalesce?: string) => {
      const cur = dashRef.current;
      const next = updater(cur);
      if (next === cur) return;
      if (coalesce === undefined || coalesce !== lastKey.current) {
        past.current.push(cur);
        if (past.current.length > 50) past.current.shift();
      }
      lastKey.current = coalesce ?? null;
      future.current = [];
      dashRef.current = next;
      setDashboard(next);
      setHist({ past: past.current.length, future: 0 });
    },
    [],
  );

  const undo = React.useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(dashRef.current);
    lastKey.current = null;
    dashRef.current = prev;
    setDashboard(prev);
    setHist({ past: past.current.length, future: future.current.length });
  }, []);

  const redo = React.useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(dashRef.current);
    lastKey.current = null;
    dashRef.current = next;
    setDashboard(next);
    setHist({ past: past.current.length, future: future.current.length });
  }, []);

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
      // Loading is not an edit: replace the state and start history afresh.
      versionRef.current = found?.version;
      setConflict(false);
      resetTo(found ?? emptyDashboard(dashboardId), true);
      setActiveTabChoice(null); // reset tab selection for the new dashboard
      // A brand-new (empty) dashboard opens in edit mode so the user can build.
      setMode(found && found.widgets.length > 0 ? "view" : "edit");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [dashboardId, store, resetTo]);

  const persist = React.useCallback(
    async (next: Dashboard) => {
      setSaving(true);
      try {
        // Echo the version we last saw; the server bumps it and returns the new
        // one, which we stash for the next save (in a ref → no autosave loop).
        const saved = await store.save({ ...next, version: versionRef.current });
        versionRef.current = saved.version;
      } catch (err) {
        // A concurrent edit landed first: pause autosave and let the user choose
        // to reload or overwrite. Other errors bubble (best-effort autosave).
        if (err instanceof DashboardConflictError) setConflict(true);
        else throw err;
      } finally {
        setSaving(false);
      }
    },
    [store],
  );

  // Debounced autosave on every change (skips the initial load + while a
  // conflict is unresolved — otherwise every tick would re-hit the 409).
  const firstRun = React.useRef(true);
  React.useEffect(() => {
    if (loading || conflict) return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => void persist(dashboard), 600);
    return () => clearTimeout(t);
  }, [dashboard, loading, conflict, persist]);

  /**
   * Resolve a detected save conflict: "reload" discards local edits for the
   * server's copy; "overwrite" force-saves the local copy over it.
   */
  const resolveConflict = React.useCallback(
    async (strategy: "reload" | "overwrite") => {
      if (strategy === "reload") {
        const found = await store.get(dashRef.current.id);
        if (found) {
          versionRef.current = found.version;
          resetTo(found, true);
        }
      } else {
        setSaving(true);
        try {
          const saved = await store.save({ ...dashRef.current }, { force: true });
          versionRef.current = saved.version;
        } finally {
          setSaving(false);
        }
      }
      setConflict(false);
    },
    [store, resetTo],
  );

  // Per-keystroke renames coalesce into a single undo entry.
  const rename = React.useCallback(
    (name: string) => mutate((d) => ({ ...d, name }), "rename"),
    [mutate],
  );

  const addWidget = React.useCallback<UseDashboard["addWidget"]>((input) => {
    mutate((d) => {
      // Land on the active tab; place below only THAT tab's widgets.
      const tabId = d.tabs?.length ? (activeTabRef.current ?? d.tabs[0].id) : undefined;
      const first = d.tabs?.[0]?.id;
      const occupants = tabId
        ? d.widgets.filter((w) => (w.tabId ?? first) === tabId)
        : d.widgets;
      const size = defaultSize(input.viz.type);
      const layout = input.layout ?? nextSlot(occupants, size);
      const widget: Widget = {
        ...input,
        id: nextWidgetId(),
        layout,
        ...(tabId ? { tabId } : {}),
        // Give it a canvas box too when the dashboard is currently free-form,
        // so it appears immediately (otherwise derived on the next mode switch).
        ...(d.layoutMode === "canvas"
          ? { canvasLayout: { ...gridToCanvas(layout, (d.canvas ?? DEFAULT_CANVAS).width), y: nextCanvasY(d) } }
          : {}),
      };
      return { ...d, widgets: [...d.widgets, widget] };
    });
  }, [mutate]);

  const updateWidget = React.useCallback<UseDashboard["updateWidget"]>(
    (id, patch) => {
      mutate((d) => ({
        ...d,
        widgets: d.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)),
      }));
    },
    [mutate],
  );

  const duplicateWidget = React.useCallback((id: string) => {
    mutate((d) => {
      const src = d.widgets.find((w) => w.id === id);
      if (!src) return d;
      const size = { w: src.layout.w, h: src.layout.h };
      // The copy stays on the source's tab (carried by `...src`); place it below
      // that tab's widgets only.
      const first = d.tabs?.[0]?.id;
      const occupants = d.tabs?.length
        ? d.widgets.filter((w) => (w.tabId ?? first) === (src.tabId ?? first))
        : d.widgets;
      const copy: Widget = {
        ...src,
        id: nextWidgetId(),
        title: `${src.title} (copy)`,
        layout: nextSlot(occupants, size),
        ...(src.canvasLayout
          ? { canvasLayout: { ...src.canvasLayout, x: src.canvasLayout.x + 24, y: nextCanvasY(d) } }
          : {}),
      };
      return { ...d, widgets: [...d.widgets, copy] };
    });
  }, [mutate]);

  const removeWidget = React.useCallback(
    (id: string) => {
      mutate((d) => {
        const removed = d.widgets.find((w) => w.id === id);
        const widgets = d.widgets.filter((w) => w.id !== id);
        if (removed) onWidgetRemoved?.(removed, widgets);
        return { ...d, widgets };
      });
    },
    [mutate, onWidgetRemoved],
  );

  const applyLayout = React.useCallback((boxes: Record<string, WidgetLayout>) => {
    mutate((d) => {
      let changed = false;
      const sameBox = (a: WidgetLayout | undefined, b: WidgetLayout) =>
        !!a && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
      const widgets = d.widgets.map((w) => {
        const box = boxes[w.id];
        if (!box || sameBox(w.layout, box)) return w;
        changed = true;
        return { ...w, layout: { x: box.x, y: box.y, w: box.w, h: box.h } };
      });
      // Gridded elements (text cards on the Page layout) move the same way.
      const elements = (d.elements ?? []).map((e) => {
        const box = boxes[e.id];
        if (!box || sameBox(e.layout, box)) return e;
        changed = true;
        return { ...e, layout: { x: box.x, y: box.y, w: box.w, h: box.h } };
      });
      return changed ? { ...d, widgets, elements } : d;
    });
  }, [mutate]);

  const setLayoutMode = React.useCallback((next: LayoutMode) => {
    mutate((d) => {
      if ((d.layoutMode ?? "grid") === next) return d;
      // Entering either mode primes the placements it needs (both are lossless).
      const ready = next === "canvas" ? ensureCanvasReady(d) : ensureGridReady(d);
      return { ...ready, layoutMode: next };
    });
  }, [mutate]);

  const applyCanvasLayout = React.useCallback((boxes: Record<string, CanvasLayout>) => {
    mutate((d) => {
      let changed = false;
      const same = (a: CanvasLayout | undefined, b: CanvasLayout) =>
        !!a && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h &&
        (a.zIndex ?? 1) === (b.zIndex ?? 1) && (a.rotation ?? 0) === (b.rotation ?? 0) &&
        a.groupId === b.groupId;

      // Commits carry GEOMETRY only (readBox). Merge onto the existing box so
      // non-geometry fields (groupId/locked/hidden) survive a drag/resize.
      const widgets = d.widgets.map((w) => {
        const box = boxes[w.id];
        if (!box) return w;
        const next = w.canvasLayout ? { ...w.canvasLayout, ...box } : box;
        if (same(w.canvasLayout, next)) return w;
        changed = true;
        return { ...w, canvasLayout: next };
      });
      const elements = (d.elements ?? []).map((e) => {
        const box = boxes[e.id];
        if (!box) return e;
        const next = { ...e.canvasLayout, ...box };
        if (same(e.canvasLayout, next)) return e;
        changed = true;
        return { ...e, canvasLayout: next };
      });
      return changed ? { ...d, widgets, elements } : d;
    });
  }, [mutate]);

  const groupItems = React.useCallback<UseDashboard["groupItems"]>((ids) => {
    const idSet = new Set(ids);
    if (idSet.size < 2) return null;
    const gid = nextWidgetId("grp"); // minted outside the updater (StrictMode-safe)
    const stamp = (b: CanvasLayout): CanvasLayout => ({ ...b, groupId: gid });
    mutate((d) => ({
      ...d,
      widgets: d.widgets.map((w) =>
        idSet.has(w.id) && w.canvasLayout ? { ...w, canvasLayout: stamp(w.canvasLayout) } : w,
      ),
      elements: (d.elements ?? []).map((e) =>
        idSet.has(e.id) ? { ...e, canvasLayout: stamp(e.canvasLayout) } : e,
      ),
    }));
    return gid;
  }, [mutate]);

  const ungroupItems = React.useCallback<UseDashboard["ungroupItems"]>((ids) => {
    mutate((d) => {
      // Collect every groupId touched by the selection, then clear all members
      // of those groups (ungrouping one member ungroups the whole group).
      const idSet = new Set(ids);
      const groups = new Set<string>();
      for (const w of d.widgets)
        if (idSet.has(w.id) && w.canvasLayout?.groupId) groups.add(w.canvasLayout.groupId);
      for (const e of d.elements ?? [])
        if (idSet.has(e.id) && e.canvasLayout.groupId) groups.add(e.canvasLayout.groupId);
      if (groups.size === 0) return d;
      const strip = (b: CanvasLayout): CanvasLayout => {
        if (!b.groupId || !groups.has(b.groupId)) return b;
        const next = { ...b };
        delete next.groupId;
        return next;
      };
      return {
        ...d,
        widgets: d.widgets.map((w) =>
          w.canvasLayout ? { ...w, canvasLayout: strip(w.canvasLayout) } : w,
        ),
        elements: (d.elements ?? []).map((e) => ({ ...e, canvasLayout: strip(e.canvasLayout) })),
      };
    });
  }, [mutate]);

  const addElement = React.useCallback((kind: CanvasElement["kind"]) => {
    mutate((d) => {
      const el = defaultElement(kind, { x: 40, y: nextCanvasY(d) });
      // New items land on the active Page-view tab (if any).
      if (d.tabs?.length) el.tabId = activeTabRef.current ?? d.tabs[0].id;
      // On the Page (grid) layout a text card also needs a grid box; other
      // element kinds are canvas-only.
      if ((d.layoutMode ?? "grid") === "grid" && kind === "text") {
        const first = d.tabs?.[0]?.id;
        const sameTab = (t?: string) => (t ?? first) === (el.tabId ?? first);
        const occupants = [
          ...d.widgets.filter((w) => sameTab(w.tabId)),
          ...(d.elements ?? []).filter((e): e is CanvasElement & { layout: WidgetLayout } =>
            Boolean(e.layout) && sameTab(e.tabId),
          ),
        ];
        el.layout = nextSlot(occupants, { w: 6, h: 2 });
      }
      return { ...d, elements: [...(d.elements ?? []), el] };
    });
  }, [mutate]);

  const updateElement = React.useCallback<UseDashboard["updateElement"]>((id, patch) => {
    // Rapid content tweaks (color drag, typing) coalesce into one undo entry.
    mutate(
      (d) => ({
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
      }),
      `element-${id}`,
    );
  }, [mutate]);

  const duplicateElement = React.useCallback(
    (id: string) => {
      mutate((d) => {
        const src = (d.elements ?? []).find((e) => e.id === id);
        if (!src) return d;
        const copy: CanvasElement = {
          ...src,
          id: nextElementId(),
          canvasLayout: { ...src.canvasLayout, x: src.canvasLayout.x + 16, y: src.canvasLayout.y + 16 },
          ...(src.layout ? { layout: { ...src.layout } } : {}),
        };
        return { ...d, elements: [...(d.elements ?? []), copy] };
      });
    },
    [mutate],
  );

  const removeElement = React.useCallback((id: string) => {
    mutate((d) => ({
      ...d,
      elements: (d.elements ?? []).filter((e) => e.id !== id),
    }));
  }, [mutate]);

  // ── Layers: lock / hide, and clipboard paste ──────────────────────────────
  const setItemFlags = React.useCallback<UseDashboard["setItemFlags"]>((id, patch) => {
    mutate((d) => {
      if (d.canvas?.frames?.some((f) => f.id === id)) {
        return {
          ...d,
          canvas: {
            ...d.canvas,
            frames: d.canvas.frames.map((f) => (f.id === id ? { ...f, ...patch } : f)),
          },
        };
      }
      if (d.widgets.some((w) => w.id === id)) {
        return {
          ...d,
          widgets: d.widgets.map((w) =>
            w.id === id && w.canvasLayout
              ? { ...w, canvasLayout: { ...w.canvasLayout, ...patch } }
              : w,
          ),
        };
      }
      return {
        ...d,
        elements: (d.elements ?? []).map((e) =>
          e.id === id ? { ...e, canvasLayout: { ...e.canvasLayout, ...patch } } : e,
        ),
      };
    });
  }, [mutate]);

  const pasteItems = React.useCallback<UseDashboard["pasteItems"]>(
    (payload) => {
      const newIds: string[] = [];
      // Remap any copied groupIds to fresh ones so a pasted group stays a group
      // but never merges into the (still-present) source group.
      const groupRemap = new Map<string, string>();
      const offset = (b: CanvasLayout): CanvasLayout => {
        const box: CanvasLayout = { ...b, x: b.x + 24, y: b.y + 24 };
        if (box.groupId) {
          const next = groupRemap.get(box.groupId) ?? nextWidgetId("grp");
          groupRemap.set(box.groupId, next);
          box.groupId = next;
        }
        return box;
      };
      // Mint ids OUTSIDE the updater so a StrictMode re-invoke can't diverge.
      // Pasted items land on the currently-active tab (undefined when untabbed).
      const tabId = activeTabRef.current ?? undefined;
      const widgets = payload.widgets.map((w) => {
        const wid = nextWidgetId();
        newIds.push(wid);
        return {
          ...w,
          id: wid,
          tabId,
          canvasLayout: w.canvasLayout ? offset(w.canvasLayout) : undefined,
        };
      });
      const elements = payload.elements.map((e) => {
        const eid = nextElementId();
        newIds.push(eid);
        return { ...e, id: eid, tabId, canvasLayout: offset(e.canvasLayout) };
      });
      mutate((d) => ({
        ...d,
        widgets: [...d.widgets, ...widgets],
        elements: [...(d.elements ?? []), ...elements],
      }));
      return newIds;
    },
    [mutate],
  );

  // ── Frames (canvas artboards; live inside the `canvas` config) ─────────────
  const addFrame = React.useCallback(() => {
    mutate((d) => {
      const canvas = d.canvas ?? { ...DEFAULT_CANVAS };
      const frames = canvas.frames ?? [];
      return { ...d, canvas: { ...canvas, frames: [...frames, defaultFrame(frames)] } };
    });
  }, [mutate]);

  const updateFrame = React.useCallback<UseDashboard["updateFrame"]>((id, patch) => {
    mutate(
      (d) => {
        if (!d.canvas?.frames) return d;
        return {
          ...d,
          canvas: {
            ...d.canvas,
            frames: d.canvas.frames.map((f) => (f.id === id ? { ...f, ...patch } : f)),
          },
        };
      },
      `frame-${id}`,
    );
  }, [mutate]);

  const removeFrame = React.useCallback((id: string) => {
    mutate((d) => {
      if (!d.canvas?.frames) return d;
      return {
        ...d,
        canvas: { ...d.canvas, frames: d.canvas.frames.filter((f) => f.id !== id) },
      };
    });
  }, [mutate]);

  const updateCanvas = React.useCallback<UseDashboard["updateCanvas"]>((patch) => {
    mutate(
      (d) => ({ ...d, canvas: { ...(d.canvas ?? DEFAULT_CANVAS), ...patch } }),
      "canvas-config",
    );
  }, [mutate]);

  const addFilter = React.useCallback((filter: DashboardFilter) => {
    mutate((d) => ({ ...d, filters: [...(d.filters ?? []), filter] }));
  }, [mutate]);

  const updateFilter = React.useCallback(
    (id: string, patch: Partial<DashboardFilter>) => {
      mutate(
        (d) => ({
          ...d,
          filters: (d.filters ?? []).map((f) =>
            f.id === id ? { ...f, ...patch } : f,
          ),
        }),
        `filter-${id}`,
      );
    },
    [mutate],
  );

  const removeFilter = React.useCallback((id: string) => {
    mutate((d) => ({
      ...d,
      filters: (d.filters ?? []).filter((f) => f.id !== id),
    }));
  }, [mutate]);

  // ── Page-view tabs ──────────────────────────────────────────────────────────
  const activeTabId = resolveActiveTab(dashboard.tabs, activeTabChoice);
  React.useEffect(() => {
    activeTabRef.current = activeTabId;
  }, [activeTabId]);

  const setActiveTab = React.useCallback((id: string) => setActiveTabChoice(id), []);

  const addTab = React.useCallback(() => {
    const idA = nextTabId();
    const idB = nextTabId();
    mutate((d) => {
      const existing = d.tabs ?? [];
      if (existing.length === 0) {
        // First tab-ification: existing content becomes "Tab 1", plus an empty one.
        const t1: DashboardTab = { id: idA, name: "Tab 1" };
        const t2: DashboardTab = { id: idB, name: "Tab 2" };
        return {
          ...d,
          tabs: [t1, t2],
          widgets: d.widgets.map((w) => (w.tabId ? w : { ...w, tabId: t1.id })),
          elements: (d.elements ?? []).map((e) => (e.tabId ? e : { ...e, tabId: t1.id })),
        };
      }
      return { ...d, tabs: [...existing, { id: idB, name: `Tab ${existing.length + 1}` }] };
    });
    setActiveTabChoice(idB); // land on the freshly-added (empty) tab
  }, [mutate]);

  const renameTab = React.useCallback(
    (id: string, name: string) => {
      mutate(
        (d) => ({
          ...d,
          tabs: (d.tabs ?? []).map((t) => (t.id === id ? { ...t, name } : t)),
        }),
        `tab-${id}`,
      );
    },
    [mutate],
  );

  const removeTab = React.useCallback(
    (id: string) => {
      mutate((d) => {
        const tabs = (d.tabs ?? []).filter((t) => t.id !== id);
        const firstId = d.tabs?.[0]?.id;
        const onTab = (item: { tabId?: string }) => (item.tabId ?? firstId) === id;
        const removedWidgets = d.widgets.filter(onTab);
        const widgets = d.widgets.filter((w) => !onTab(w));
        const elements = (d.elements ?? []).filter((e) => !onTab(e));
        removedWidgets.forEach((w) => onWidgetRemoved?.(w, widgets));
        // Collapsing to ≤1 tab returns to the clean single-page state (drop the
        // tabs array AND every stale tabId so a later "Add tab" re-wraps cleanly).
        if (tabs.length <= 1) {
          const stripTab = <T extends { tabId?: string }>(item: T): T => {
            const copy = { ...item };
            delete copy.tabId;
            return copy;
          };
          return {
            ...d,
            tabs: undefined,
            widgets: widgets.map(stripTab),
            elements: elements.map(stripTab),
          };
        }
        return { ...d, tabs, widgets, elements };
      });
      setActiveTabChoice((cur) => (cur === id ? null : cur));
    },
    [mutate, onWidgetRemoved],
  );

  const save = React.useCallback(async () => {
    await persist(dashboard);
  }, [persist, dashboard]);

  return {
    dashboard,
    mode,
    setMode,
    loading,
    saving,
    conflict,
    resolveConflict,
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
    duplicateElement,
    setItemFlags,
    pasteItems,
    groupItems,
    ungroupItems,
    addFrame,
    updateFrame,
    removeFrame,
    updateCanvas,
    addFilter,
    updateFilter,
    removeFilter,
    activeTabId,
    setActiveTab,
    addTab,
    renameTab,
    removeTab,
    save,
    undo,
    redo,
    canUndo: hist.past > 0,
    canRedo: hist.future > 0,
  };
}
