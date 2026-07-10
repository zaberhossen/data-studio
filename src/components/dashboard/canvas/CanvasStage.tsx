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
  CanvasLayout,
  ElementContent,
  Widget,
} from "@/lib/types/dashboard";
import type { QueryScheduler } from "@/hooks/useQueryScheduler";
import { DashboardWidget } from "../DashboardWidget";
import { TextElement } from "./TextElement";
import { ImageElement } from "./ImageElement";
import { ShapeElement } from "./ShapeElement";
import { LineElement } from "./LineElement";

interface CanvasStageProps {
  widgets: Widget[];
  elements: CanvasElement[];
  canvas: CanvasConfig;
  scheduler: QueryScheduler;
  editable: boolean;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  onCommit: (boxes: Record<string, CanvasLayout>) => void;
  onEditWidget: (w: Widget) => void;
  onDuplicateWidget: (id: string) => void;
  onRemoveWidget: (id: string) => void;
  onUpdateElementContent: (id: string, content: ElementContent) => void;
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

  // Resolve selected ids → DOM targets, and everything-else → snap guidelines.
  React.useEffect(() => {
    if (!editable) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs derived DOM targets/guidelines to the editable prop
      setTargets([]);
      setGuidelines([]);
      return;
    }
    const sel = selectedIds
      .map((id) => nodes.current.get(id))
      .filter((n): n is HTMLElement => !!n);
    setTargets(sel);
    setGuidelines(
      allIds
        .filter((id) => !selectedIds.includes(id))
        .map((id) => nodes.current.get(id))
        .filter((n): n is HTMLElement => !!n),
    );
  }, [selectedIds, allIds, editable]);

  // The stage grows to fit the lowest item so dragging down is never clipped.
  const stageHeight = React.useMemo(() => {
    let bottom = canvas.height;
    for (const w of widgets) if (w.canvasLayout) bottom = Math.max(bottom, w.canvasLayout.y + w.canvasLayout.h);
    for (const e of elements) bottom = Math.max(bottom, e.canvasLayout.y + e.canvasLayout.h);
    return bottom + 80;
  }, [widgets, elements, canvas.height]);

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

  const items = (
    <>
      {widgets.map((w) => (
        <div
          key={w.id}
          ref={setNode(w.id)}
          data-cid={w.id}
          data-rotation={w.canvasLayout?.rotation ?? 0}
          className="canvas-item"
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
      {elements.map((e) => (
        <div
          key={e.id}
          ref={setNode(e.id)}
          data-cid={e.id}
          data-rotation={e.canvasLayout.rotation ?? 0}
          className="canvas-item rounded-md"
          style={boxStyle(e.canvasLayout)}
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
        </div>
      ))}
    </>
  );

  return (
    <div
      ref={stageRef}
      className="relative mx-auto rounded-lg border border-border bg-card/40 shadow-sm"
      style={{ width: canvas.width, height: stageHeight, background: canvas.background }}
    >
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
            rotatable
            snappable
            origin={false}
            throttleDrag={0}
            throttleResize={0}
            throttleRotate={0}
            snapThreshold={6}
            elementGuidelines={guidelines}
            snapDirections={{ top: true, left: true, bottom: true, right: true, center: true, middle: true }}
            elementSnapDirections={{ top: true, left: true, bottom: true, right: true, center: true, middle: true }}
            bounds={{ left: 0, top: 0, position: "css" }}
            onClickGroup={(e) => {
              selectoRef.current?.clickTarget(e.inputEvent, e.inputTarget);
            }}
            onDrag={(e: OnDrag) => {
              e.target.style.left = `${e.left}px`;
              e.target.style.top = `${e.top}px`;
            }}
            onDragEnd={(e) => {
              if (e.isDrag) commitOne(e.target);
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
