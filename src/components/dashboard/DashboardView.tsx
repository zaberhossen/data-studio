"use client";

/**
 * DashboardView — the reusable render region (grid OR free-form canvas) shared
 * by the authed panel and the public share page. It is display + optional
 * editing; it owns NO persistence and NO toolbar chrome. The public page renders
 * it read-only (`mode="view"`, no editing callbacks) over a snapshot scheduler;
 * the authed panel passes its real `useDashboard` callbacks.
 *
 * Grid vs canvas is chosen from `dashboard.layoutMode`; in canvas mode the stage
 * always renders (so elements exist even before any widget), while grid mode
 * shows the empty-state prompt.
 */

import * as React from "react";
import { LayoutDashboard, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  CanvasConfig,
  CanvasElement,
  CanvasFrame,
  CanvasLayout,
  Dashboard,
  ElementContent,
  Widget,
  WidgetLayout,
} from "@/lib/types/dashboard";
import type { QueryScheduler } from "@/hooks/useQueryScheduler";
import { itemsOnTab, resolveActiveTab } from "@/lib/dashboard/tabs";
import { DashboardGrid } from "./DashboardGrid";
import { DashboardCanvasLazy } from "./canvas/DashboardCanvasLazy";

const NOOP = () => {};

interface DashboardViewProps {
  dashboard: Dashboard;
  scheduler: QueryScheduler;
  mode: "view" | "edit";
  onEditWidget?: (w: Widget) => void;
  onDuplicateWidget?: (id: string) => void;
  onRemoveWidget?: (id: string) => void;
  onLayoutChange?: (boxes: Record<string, WidgetLayout>) => void;
  onApplyCanvasLayout?: (boxes: Record<string, CanvasLayout>) => void;
  onAddElement?: (kind: CanvasElement["kind"]) => void;
  onUpdateElement?: (id: string, patch: { canvasLayout?: CanvasLayout; content?: ElementContent }) => void;
  onRemoveElement?: (id: string) => void;
  onDuplicateElement?: (id: string) => void;
  onAddFrame?: () => void;
  onUpdateFrame?: (id: string, patch: Partial<Omit<CanvasFrame, "id">>) => void;
  onRemoveFrame?: (id: string) => void;
  onUpdateCanvas?: (patch: Partial<Omit<CanvasConfig, "frames">>) => void;
  onUpdateWidget?: (id: string, patch: Partial<Omit<Widget, "id">>) => void;
  onSetItemFlags?: (id: string, patch: { locked?: boolean; hidden?: boolean }) => void;
  onPasteItems?: (payload: { widgets: Widget[]; elements: CanvasElement[] }) => string[];
  onGroup?: (ids: string[]) => string | null;
  onUngroup?: (ids: string[]) => void;
  /** Active Page-view tab (grid mode only); null/undefined → show all. */
  activeTabId?: string | null;
  /** Empty-state "add widget" affordance (authed only). */
  onAddWidget?: () => void;
}

export function DashboardView({
  dashboard,
  scheduler,
  mode,
  onEditWidget = NOOP,
  onDuplicateWidget = NOOP,
  onRemoveWidget = NOOP,
  onLayoutChange = NOOP,
  onApplyCanvasLayout = NOOP,
  onAddElement = NOOP,
  onUpdateElement = NOOP,
  onRemoveElement = NOOP,
  onDuplicateElement,
  onAddFrame,
  onUpdateFrame,
  onRemoveFrame,
  onUpdateCanvas,
  onUpdateWidget,
  onSetItemFlags,
  onPasteItems,
  onGroup,
  onUngroup,
  activeTabId,
  onAddWidget,
}: DashboardViewProps) {
  const layoutMode = dashboard.layoutMode ?? "grid";
  const editable = mode === "edit";
  // Grid (Page) mode partitions by tab; canvas is one surface (tabs ignored).
  // Resolve to a valid tab (first when none chosen) so a caller that doesn't
  // track selection — e.g. the public view — never overlaps every tab at once.
  const effectiveTab =
    layoutMode === "grid" ? resolveActiveTab(dashboard.tabs, activeTabId ?? null) : null;
  const gridWidgets =
    layoutMode === "grid"
      ? itemsOnTab(dashboard.widgets, dashboard.tabs, effectiveTab)
      : dashboard.widgets;
  const gridElements =
    layoutMode === "grid"
      ? itemsOnTab(dashboard.elements ?? [], dashboard.tabs, effectiveTab)
      : dashboard.elements ?? [];
  const hasGridTextCards = gridElements.some((e) => e.kind === "text" && e.layout);
  const isEmpty = gridWidgets.length === 0 && !hasGridTextCards;
  const showEmptyState = layoutMode === "grid" && isEmpty;

  if (layoutMode === "canvas") {
    return (
      <div className="min-h-0 flex-1">
        <DashboardCanvasLazy
          dashboard={dashboard}
          scheduler={scheduler}
          editable={editable}
          onApplyCanvasLayout={onApplyCanvasLayout}
          onAddElement={onAddElement}
          onUpdateElement={onUpdateElement}
          onRemoveElement={onRemoveElement}
          onDuplicateElement={onDuplicateElement}
          onAddFrame={onAddFrame}
          onUpdateFrame={onUpdateFrame}
          onRemoveFrame={onRemoveFrame}
          onUpdateCanvas={onUpdateCanvas}
          onEditWidget={onEditWidget}
          onUpdateWidget={onUpdateWidget}
          onDuplicateWidget={onDuplicateWidget}
          onRemoveWidget={onRemoveWidget}
          onSetItemFlags={onSetItemFlags}
          onPasteItems={onPasteItems}
          onGroup={onGroup}
          onUngroup={onUngroup}
        />
      </div>
    );
  }

  return (
    <div className={cn("min-h-0 flex-1 overflow-auto p-4", showEmptyState && "grid place-items-center")}>
      {showEmptyState ? (
        <EmptyDashboard onAdd={onAddWidget} />
      ) : (
        <DashboardGrid
          widgets={gridWidgets}
          elements={gridElements}
          scheduler={scheduler}
          editable={editable}
          onLayoutChange={onLayoutChange}
          onEditWidget={onEditWidget}
          onDuplicateWidget={onDuplicateWidget}
          onRemoveWidget={onRemoveWidget}
          onUpdateElement={onUpdateElement}
          onRemoveElement={onRemoveElement}
        />
      )}
    </div>
  );
}

function EmptyDashboard({ onAdd }: { onAdd?: () => void }) {
  return (
    <div className="max-w-sm rounded-md border border-dashed border-border p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <LayoutDashboard className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="mt-4 text-sm font-medium">This dashboard is empty</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {onAdd ? "Add your first widget — pick a source, build a query, choose a chart." : "Nothing to show yet."}
      </p>
      {onAdd && (
        <Button size="sm" className="mt-4" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" />
          Add widget
        </Button>
      )}
    </div>
  );
}
