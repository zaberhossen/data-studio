"use client";

/**
 * DashboardCanvas — orchestrates free-form (canvas) mode: owns the selection,
 * renders the toolbar + stage, and maps toolbar actions (add/style/z-order/
 * delete) onto the `useDashboard` callbacks. Loaded lazily (Moveable/Selecto are
 * client-only + heavy), so it never enters SSR or the initial bundle.
 */

import * as React from "react";
import type {
  CanvasConfig,
  CanvasElement,
  CanvasFrame,
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
import { readClipboard, writeClipboard } from "@/lib/dashboard/clipboard";
import { CanvasStage } from "./CanvasStage";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasViewport } from "./CanvasViewport";
import { CanvasLayersPanel } from "./CanvasLayersPanel";
import { CanvasPresent } from "./CanvasPresent";

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
  onDuplicateElement?: (id: string) => void;
  onAddFrame?: () => void;
  onUpdateFrame?: (id: string, patch: Partial<Omit<CanvasFrame, "id">>) => void;
  onRemoveFrame?: (id: string) => void;
  onUpdateCanvas?: (patch: Partial<Omit<CanvasConfig, "frames">>) => void;
  onEditWidget: (w: Widget) => void;
  onUpdateWidget?: (id: string, patch: Partial<Omit<Widget, "id">>) => void;
  onDuplicateWidget: (id: string) => void;
  onRemoveWidget: (id: string) => void;
  onSetItemFlags?: (id: string, patch: { locked?: boolean; hidden?: boolean }) => void;
  onPasteItems?: (payload: { widgets: Widget[]; elements: CanvasElement[] }) => string[];
  onGroup?: (ids: string[]) => string | null;
  onUngroup?: (ids: string[]) => void;
}

