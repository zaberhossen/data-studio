"use client";

/**
 * DashboardGrid — the draggable/resizable canvas.
 *
 * Wraps react-grid-layout's Responsive + WidthProvider so widgets reflow across
 * breakpoints. In EDIT mode drag + resize are enabled (via the widget header as
 * the drag handle); in VIEW mode they're off and only in-widget interaction
 * remains.
 *
 * PERFORMANCE CONTRACT: layout changes here NEVER trigger a query. The grid only
 * reports new (x,y,w,h) boxes to the dashboard, which updates each widget's
 * `layout`. A widget re-queries solely when its source/query/sql changes (the
 * scheduler keys on those), so dragging/resizing stays at 60 FPS — the heavy
 * work lives in the workers and is untouched during interaction. Charts use
 * Recharts' ResponsiveContainer, so they reflow on resize WITHOUT re-querying.
 */

import * as React from "react";
import {
  Responsive,
  WidthProvider,
  type Layout,
  type LayoutItem,
  type ResponsiveLayouts,
} from "react-grid-layout/legacy";
import "react-grid-layout/css/styles.css";
import type { Widget, WidgetLayout } from "@/lib/types/dashboard";
import type { QueryScheduler } from "@/hooks/useQueryScheduler";
import { GRID_COLS } from "@/hooks/useDashboard";
import { DashboardWidget } from "./DashboardWidget";

const ResponsiveGridLayout = WidthProvider(Responsive);

const BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 };
const COLS = { lg: GRID_COLS, md: GRID_COLS, sm: 6, xs: 4, xxs: 2 };
const ROW_HEIGHT = 40;

interface DashboardGridProps {
  widgets: Widget[];
  scheduler: QueryScheduler;
  editable: boolean;
  onLayoutChange: (boxes: Record<string, WidgetLayout>) => void;
  onEditWidget: (widget: Widget) => void;
  onDuplicateWidget: (id: string) => void;
  onRemoveWidget: (id: string) => void;
}

export function DashboardGrid({
  widgets,
  scheduler,
  editable,
  onLayoutChange,
  onEditWidget,
  onDuplicateWidget,
  onRemoveWidget,
}: DashboardGridProps) {
  // The canonical (lg) layout — RGL generates the smaller breakpoints from it.
  const layouts = React.useMemo<ResponsiveLayouts>(
    () => ({
      lg: widgets.map(
        (w): LayoutItem => ({
          i: w.id,
          x: w.layout.x,
          y: w.layout.y,
          w: w.layout.w,
          h: w.layout.h,
          minW: 2,
          minH: 3,
        }),
      ),
    }),
    [widgets],
  );

  const handleLayoutChange = React.useCallback(
    (current: Layout, all: ResponsiveLayouts) => {
      const source = all.lg ?? current;
      const boxes: Record<string, WidgetLayout> = {};
      for (const l of source) {
        boxes[l.i] = { x: l.x, y: l.y, w: l.w, h: l.h };
      }
      onLayoutChange(boxes);
    },
    [onLayoutChange],
  );

  return (
    <ResponsiveGridLayout
      className="layout"
      layouts={layouts}
      breakpoints={BREAKPOINTS}
      cols={COLS}
      rowHeight={ROW_HEIGHT}
      margin={[12, 12]}
      containerPadding={[0, 0]}
      isDraggable={editable}
      isResizable={editable}
      draggableHandle=".widget-drag-handle"
      compactType="vertical"
      onLayoutChange={handleLayoutChange}
      useCSSTransforms
    >
      {widgets.map((w) => (
        <div key={w.id} className="min-h-0">
          <DashboardWidget
            widget={w}
            scheduler={scheduler}
            editable={editable}
            onEdit={onEditWidget}
            onDuplicate={onDuplicateWidget}
            onRemove={onRemoveWidget}
          />
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
