"use client";

/**
 * CanvasStage — the free-form editing surface.
 *
 * Query widgets AND decoration elements are absolutely positioned (px) on a
 * fixed-size stage. In EDIT mode `react-selecto` handles marquee + click
 * selection and `react-moveable` handles drag / resize / rotate with snapping to
 * the other items; geometry is written straight to the DOM during interaction
 * (60 FPS, no React churn) and committed to the dashboard only on gesture end —
 * so, like the grid, moving a widget NEVER re-runs its query.
 *
 * In VIEW mode there is no Moveable/Selecto: widgets render fully interactive
 * and elements render static.
 */

import * as React from "react";
import Moveable, {
  type OnDrag,
  type OnResize,
  type OnRotate,
  type OnDragGroup,
  type OnResizeGroup,
  type OnRotateGroup,
} from "react-moveable";
import Selecto, { type OnSelectEnd, type OnDragStart } from "react-selecto";
import type {
  CanvasConfig,
  CanvasElement,
  CanvasFrame,
  CanvasLayout,
  ElementContent,
  Widget,
} from "@/lib/types/dashboard";
import { ImageDown } from "lucide-react";
import { DEFAULT_GRID_SIZE } from "@/lib/types/dashboard";
import type { QueryScheduler } from "@/hooks/useQueryScheduler";
import { cn } from "@/lib/utils";
import { frameMemberIds } from "@/lib/dashboard/canvas";
import { exportFrameToPng } from "@/lib/dashboard/export";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { DashboardWidget } from "../DashboardWidget";
import { TextElement } from "./TextElement";
import { ImageElement } from "./ImageElement";
import { ShapeElement } from "./ShapeElement";
import { LineElement } from "./LineElement";

interface CanvasStageProps {
  widgets: Widget[];
  elements: CanvasElement[];
  /** Artboards, rendered beneath the items; dragging one carries its members. */
  frames?: CanvasFrame[];
  canvas: CanvasConfig;
  scheduler: QueryScheduler;
  editable: boolean;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  /** Gesture-end geometry for items AND frames (the parent splits by id). */
  onCommit: (boxes: Record<string, CanvasLayout>) => void;
  onEditWidget: (w: Widget) => void;
  onDuplicateWidget: (id: string) => void;
  onRemoveWidget: (id: string) => void;
  onUpdateElementContent: (id: string, content: ElementContent) => void;
  onRenameFrame?: (id: string, name: string) => void;
}

function boxStyle(box: CanvasLayout): React.CSSProperties {
  return {
    position: "absolute",
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
    zIndex: box.zIndex ?? 1,
  };
}

/** Read the persisted box back off a DOM node after a Moveable gesture. */
function readBox(target: HTMLElement | SVGElement): CanvasLayout {
  const el = target as HTMLElement;
  const num = (v: string, fallback: number) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n) : fallback;
  };
  return {
    x: num(el.style.left, el.offsetLeft),
    y: num(el.style.top, el.offsetTop),
    w: num(el.style.width, el.offsetWidth),
    h: num(el.style.height, el.offsetHeight),
    rotation: Math.round(parseFloat(el.dataset.rotation ?? "0") || 0),
    zIndex: parseInt(el.style.zIndex || "1", 10) || 1,
  };
}