export function DashboardCanvas({
  dashboard,
  scheduler,
  editable,
  onApplyCanvasLayout,
  onAddElement,
  onUpdateElement,
  onRemoveElement,
  onDuplicateElement,
  onAddFrame,
  onUpdateFrame,
  onRemoveFrame,
  onUpdateCanvas,
  onEditWidget,
  onUpdateWidget,
  onDuplicateWidget,
  onRemoveWidget,
  onSetItemFlags,
  onPasteItems,
  onGroup,
  onUngroup,
}: DashboardCanvasProps) {
  const canvas = dashboard.canvas ?? DEFAULT_CANVAS;
  const widgets = dashboard.widgets;
  const elements = React.useMemo(() => dashboard.elements ?? [], [dashboard.elements]);
  const frames = React.useMemo(() => canvas.frames ?? [], [canvas.frames]);
  const frameIds = React.useMemo(() => new Set(frames.map((f) => f.id)), [frames]);

  // Gesture commits arrive keyed by id for items AND frames — split them here:
  // frame geometry lives inside the canvas config, item geometry on the items.
  const handleCommit = React.useCallback(
    (boxes: Record<string, CanvasLayout>) => {
      const itemBoxes: Record<string, CanvasLayout> = {};
      for (const [id, b] of Object.entries(boxes)) {
        if (frameIds.has(id)) onUpdateFrame?.(id, { x: b.x, y: b.y, w: b.w, h: b.h });
        else itemBoxes[id] = b;
      }
      if (Object.keys(itemBoxes).length) onApplyCanvasLayout(itemBoxes);
    },
    [frameIds, onUpdateFrame, onApplyCanvasLayout],
  );

  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);

  // Persisted groups: id → groupId, and groupId → all member ids. Selecting any
  // member selects the whole group (Figma-style), so gestures move them as one.
  const { groupOf, membersByGroup } = React.useMemo(() => {
    const groupOf = new Map<string, string>();
    const membersByGroup = new Map<string, string[]>();
    const note = (id: string, gid?: string) => {
      if (!gid) return;
      groupOf.set(id, gid);
      const arr = membersByGroup.get(gid);
      if (arr) arr.push(id);
      else membersByGroup.set(gid, [id]);
    };
    widgets.forEach((w) => note(w.id, w.canvasLayout?.groupId));
    elements.forEach((e) => note(e.id, e.canvasLayout.groupId));
    return { groupOf, membersByGroup };
  }, [widgets, elements]);

  // Grow a raw id set to include every sibling of any grouped member.
  const expandGroups = React.useCallback(
    (ids: string[]): string[] => {
      if (groupOf.size === 0) return ids;
      const out = new Set<string>();
      for (const id of ids) {
        const gid = groupOf.get(id);
        if (gid) membersByGroup.get(gid)?.forEach((m) => out.add(m));
        else out.add(id);
      }
      return out.size === ids.length ? ids : [...out];
    },
    [groupOf, membersByGroup],
  );

  // Selection entry point for user gestures (stage marquee/click + layers panel).
  const selectIds = React.useCallback(
    (ids: string[]) => setSelectedIds(expandGroups(ids)),
    [expandGroups],
  );

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

  const selectionHasGroup = selectedIds.some((id) => groupOf.has(id));
  const groupableCount = selectedIds.filter((id) => !frameIds.has(id)).length;

  const groupSelection = React.useCallback(() => {
    const ids = selectedIds.filter((id) => !frameIds.has(id));
    if (ids.length >= 2) onGroup?.(ids);
  }, [selectedIds, frameIds, onGroup]);

  const ungroupSelection = React.useCallback(() => {
    if (selectedIds.length) onUngroup?.(selectedIds);
  }, [selectedIds, onUngroup]);

  const deleteSelection = React.useCallback(() => {
    const elementIds = new Set(elements.map((e) => e.id));
    for (const id of selectedIds) {
      if (frameIds.has(id)) onRemoveFrame?.(id); // items on the frame stay
      else if (elementIds.has(id)) onRemoveElement(id);
      else onRemoveWidget(id);
    }
    setSelectedIds([]);
  }, [selectedIds, elements, frameIds, onRemoveFrame, onRemoveElement, onRemoveWidget]);

  // ── Clipboard (widgets + elements; frames are containers, never copied) ─────
  const copySelection = React.useCallback(() => {
    const widgetById = new Map(widgets.map((w) => [w.id, w]));
    const elementById = new Map(elements.map((e) => [e.id, e]));
    const cw = selectedIds.map((id) => widgetById.get(id)).filter((w): w is Widget => !!w);
    const ce = selectedIds
      .map((id) => elementById.get(id))
      .filter((e): e is CanvasElement => !!e);
    if (cw.length || ce.length) writeClipboard({ widgets: cw, elements: ce });
    return cw.length + ce.length > 0;
  }, [selectedIds, widgets, elements]);

  const pasteClipboard = React.useCallback(() => {
    const payload = readClipboard();
    if (!payload || !onPasteItems) return;
    const ids = onPasteItems(payload);
    if (ids.length) setSelectedIds(ids);
  }, [onPasteItems]);

  // Keyboard (edit mode, not while typing): Delete removes the selection,
  // arrows nudge it (Shift = 10px), ⌘/Ctrl+D duplicates it.
  React.useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      const mod = e.metaKey || e.ctrlKey;
      // Paste works with no selection, so handle it before the guard.
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        pasteClipboard();
        return;
      }

      if (selectedIds.length === 0) return;

      if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelection();
        return;
      }
      if (mod && e.key.toLowerCase() === "x") {
        e.preventDefault();
        if (copySelection()) deleteSelection();
        return;
      }

      if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const elementIds = new Set(elements.map((el) => el.id));
        for (const id of selectedIds) {
          if (frameIds.has(id)) continue; // frames aren't duplicated
          if (elementIds.has(id)) onDuplicateElement?.(id);
          else onDuplicateWidget(id);
        }
        return;
      }

      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const dir = nudge[e.key];
      if (dir) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const boxes: Record<string, CanvasLayout> = {};
        for (const id of selectedIds) {
          if (frameIds.has(id)) {
            const f = frames.find((fr) => fr.id === id);
            if (f) onUpdateFrame?.(id, { x: f.x + dir[0] * step, y: f.y + dir[1] * step });
            continue;
          }
          const b = boxOf(id);
          if (b) boxes[id] = { ...b, x: b.x + dir[0] * step, y: b.y + dir[1] * step };
        }
        if (Object.keys(boxes).length) onApplyCanvasLayout(boxes);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    editable,
    selectedIds,
    deleteSelection,
    copySelection,
    pasteClipboard,
    groupSelection,
    ungroupSelection,
    elements,
    frames,
    frameIds,
    boxOf,
    onDuplicateElement,
    onDuplicateWidget,
    onUpdateFrame,
    onApplyCanvasLayout,
  ]);

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

  // Full-screen presentation overlay.
  const [presenting, setPresenting] = React.useState(false);

  // Layers panel: rename dispatches by kind (frame name / widget title).
  const [showLayers, setShowLayers] = React.useState(false);
  const renameLayer = React.useCallback(
    (id: string, name: string) => {
      if (frameIds.has(id)) onUpdateFrame?.(id, { name });
      else onUpdateWidget?.(id, { title: name });
    },
    [frameIds, onUpdateFrame, onUpdateWidget],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {editable && (
        <CanvasToolbar
          selectionCount={selectedIds.length}
          element={soleElement}
          onAdd={onAddElement}
          onAddFrame={onAddFrame}
          onUpdateContent={updateContent}
          onAlign={align}
          onDistribute={distribute}
          onBringToFront={() => restack(true)}
          onSendToBack={() => restack(false)}
          onDelete={deleteSelection}
          canGroup={groupableCount >= 2}
          canUngroup={selectionHasGroup}
          onGroup={groupSelection}
          onUngroup={ungroupSelection}
          canvas={canvas}
          onUpdateCanvas={onUpdateCanvas}
          onPresent={() => setPresenting(true)}
          layersOpen={showLayers}
          onToggleLayers={() => setShowLayers((v) => !v)}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <CanvasViewport
          contentWidth={canvas.width}
          contentHeight={canvas.height}
          showRulers={editable && !!canvas.showRulers}
        >
          <CanvasStage
            widgets={widgets}
            elements={elements}
            frames={frames}
            canvas={canvas}
            scheduler={scheduler}
            editable={editable}
            selectedIds={selectedIds}
            onSelectedIdsChange={selectIds}
            onCommit={handleCommit}
            onEditWidget={onEditWidget}
            onDuplicateWidget={onDuplicateWidget}
            onRemoveWidget={onRemoveWidget}
            onUpdateElementContent={(id, content) => onUpdateElement(id, { content })}
            onRenameFrame={(id, name) => onUpdateFrame?.(id, { name })}
          />
        </CanvasViewport>
        {editable && showLayers && (
          <CanvasLayersPanel
            widgets={widgets}
            elements={elements}
            frames={frames}
            selectedIds={selectedIds}
            onSelect={selectIds}
            onToggleLock={(id, locked) => onSetItemFlags?.(id, { locked })}
            onToggleHidden={(id, hidden) => onSetItemFlags?.(id, { hidden })}
            onRename={renameLayer}
          />
        )}
      </div>

      {presenting && (
        <CanvasPresent
          widgets={widgets}
          elements={elements}
          frames={frames}
          canvas={canvas}
          scheduler={scheduler}
          onClose={() => setPresenting(false)}
        />
      )}
    </div>
  );
}

export default DashboardCanvas;
