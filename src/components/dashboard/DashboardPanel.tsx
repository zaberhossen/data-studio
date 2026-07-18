"use client";

/**
 * DashboardPanel — the Dashboards workspace.
 *
 * Composes the pieces: `useDashboard` (state + persistence), `useQueryScheduler`
 * (queue + cache keyed by the shared engine), the filter context + filter bar,
 * the grid, the widget tiles, and the add/edit dialog.
 *
 * Filter lifecycle:
 *   - Dashboard.filters (DashboardFilter[]) are PERSISTED definitions.
 *   - Active filter values (ActiveFilters) are ephemeral runtime state.
 *   - The DashboardFilterProvider holds both, providing debouncedFilters to
 *     widgets so rapid slider/typing changes don't cause a re-run storm.
 *   - Each DashboardWidget computes its own effectiveWidget using the context;
 *     widgets not targeted by any active filter get a cache hit automatically.
 */

import * as React from "react";
import {
  Check,
  FileDown,
  LayoutGrid,
  Loader2,
  Maximize2,
  MoreHorizontal,
  PenTool,
  Plus,
  Redo2,
  RefreshCw,
  Share2,
  Timer,
  Type,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AnalyticsEngine } from "@/hooks/useAnalyticsEngine";
import type { DataSourcesApi } from "@/hooks/useDataSources";
import { useDashboard } from "@/hooks/useDashboard";
import { useDashboardList } from "@/hooks/useDashboardList";
import { useQueryScheduler } from "@/hooks/useQueryScheduler";
import type { DashboardFilter, Widget } from "@/lib/types/dashboard";
import { DashboardView } from "./DashboardView";
import { DashboardList } from "./DashboardList";
import { ShareDialog } from "./ShareDialog";
import { AddWidgetDialog, type WidgetInput } from "./AddWidgetDialog";
import { DashboardFilterProvider } from "./DashboardFilterContext";
import { FilterBar } from "./FilterBar";
import { FilterEditor } from "./FilterEditor";
import { exportNodeToPdf } from "@/lib/dashboard/export";
import { DashboardTabs } from "./DashboardTabs";

interface DashboardPanelProps {
  engine: AnalyticsEngine;
  sources: DataSourcesApi;
}

/** Auto-refresh choices (seconds). 0 = off. Persisted per dashboard, client-side. */
const REFRESH_OPTIONS: Array<{ secs: number; label: string }> = [
  { secs: 0, label: "Off" },
  { secs: 30, label: "30 seconds" },
  { secs: 60, label: "1 minute" },
  { secs: 300, label: "5 minutes" },
  { secs: 900, label: "15 minutes" },
];

const refreshKey = (dashboardId: string) => `data-studio:dashboard-refresh:${dashboardId}`;

