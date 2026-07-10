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
import { LayoutGrid, Loader2, Move, Plus, RefreshCw, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

interface DashboardPanelProps {
  engine: AnalyticsEngine;
  sources: DataSourcesApi;
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
        });
      } else {
        dash.addWidget({
          title: input.title,
          sourceId: input.sourceId,
          queryKind: input.queryKind,
          ir: input.ir,
          sql: input.sql,
          viz: input.viz,
        });
      }
    },
    [dash],
  );

  const refreshAll = () => {
    for (const w of dashboard.widgets) scheduler.submit(w, true);
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
    <DashboardFilterProvider filterDefs={filterDefs}>
      <div className="flex h-full min-h-0 flex-col">
        {/* ── Toolbar ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <DashboardList
              list={dl.list}
              activeId={dl.activeId}
              activeName={dashboard.name}
              onSelect={dl.select}
              onCreate={dl.create}
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

            {/* Grid ⇄ canvas layout mode (per dashboard, lossless) */}
            <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
              <Button
                type="button"
                size="sm"
                variant={layoutMode === "grid" ? "secondary" : "ghost"}
                className="h-7 gap-1.5"
                onClick={() => dash.setLayoutMode("grid")}
                title="Grid layout"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Grid
              </Button>
              <Button
                type="button"
                size="sm"
                variant={layoutMode === "canvas" ? "secondary" : "ghost"}
                className="h-7 gap-1.5"
                onClick={() => dash.setLayoutMode("canvas")}
                title="Free-form canvas"
              >
                <Move className="h-3.5 w-3.5" />
                Canvas
              </Button>
            </div>

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

            {mode === "edit" && (
              <Button size="sm" className="h-8" onClick={openAdd}>
                <Plus className="h-3.5 w-3.5" />
                Add widget
              </Button>
            )}
          </div>
        </div>

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

        {/* ── Render region (grid or free-form canvas) ────────────────── */}
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
          onAddWidget={openAdd}
        />

        <AddWidgetDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          sources={sourceOptions}
          getFields={sources.getFields}
          tableNameForId={engine.tableNameForId}
          initial={editing}
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
