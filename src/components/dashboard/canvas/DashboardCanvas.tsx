"use client";

/**
 * DashboardCanvas — orchestrates free-form (canvas) mode: owns the selection,
 * renders the toolbar + stage, and maps toolbar actions (add/style/z-order/
 * delete) onto the `useDashboard` callbacks. Loaded lazily (Moveable/Selecto are
 * client-only + heavy), so it never enters SSR or the initial bundle.
 */

import * as React from "react";
import type {
  CanvasElement,
  CanvasLayout,
  Dashboard,
  ElementContent,
  Widget,
} from "@/lib/types/dashboard";
import { DEFAULT_CANVAS } from "@/lib/types/dashboard";
import {
  alignBoxes,
  distributeBoxes,
  type AlignEdge,
  type BoxedItem,
  type DistributeAxis,
} from "@/lib/dashboard/align";
import type { QueryScheduler } from "@/hooks/useQueryScheduler";
import { CanvasStage } from "./CanvasStage";
import { CanvasToolbar } from "./CanvasToolbar";

interface DashboardCanvasProps {
  dashboard: Dashboard;
  scheduler: QueryScheduler;
  editable: boolean;
  onApplyCanvasLayout: (boxes: Record<string, CanvasLayout>) => void;
  onAddElement: (kind: CanvasElement["kind"]) => void;
  onUpdateElement: (
    id: string,
    patch: { canvasLayout?: CanvasLayout; content?: ElementContent },
  ) => void;
  onRemoveElement: (id: string) => void;
  onEditWidget: (w: Widget) => void;
  onDuplicateWidget: (id: string) => void;
  onRemoveWidget: (id: string) => void;
}

export function DashboardCanvas({
  dashboard,
  scheduler,
  editable,
  onApplyCanvasLayout,
  onAddElement,
  onUpdateElement,
  onRemoveElement,
  onEditWidget,
  onDuplicateWidget,
  onRemoveWidget,
}: DashboardCanvasProps) {
  const canvas = dashboard.canvas ?? DEFAULT_CANVAS;
  const widgets = dashboard.widgets;
  const elements = React.useMemo(() => dashboard.elements ?? [], [dashboard.elements]);

  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);

  // Drop any selected id that no longer exists; clear entirely in view mode.
  React.useEffect(() => {
    if (!editable) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears selection when leaving edit mode (syncs to editable prop)
      setSelectedIds([]);
      return;
    }
    setSelectedIds((ids) => {
      const live = new Set<string>([...widgets.map((w) => w.id), ...elements.map((e) => e.id)]);
      const next = ids.filter((id) => live.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [editable, widgets, elements]);

  // Current pixel box for any item id (widget or element).
  const boxOf = React.useCallback(
    (id: string): CanvasLayout | undefined => {
      const w = widgets.find((x) => x.id === id);
      if (w) return w.canvasLayout;
      return elements.find((x) => x.id === id)?.canvasLayout;
    },
    [widgets, elements],
  );

  const zRange = React.useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    const consider = (b?: CanvasLayout) => {
      const z = b?.zIndex ?? 1;
      if (z < min) min = z;
      if (z > max) max = z;
    };
    widgets.forEach((w) => consider(w.canvasLayout));
    elements.forEach((e) => consider(e.canvasLayout));
    return { min: Number.isFinite(min) ? min : 1, max: Number.isFinite(max) ? max : 1 };
  }, [widgets, elements]);

  const restack = (toFront: boolean) => {
    const boxes: Record<string, CanvasLayout> = {};
    const z = toFront ? zRange.max + 1 : zRange.min - 1;
    for (const id of selectedIds) {
      const b = boxOf(id);
      if (b) boxes[id] = { ...b, zIndex: z };
    }
    if (Object.keys(boxes).length) onApplyCanvasLayout(boxes);
  };

  const deleteSelection = React.useCallback(() => {
    const elementIds = new Set(elements.map((e) => e.id));
    for (const id of selectedIds) {
      if (elementIds.has(id)) onRemoveElement(id);
      else onRemoveWidget(id);
    }
    setSelectedIds([]);
  }, [selectedIds, elements, onRemoveElement, onRemoveWidget]);

  // Keyboard: Delete/Backspace removes the selection (unless typing in a field).
  React.useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (selectedIds.length > 0) {
        e.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, selectedIds, deleteSelection]);

  // The single selected element (drives its per-kind controls); null for 0 or ≥2.
  const soleElement: CanvasElement | null = React.useMemo(() => {
    if (selectedIds.length !== 1) return null;
    return elements.find((e) => e.id === selectedIds[0]) ?? null;
  }, [selectedIds, elements]);

  const updateContent = (content: ElementContent) => {
    if (soleElement) onUpdateElement(soleElement.id, { content });
  };

  // Boxes for the current selection, feeding align/distribute.
  const selectedBoxes = React.useCallback((): BoxedItem[] => {
    const out: BoxedItem[] = [];
    for (const id of selectedIds) {
      const b = boxOf(id);
      if (b) out.push({ id, box: b });
    }
    return out;
  }, [selectedIds, boxOf]);

  const align = (edge: AlignEdge) => {
    const boxes = alignBoxes(selectedBoxes(), edge);
    if (Object.keys(boxes).length) onApplyCanvasLayout(boxes);
  };
  const distribute = (axis: DistributeAxis) => {
    const boxes = distributeBoxes(selectedBoxes(), axis);
    if (Object.keys(boxes).length) onApplyCanvasLayout(boxes);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {editable && (
        <CanvasToolbar
          selectionCount={selectedIds.length}
          element={soleElement}
          onAdd={onAddElement}
          onUpdateContent={updateContent}
          onAlign={align}
          onDistribute={distribute}
          onBringToFront={() => restack(true)}
          onSendToBack={() => restack(false)}
          onDelete={deleteSelection}
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <CanvasStage
          widgets={widgets}
          elements={elements}
          canvas={canvas}
          scheduler={scheduler}
          editable={editable}
          selectedIds={selectedIds}
          onSelectedIdsChange={setSelectedIds}
          onCommit={onApplyCanvasLayout}
          onEditWidget={onEditWidget}
          onDuplicateWidget={onDuplicateWidget}
          onRemoveWidget={onRemoveWidget}
          onUpdateElementContent={(id, content) => onUpdateElement(id, { content })}
        />
      </div>
    </div>
  );
}

export default DashboardCanvas;