function readRefreshSecs(dashboardId: string): number {
  if (typeof window === "undefined") return 0;
  try {
    return Number(window.localStorage.getItem(refreshKey(dashboardId)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function DashboardPanel({ engine, sources }: DashboardPanelProps) {
  const scheduler = useQueryScheduler(engine, sources.resolveSpec);

  const onWidgetRemoved = React.useCallback(
    (removed: Widget, remaining: Widget[]) => {
      scheduler.forget(removed.id);
      const stillUsed = remaining.some((w) => w.sourceId === removed.sourceId);
      if (!stillUsed) {
        scheduler.invalidateSource(removed.sourceId);
        engine.evictDataset(removed.sourceId);
      }
    },
    [scheduler, engine],
  );

  const dl = useDashboardList();
  const dash = useDashboard(dl.activeId ?? "", onWidgetRemoved);
  const { dashboard, mode } = dash;

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Widget | null>(null);
  const [shareOpen, setShareOpen] = React.useState(false);

  const sourceOptions = React.useMemo(
    () => sources.sources.map((s) => ({ id: s.id, name: s.name })),
    [sources.sources],
  );

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (w: Widget) => {
    setEditing(w);
    setDialogOpen(true);
  };

  const handleSubmit = React.useCallback(
    (input: WidgetInput, editingId: string | null) => {
      if (editingId) {
        dash.updateWidget(editingId, {
          title: input.title,
          sourceId: input.sourceId,
          queryKind: input.queryKind,
          // Clear any legacy v1 builder query when converting to ir/sql.
          query: undefined,
          ir: input.ir,
          sql: input.sql,
          viz: input.viz,
          clickBehavior: input.clickBehavior,
        });
      } else {
        dash.addWidget({
          title: input.title,
          sourceId: input.sourceId,
          queryKind: input.queryKind,
          ir: input.ir,
          sql: input.sql,
          viz: input.viz,
          clickBehavior: input.clickBehavior,
        });
      }
    },
    [dash],
  );

  const refreshAll = React.useCallback(() => {
    for (const w of dashboard.widgets) scheduler.submit(w, true);
  }, [dashboard.widgets, scheduler]);

  // ── Auto-refresh (per dashboard; persisted client-side) ────────────────────
  const [refreshSecs, setRefreshSecsState] = React.useState(() =>
    readRefreshSecs(dashboard.id),
  );
  const prevDashId = React.useRef(dashboard.id);
  /* eslint-disable react-hooks/refs -- prev-prop tracker for the documented set-state-during-render pattern (dashboard switch reloads its saved interval) */
  if (dashboard.id !== prevDashId.current) {
    prevDashId.current = dashboard.id;
    setRefreshSecsState(readRefreshSecs(dashboard.id));
  }
  /* eslint-enable react-hooks/refs */
  const setRefreshSecs = (secs: number) => {
    setRefreshSecsState(secs);
    try {
      if (secs > 0) window.localStorage.setItem(refreshKey(dashboard.id), String(secs));
      else window.localStorage.removeItem(refreshKey(dashboard.id));
    } catch {
      // Persistence is best-effort; the interval still applies this session.
    }
  };

  React.useEffect(() => {
    if (refreshSecs <= 0 || dashboard.widgets.length === 0) return;
    const t = setInterval(() => {
      // Don't burn queries while the tab is hidden (a TV that went to sleep).
      if (document.visibilityState === "visible") refreshAll();
    }, refreshSecs * 1000);
    return () => clearInterval(t);
  }, [refreshSecs, dashboard.widgets.length, refreshAll]);

  // ── Undo/redo keyboard (⌘Z / ⌘⇧Z, edit mode, not while typing) ─────────────
  const { undo, redo } = dash;
  React.useEffect(() => {
    if (mode !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, undo, redo]);

  // ── PDF export (captures the dashboard render region) ────────────────────────
  const exportRef = React.useRef<HTMLDivElement>(null);
  const [exportingPdf, setExportingPdf] = React.useState(false);
  const exportPdf = React.useCallback(async () => {
    if (!exportRef.current) return;
    setExportingPdf(true);
    try {
      await exportNodeToPdf(exportRef.current, dashboard.name);
    } catch {
      // Best-effort; a failed capture shouldn't break the dashboard.
    } finally {
      setExportingPdf(false);
    }
  }, [dashboard.name]);

  // ── TV / fullscreen mode ────────────────────────────────────────────────────
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [tv, setTv] = React.useState(false);
  React.useEffect(() => {
    const onChange = () => setTv(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const enterTv = () => {
    dash.setMode("view");
    void rootRef.current?.requestFullscreen?.();
  };

  // ── Filter definition management (persisted in Dashboard) ─────────────────

  const filterDefs = dashboard.filters ?? [];

  const filterIdSeq = React.useRef(0);

  const addFilter = React.useCallback(
    (filter: Omit<DashboardFilter, "id">) => {
      const id = `df-${++filterIdSeq.current}-${Date.now()}`;
      dash.addFilter({ ...filter, id });
    },
    [dash],
  );

  const updateFilter = React.useCallback(
    (id: string, patch: Partial<DashboardFilter>) => {
      dash.updateFilter(id, patch);
    },
    [dash],
  );

  const removeFilter = React.useCallback(
    (id: string) => {
      dash.removeFilter(id);
    },
    [dash],
  );

  const layoutMode = dashboard.layoutMode ?? "grid";
  const isEmpty = dashboard.widgets.length === 0;

  if (dl.loading || dash.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <DashboardFilterProvider key={dashboard.id} filterDefs={filterDefs} urlSync>
      <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-background">
        {/* ── Toolbar (hidden in TV/fullscreen mode; Esc exits) ─────────── */}
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5"
          hidden={tv}
        >
          <div className="flex min-w-0 items-center gap-2">
            <DashboardList
              list={dl.list}
              activeId={dl.activeId}
              activeName={dashboard.name}
              onSelect={dl.select}
              onCreate={dl.create}
              onDuplicate={dl.duplicate}
              onDelete={dl.remove}
            />
            {mode === "edit" && (
              <Input
                value={dashboard.name}
                onChange={(e) => dash.rename(e.target.value)}
                className="h-8 w-56 font-medium"
                aria-label="Dashboard name"
              />
            )}
            {dash.saving && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Saving…
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {mode === "edit" && (
              <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={undo}
                  disabled={!dash.canUndo}
                  aria-label="Undo"
                  title="Undo (⌘Z)"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={redo}
                  disabled={!dash.canRedo}
                  aria-label="Redo"
                  title="Redo (⌘⇧Z)"
                >
                  <Redo2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={refreshAll}
              disabled={isEmpty}
              title="Refresh all widgets"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>

            {/* Auto-refresh interval */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  disabled={isEmpty}
                  aria-label="Auto-refresh interval"
                  title={
                    refreshSecs > 0
                      ? `Auto-refresh: every ${REFRESH_OPTIONS.find((o) => o.secs === refreshSecs)?.label ?? `${refreshSecs}s`}`
                      : "Auto-refresh: off"
                  }
                >
                  <Timer
                    className={refreshSecs > 0 ? "h-3.5 w-3.5 text-primary" : "h-3.5 w-3.5"}
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {REFRESH_OPTIONS.map((o) => (
                  <DropdownMenuItem key={o.secs} onSelect={() => setRefreshSecs(o.secs)}>
                    <Check className={o.secs === refreshSecs ? "opacity-100" : "opacity-0"} />
                    {o.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={enterTv}
              disabled={isEmpty}
              aria-label="Fullscreen (TV mode)"
              title="Fullscreen (TV mode) — Esc to exit"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setShareOpen(true)}
              disabled={isEmpty}
              title="Share this dashboard"
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </Button>

            {/* Dashboard actions: duplicate + the lossless Page ⇄ Canvas convert */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Dashboard actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => dl.activeId && void dl.duplicate(dl.activeId)}
                >
                  Duplicate dashboard
                </DropdownMenuItem>
                <DropdownMenuItem disabled={isEmpty || exportingPdf} onSelect={exportPdf}>
                  <FileDown />
                  {exportingPdf ? "Exporting…" : "Export PDF"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {layoutMode === "grid" ? (
                  <DropdownMenuItem onSelect={() => dash.setLayoutMode("canvas")}>
                    <PenTool />
                    Convert to canvas
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => dash.setLayoutMode("grid")}>
                    <LayoutGrid />
                    Convert to page
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
              {(["view", "edit"] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={mode === m ? "secondary" : "ghost"}
                  className="h-7 capitalize"
                  onClick={() => dash.setMode(m)}
                >
                  {m}
                </Button>
              ))}
            </div>

            {mode === "edit" && layoutMode === "grid" && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => dash.addElement("text")}
                title="Add a text card"
              >
                <Type className="h-3.5 w-3.5" />
                Text
              </Button>
            )}
            {mode === "edit" && (
              <Button size="sm" className="h-8" onClick={openAdd}>
                <Plus className="h-3.5 w-3.5" />
                Add widget
              </Button>
            )}
          </div>
        </div>

        {/* ── Page-view tabs (grid mode; hidden in canvas + when none & viewing) */}
        {layoutMode === "grid" && !tv && (
          <DashboardTabs
            tabs={dashboard.tabs}
            activeTabId={dash.activeTabId}
            editable={mode === "edit"}
            onSelect={dash.setActiveTab}
            onAdd={dash.addTab}
            onRename={dash.renameTab}
            onRemove={dash.removeTab}
          />
        )}

        {/* ── Filter bar (always visible when filters exist or cross-filters active) */}
        <FilterBar />

        {/* ── Filter editor (edit mode only) ──────────────────────────── */}
        {mode === "edit" && (
          <FilterEditor
            filters={filterDefs}
            widgets={dashboard.widgets}
            onAdd={addFilter}
            onUpdate={updateFilter}
            onRemove={removeFilter}
          />
        )}

        {/* ── Save-conflict banner (optimistic lock) ──────────────────── */}
        {dash.conflict && (
          <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
            <span className="font-medium">
              This dashboard was changed elsewhere — your latest edits aren&apos;t saved.
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => void dash.resolveConflict("reload")}
              >
                Reload theirs
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => void dash.resolveConflict("overwrite")}
              >
                Keep mine
              </Button>
            </div>
          </div>
        )}

        {/* ── Render region (grid or free-form canvas) ────────────────── */}
        <div ref={exportRef} className="flex min-h-0 flex-1 flex-col">
        <DashboardView
          dashboard={dashboard}
          scheduler={scheduler}
          mode={mode}
          onEditWidget={openEdit}
          onDuplicateWidget={dash.duplicateWidget}
          onRemoveWidget={dash.removeWidget}
          onLayoutChange={dash.applyLayout}
          onApplyCanvasLayout={dash.applyCanvasLayout}
          onAddElement={dash.addElement}
          onUpdateElement={dash.updateElement}
          onRemoveElement={dash.removeElement}
          onDuplicateElement={dash.duplicateElement}
          onAddFrame={dash.addFrame}
          onUpdateFrame={dash.updateFrame}
          onRemoveFrame={dash.removeFrame}
          onUpdateCanvas={dash.updateCanvas}
          onUpdateWidget={dash.updateWidget}
          activeTabId={dash.activeTabId}
          onSetItemFlags={dash.setItemFlags}
          onPasteItems={dash.pasteItems}
          onGroup={dash.groupItems}
          onUngroup={dash.ungroupItems}
          onAddWidget={openAdd}
        />
        </div>

        <AddWidgetDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          sources={sourceOptions}
          getFields={sources.getFields}
          tableNameForId={engine.tableNameForId}
          initial={editing}
          dashboards={dl.list
            .filter((d) => d.id !== dl.activeId)
            .map((d) => ({ id: d.id, name: d.name }))}
          onSubmit={handleSubmit}
        />

        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          dashboard={dashboard}
          scheduler={scheduler}
        />
      </div>
    </DashboardFilterProvider>
  );
}
