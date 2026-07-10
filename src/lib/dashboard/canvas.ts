/**
 * Canvas-mode geometry helpers, shared by the hook and the canvas components.
 *
 * Grid placement (`WidgetLayout`, in columns/rows) and canvas placement
 * (`CanvasLayout`, in px) coexist on a widget so switching modes is LOSSLESS.
 * The first time a dashboard enters canvas mode, each query widget's grid box is
 * projected into pixels here; from then on the two are edited independently.
 */

import {
  DEFAULT_CANVAS,
  type CanvasConfig,
  type CanvasElement,
  type CanvasLayout,
  type Dashboard,
  type ElementContent,
  type Widget,
  type WidgetLayout,
} from "@/lib/types/dashboard";
import { GRID_COLS } from "@/lib/dashboard/layout";
import { nextWidgetId } from "@/lib/dashboard/layout";

/** Grid row height in px — matches the react-grid-layout `rowHeight`. */
export const CANVAS_ROW_H = 40;

/** Project a grid box into an absolute pixel box for a canvas of `canvasWidth`. */
export function gridToCanvas(layout: WidgetLayout, canvasWidth: number): CanvasLayout {
  const colW = canvasWidth / GRID_COLS;
  return {
    x: Math.round(layout.x * colW),
    y: Math.round(layout.y * CANVAS_ROW_H),
    w: Math.round(layout.w * colW),
    h: Math.round(layout.h * CANVAS_ROW_H),
  };
}

/** A fresh element id (distinct prefix so it never collides with a widget id). */
export function nextElementId(): string {
  return nextWidgetId("el");
}

/** Default box + content for a newly-added element of `kind`. */
export function defaultElement(
  kind: CanvasElement["kind"],
  at: { x: number; y: number },
): CanvasElement {
  let size: { w: number; h: number };
  let content: ElementContent;
  switch (kind) {
    case "text":
      size = { w: 260, h: 64 };
      content = { kind: "text", text: "Text", fontSize: 16, align: "left" };
      break;
    case "image":
      size = { w: 280, h: 180 };
      content = { kind: "image", url: "", fit: "contain" };
      break;
    case "shape":
      size = { w: 160, h: 120 };
      content = { kind: "shape", shape: "rect" };
      break;
    default:
      size = { w: 240, h: 24 };
      content = { kind: "line", strokeWidth: 2 };
  }
  const canvasLayout: CanvasLayout = { x: at.x, y: at.y, ...size, zIndex: 1 };
  return { id: nextElementId(), kind, canvasLayout, content };
}

/**
 * Ensure the dashboard is ready for canvas mode: a `canvas` config exists and
 * every query widget has a `canvasLayout` (derived from its grid box when
 * missing). Returns the SAME object when nothing was missing (referential
 * stability for React), else a shallow-updated copy.
 */
export function ensureCanvasReady(dashboard: Dashboard): Dashboard {
  const canvas: CanvasConfig = dashboard.canvas ?? { ...DEFAULT_CANVAS };
  let touched = !dashboard.canvas;

  const widgets = dashboard.widgets.map((w) => {
    if (w.canvasLayout) return w;
    touched = true;
    return { ...w, canvasLayout: gridToCanvas(w.layout, canvas.width) };
  });

  if (!touched) return dashboard;
  return { ...dashboard, canvas, widgets };
}

/** The lowest empty y (px) below all current canvas items — where new items land. */
export function nextCanvasY(dashboard: Dashboard): number {
  const bottoms: number[] = [];
  for (const w of dashboard.widgets) {
    if (w.canvasLayout) bottoms.push(w.canvasLayout.y + w.canvasLayout.h);
  }
  for (const e of dashboard.elements ?? []) {
    bottoms.push(e.canvasLayout.y + e.canvasLayout.h);
  }
  return bottoms.length === 0 ? 24 : Math.max(...bottoms) + 16;
}

/** True when `w` should be laid out/scheduled as a query widget. */
export function isQueryWidget(w: Widget): boolean {
  return (w.kind ?? "query") === "query";
}