export function CanvasStage({
  widgets,
  elements,
  frames = [],
  canvas,
  scheduler,
  editable,
  selectedIds,
  onSelectedIdsChange,
  onCommit,
  onEditWidget,
  onDuplicateWidget,
  onRemoveWidget,
  onUpdateElementContent,
  onRenameFrame,
}: CanvasStageProps) {
  const stageRef = React.useRef<HTMLDivElement>(null);
  const moveableRef = React.useRef<Moveable>(null);
  const selectoRef = React.useRef<Selecto>(null);
  const nodes = React.useRef<Map<string, HTMLElement>>(new Map());

  const [targets, setTargets] = React.useState<Array<HTMLElement | SVGElement>>([]);
  const [guidelines, setGuidelines] = React.useState<HTMLElement[]>([]);

  const allIds = React.useMemo(
    () => [...widgets.map((w) => w.id), ...elements.map((e) => e.id)],
    [widgets, elements],
  );

  // Locked items are excluded from drag/resize even when selected (via panel).
  const lockedIds = React.useMemo(() => {
    const s = new Set<string>();
    widgets.forEach((w) => w.canvasLayout?.locked && s.add(w.id));
    elements.forEach((e) => e.canvasLayout.locked && s.add(e.id));
    frames.forEach((f) => f.locked && s.add(f.id));
    return s;
  }, [widgets, elements, frames]);

  // Resolve selected ids → DOM targets, and everything-else → snap guidelines.
  React.useEffect(() => {
    if (!editable) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs derived DOM targets/guidelines to the editable prop
      setTargets([]);
      setGuidelines([]);
      return;
    }
    const sel = selectedIds
      .filter((id) => !lockedIds.has(id)) // locked → shown selected, never dragged
      .map((id) => nodes.current.get(id))
      .filter((n): n is HTMLElement => !!n);
    setTargets(sel);
    setGuidelines(
      allIds
        .filter((id) => !selectedIds.includes(id))
        .map((id) => nodes.current.get(id))
        .filter((n): n is HTMLElement => !!n),
    );
  }, [selectedIds, allIds, editable, lockedIds]);

  // The stage grows to fit the lowest/rightmost content so gestures never clip.
  const stageHeight = React.useMemo(() => {
    let bottom = canvas.height;
    for (const w of widgets) if (w.canvasLayout) bottom = Math.max(bottom, w.canvasLayout.y + w.canvasLayout.h);
    for (const e of elements) bottom = Math.max(bottom, e.canvasLayout.y + e.canvasLayout.h);
    for (const f of frames) bottom = Math.max(bottom, f.y + f.h);
    return bottom + 80;
  }, [widgets, elements, frames, canvas.height]);

  const stageWidth = React.useMemo(() => {
    let right = canvas.width;
    for (const w of widgets) if (w.canvasLayout) right = Math.max(right, w.canvasLayout.x + w.canvasLayout.w);
    for (const e of elements) right = Math.max(right, e.canvasLayout.x + e.canvasLayout.w);
    for (const f of frames) right = Math.max(right, f.x + f.w);
    return right + 80;
  }, [widgets, elements, frames, canvas.width]);

  // Frame drag: members (center inside the frame at gesture start) ride along.
  const frameDrag = React.useRef<{
    frameId: string;
    startX: number;
    startY: number;
    members: Array<{ el: HTMLElement; x: number; y: number }>;
  } | null>(null);

  const frameIds = React.useMemo(() => new Set(frames.map((f) => f.id)), [frames]);
  const selectionHasFrame = selectedIds.some((id) => frameIds.has(id));

  // Alignment grid: overlay painting + Moveable snap. Snapping to the grid only
  // makes sense in edit mode; the overlay likewise renders only while editing.
  const gridSize = Math.max(2, canvas.gridSize ?? DEFAULT_GRID_SIZE);
  const showGrid = editable && !!canvas.showGrid;
  const snapToGrid = editable && !!canvas.snapToGrid;

  const commitOne = React.useCallback(
    (target: HTMLElement | SVGElement) => {
      const id = (target as HTMLElement).dataset.cid;
      if (id) onCommit({ [id]: readBox(target) });
    },
    [onCommit],
  );

  const commitMany = React.useCallback(
    (ts: Array<HTMLElement | SVGElement>) => {
      const boxes: Record<string, CanvasLayout> = {};
      for (const t of ts) {
        const id = (t as HTMLElement).dataset.cid;
        if (id) boxes[id] = readBox(t);
      }
      onCommit(boxes);
    },
    [onCommit],
  );

  const setNode = (id: string) => (el: HTMLDivElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  };

  // Per-frame PNG: rasterize the whole stage once, cropped to the frame's box.
  const exportFrame = React.useCallback((f: CanvasFrame) => {
    const stage = stageRef.current;
    if (!stage) return;
    void exportFrameToPng(stage, { x: f.x, y: f.y, w: f.w, h: f.h }, f.name).catch(() => {
      // Best-effort; a failed capture shouldn't break the canvas.
    });
  }, []);

  const frameNodes = (
    <>
      {frames.filter((f) => !f.hidden).map((f) => (
        <div
          key={f.id}
          ref={setNode(f.id)}
          data-cid={f.id}
          data-rotation="0"
          className="canvas-frame group/frame absolute rounded-md border border-strong shadow-sm"
          style={{
            left: f.x,
            top: f.y,
            width: f.w,
            height: f.h,
            zIndex: 0,
            background: f.background ?? "hsl(var(--card))",
          }}
        >
          <FrameLabel
            name={f.name}
            editable={editable}
            onSelect={() => onSelectedIdsChange([f.id])}
            onRename={(name) => onRenameFrame?.(f.id, name)}
            onExport={() => exportFrame(f)}
          />
        </div>
      ))}
    </>
  );

  const items = (
    <>
      {widgets.filter((w) => !w.canvasLayout?.hidden).map((w) => (
        <div
          key={w.id}
          ref={setNode(w.id)}
          data-cid={w.id}
          data-rotation={w.canvasLayout?.rotation ?? 0}
          // Locked items drop the `.canvas-item` hook so Selecto never grabs them.
          className={w.canvasLayout?.locked ? "canvas-item-locked" : "canvas-item"}
          style={boxStyle(w.canvasLayout ?? { x: 0, y: 0, w: 320, h: 240 })}
        >
          <DashboardWidget
            widget={w}
            scheduler={scheduler}
            editable={false}
            onEdit={onEditWidget}
            onDuplicate={onDuplicateWidget}
            onRemove={onRemoveWidget}
          />
        </div>
      ))}
      {elements.filter((e) => !e.canvasLayout.hidden).map((e) => (
        <div
          key={e.id}
          ref={setNode(e.id)}
          data-cid={e.id}
          data-rotation={e.canvasLayout.rotation ?? 0}
          className={cn(
            "rounded-md",
            e.canvasLayout.locked ? "canvas-item-locked" : "canvas-item",
          )}
          style={boxStyle(e.canvasLayout)}
        >
          <ErrorBoundary
            resetKeys={[e.content]}
            fallback={() => (
              <div className="flex h-full w-full items-center justify-center rounded-md border border-destructive/40 bg-destructive/5 p-1 text-center text-[10px] text-destructive/80">
                Element failed to render
              </div>
            )}
          >
            {e.content.kind === "text" ? (
              <TextElement
                content={e.content}
                editable={editable}
                onChange={(c) => onUpdateElementContent(e.id, c)}
              />
            ) : e.content.kind === "image" ? (
              <ImageElement content={e.content} editable={editable} />
            ) : e.content.kind === "shape" ? (
              <ShapeElement content={e.content} />
            ) : (
              <LineElement content={e.content} />
            )}
          </ErrorBoundary>
        </div>
      ))}
    </>
  );

  return (
    <div
      ref={stageRef}
      className="relative rounded-lg border border-border bg-card/40 shadow-sm"
      style={{ width: stageWidth, height: stageHeight, background: canvas.background }}
    >
      {showGrid && (
        <div
          aria-hidden
          data-export-ignore
          className="pointer-events-none absolute inset-0"
          style={{
            zIndex: 0,
            backgroundImage:
              "linear-gradient(to right, hsl(var(--border)) 1px, transparent 1px)," +
              "linear-gradient(to bottom, hsl(var(--border)) 1px, transparent 1px)",
            backgroundSize: `${gridSize}px ${gridSize}px`,
            opacity: 0.5,
          }}
        />
      )}
      {frameNodes}
      {items}

      {editable && (
        <>
          <Selecto
            ref={selectoRef}
            // eslint-disable-next-line react-hooks/refs -- Selecto needs the stage DOM node as its drag container; safe since it renders inside that same element
            dragContainer={stageRef.current ?? undefined}
            selectableTargets={[".canvas-item"]}
            hitRate={0}
            selectByClick
            selectFromInside={false}
            toggleContinueSelect={["shift"]}
            onDragStart={(e: OnDragStart) => {
              const moveable = moveableRef.current;
              const target = e.inputEvent.target as HTMLElement;
              if (
                moveable?.isMoveableElement(target) ||
                // Frame labels select/rename the frame — never start a marquee.
                target.closest(".frame-label") ||
                targets.some((t) => t === target || (t as HTMLElement).contains(target))
              ) {
                e.stop();
              }
            }}
            onSelectEnd={(e: OnSelectEnd) => {
              const ids = e.selected
                .map((el) => (el as HTMLElement).dataset.cid)
                .filter((id): id is string => !!id);
              onSelectedIdsChange(ids);
              if (e.isDragStart) {
                const moveable = moveableRef.current;
                e.inputEvent.preventDefault();
                window.requestAnimationFrame(() => {
                  moveable?.dragStart(e.inputEvent);
                });
              }
            }}
          />
          <Moveable
            ref={moveableRef}
            target={targets}
            draggable
            resizable
            rotatable={!selectionHasFrame}
            snappable
            origin={false}
            throttleDrag={0}
            throttleResize={0}
            throttleRotate={0}
            snapThreshold={6}
            snapGridWidth={snapToGrid ? gridSize : undefined}
            snapGridHeight={snapToGrid ? gridSize : undefined}
            elementGuidelines={guidelines}
            snapDirections={{ top: true, left: true, bottom: true, right: true, center: true, middle: true }}
            elementSnapDirections={{ top: true, left: true, bottom: true, right: true, center: true, middle: true }}
            bounds={{ left: 0, top: 0, position: "css" }}
            onClickGroup={(e) => {
              selectoRef.current?.clickTarget(e.inputEvent, e.inputTarget);
            }}
            onDragStart={(e) => {
              // Dragging a FRAME carries its members (captured at gesture start).
              const id = (e.target as HTMLElement).dataset.cid;
              const frame = id ? frames.find((f) => f.id === id) : undefined;
              if (!frame) {
                frameDrag.current = null;
                return;
              }
              const members = frameMemberIds(frame, { widgets, elements })
                .map((mid) => nodes.current.get(mid))
                .filter((n): n is HTMLElement => !!n)
                .map((el) => ({
                  el,
                  x: parseFloat(el.style.left) || 0,
                  y: parseFloat(el.style.top) || 0,
                }));
              frameDrag.current = { frameId: frame.id, startX: frame.x, startY: frame.y, members };
            }}
            onDrag={(e: OnDrag) => {
              e.target.style.left = `${e.left}px`;
              e.target.style.top = `${e.top}px`;
              const fd = frameDrag.current;
              if (fd && (e.target as HTMLElement).dataset.cid === fd.frameId) {
                const dx = e.left - fd.startX;
                const dy = e.top - fd.startY;
                for (const m of fd.members) {
                  m.el.style.left = `${m.x + dx}px`;
                  m.el.style.top = `${m.y + dy}px`;
                }
              }
            }}
            onDragEnd={(e) => {
              const fd = frameDrag.current;
              frameDrag.current = null;
              if (!e.isDrag) return;
              if (fd) commitMany([e.target, ...fd.members.map((m) => m.el)]);
              else commitOne(e.target);
            }}
            onResize={(e: OnResize) => {
              e.target.style.width = `${e.width}px`;
              e.target.style.height = `${e.height}px`;
              if (e.drag) {
                e.target.style.left = `${e.drag.left}px`;
                e.target.style.top = `${e.drag.top}px`;
              }
            }}
            onResizeEnd={(e) => {
              if (e.isDrag) commitOne(e.target);
            }}
            onRotate={(e: OnRotate) => {
              (e.target as HTMLElement).dataset.rotation = String(Math.round(e.rotation));
              e.target.style.transform = `rotate(${e.rotation}deg)`;
              if (e.drag) {
                e.target.style.left = `${e.drag.left}px`;
                e.target.style.top = `${e.drag.top}px`;
              }
            }}
            onRotateEnd={(e) => commitOne(e.target)}
            onDragGroup={(e: OnDragGroup) => {
              for (const ev of e.events) {
                ev.target.style.left = `${ev.left}px`;
                ev.target.style.top = `${ev.top}px`;
              }
            }}
            onDragGroupEnd={(e) => {
              if (e.isDrag) commitMany(e.targets);
            }}
            onResizeGroup={(e: OnResizeGroup) => {
              for (const ev of e.events) {
                ev.target.style.width = `${ev.width}px`;
                ev.target.style.height = `${ev.height}px`;
                if (ev.drag) {
                  ev.target.style.left = `${ev.drag.left}px`;
                  ev.target.style.top = `${ev.drag.top}px`;
                }
              }
            }}
            onResizeGroupEnd={(e) => {
              if (e.isDrag) commitMany(e.targets);
            }}
            onRotateGroup={(e: OnRotateGroup) => {
              for (const ev of e.events) {
                (ev.target as HTMLElement).dataset.rotation = String(Math.round(ev.rotation));
                ev.target.style.transform = ev.drag
                  ? `${ev.drag.transform}`
                  : `rotate(${ev.rotation}deg)`;
              }
            }}
            onRotateGroupEnd={(e) => commitMany(e.targets)}
          />
        </>
      )}
    </div>
  );
}

