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
import { GripVertical, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  CanvasElement,
  ElementContent,
  TextContent,
  Widget,
  WidgetLayout,
} from "@/lib/types/dashboard";
import type { QueryScheduler } from "@/hooks/useQueryScheduler";
import { GRID_COLS } from "@/hooks/useDashboard";
import { DashboardWidget } from "./DashboardWidget";

const ResponsiveGridLayout = WidthProvider(Responsive);

const BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 };
const COLS = { lg: GRID_COLS, md: GRID_COLS, sm: 6, xs: 4, xxs: 2 };
const ROW_HEIGHT = 40;

interface DashboardGridProps {
  widgets: Widget[];
  /** Decoration elements; only TEXT cards with a grid box render here. */
  elements?: CanvasElement[];
  scheduler: QueryScheduler;
  editable: boolean;
  onLayoutChange: (boxes: Record<string, WidgetLayout>) => void;
  onEditWidget: (widget: Widget) => void;
  onDuplicateWidget: (id: string) => void;
  onRemoveWidget: (id: string) => void;
  onUpdateElement?: (id: string, patch: { content?: ElementContent }) => void;
  onRemoveElement?: (id: string) => void;
}

export function DashboardGrid({
  widgets,
  elements = [],
  scheduler,
  editable,
  onLayoutChange,
  onEditWidget,
  onDuplicateWidget,
  onRemoveWidget,
  onUpdateElement,
  onRemoveElement,
}: DashboardGridProps) {
  const textCards = React.useMemo(
    () =>
      elements.filter(
        (e): e is CanvasElement & { layout: WidgetLayout } =>
          e.kind === "text" && Boolean(e.layout),
      ),
    [elements],
  );

  // The canonical (lg) layout — RGL generates the smaller breakpoints from it.
  const layouts = React.useMemo<ResponsiveLayouts>(
    () => ({
      lg: [
        ...widgets.map(
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
        ...textCards.map(
          (e): LayoutItem => ({
            i: e.id,
            x: e.layout.x,
            y: e.layout.y,
            w: e.layout.w,
            h: e.layout.h,
            minW: 2,
            minH: 1,
          }),
        ),
      ],
    }),
    [widgets, textCards],
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
      {[
        ...widgets.map((w) => (
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
        )),
        ...textCards.map((e) => (
          <div key={e.id} className="min-h-0">
            <GridTextCard
              element={e}
              editable={editable}
              onUpdate={onUpdateElement}
              onRemove={onRemoveElement}
            />
          </div>
        )),
      ]}
    </ResponsiveGridLayout>
  );
}

/**
 * GridTextCard — a Metabase-style text/heading card on the Page layout.
 * Borderless display; in edit mode a hover toolbar offers drag / edit / delete,
 * and editing swaps the body for a textarea committed on blur.
 */
function GridTextCard({
  element,
  editable,
  onUpdate,
  onRemove,
}: {
  element: CanvasElement;
  editable: boolean;
  onUpdate?: (id: string, patch: { content?: ElementContent }) => void;
  onRemove?: (id: string) => void;
}) {
  const content = element.content as TextContent;
  const [editing, setEditing] = React.useState(false);

  const commit = (text: string) => {
    setEditing(false);
    if (text !== content.text) onUpdate?.(element.id, { content: { ...content, text } });
  };

  return (
    <div className="group relative h-full overflow-hidden rounded-md">
      {editing ? (
        <textarea
          defaultValue={content.text}
          autoFocus
          aria-label="Text card content"
          className="h-full w-full resize-none rounded-md border border-strong bg-surface-100 p-2 text-sm outline-none focus:border-stronger"
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
          }}
        />
      ) : (
        <div
          className={cn(
            "h-full w-full overflow-hidden whitespace-pre-wrap p-2",
            content.bold && "font-semibold",
            content.italic && "italic",
          )}
          style={{
            fontSize: content.fontSize ?? 16,
            textAlign: content.align ?? "left",
            color: content.color,
          }}
          onDoubleClick={editable ? () => setEditing(true) : undefined}
        >
          {content.text || (editable ? "Double-click to edit…" : "")}
        </div>
      )}

      {editable && !editing && (
        <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <span
            className="widget-drag-handle cursor-grab rounded p-1 text-muted-foreground hover:text-foreground"
            title="Drag to move"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title="Edit text"
            aria-label="Edit text"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:text-destructive"
            title="Delete"
            aria-label="Delete text card"
            onClick={() => onRemove?.(element.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