/**
 * FrameLabel — the name tab above a frame. Click selects the frame (making it
 * draggable/resizable via Moveable); double-click renames inline. Marked with
 * `.frame-label` so Selecto never starts a marquee from it.
 */
function FrameLabel({
  name,
  editable,
  onSelect,
  onRename,
  onExport,
}: {
  name: string;
  editable: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onExport: () => void;
}) {
  const [renaming, setRenaming] = React.useState(false);

  if (!editable) {
    return (
      <span className="frame-label absolute -top-6 left-0 max-w-full truncate text-xs font-medium text-muted-foreground">
        {name}
      </span>
    );
  }

  if (renaming) {
    return (
      <input
        defaultValue={name}
        autoFocus
        aria-label="Frame name"
        className="frame-label absolute -top-6 left-0 w-40 rounded border border-strong bg-surface-100 px-1 text-xs outline-none"
        onBlur={(e) => {
          setRenaming(false);
          const next = e.target.value.trim();
          if (next && next !== name) onRename(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
        }}
      />
    );
  }

  return (
    <div className="frame-label absolute -top-6 left-0 flex max-w-full items-center gap-1">
      <button
        type="button"
        className="cursor-pointer truncate text-xs font-medium text-muted-foreground hover:text-foreground"
        title="Click to select the frame; double-click to rename"
        onClick={onSelect}
        onDoubleClick={() => setRenaming(true)}
      >
        {name}
      </button>
      <button
        type="button"
        // Kept out of the raster; opacity-reveal on hover keeps the tab clean.
        data-export-ignore
        className="shrink-0 rounded p-0.5 text-muted-foreground/70 opacity-0 hover:text-foreground group-hover/frame:opacity-100"
        aria-label="Export frame as PNG"
        title="Export frame as PNG"
        onClick={onExport}
      >
        <ImageDown className="h-3 w-3" />
      </button>
    </div>
  );
}
