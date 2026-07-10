import { describe, it, expect } from "vitest";
import {
  CANVAS_ROW_H,
  defaultElement,
  ensureCanvasReady,
  gridToCanvas,
  isQueryWidget,
  nextCanvasY,
} from "./canvas";
import { GRID_COLS } from "./layout";
import { DEFAULT_CANVAS, type Dashboard, type Widget } from "@/lib/types/dashboard";

function widget(id: string, layout: Widget["layout"], canvasLayout?: Widget["canvasLayout"]): Widget {
  return {
    id,
    title: id,
    sourceId: "s1",
    queryKind: "sql",
    sql: "select 1",
    viz: { type: "bar" },
    layout,
    canvasLayout,
  };
}

describe("gridToCanvas", () => {
  it("projects grid columns/rows into pixels", () => {
    const canvasWidth = 1200;
    const colW = canvasWidth / GRID_COLS; // 100
    const box = gridToCanvas({ x: 2, y: 3, w: 6, h: 7 }, canvasWidth);
    expect(box).toEqual({
      x: Math.round(2 * colW),
      y: Math.round(3 * CANVAS_ROW_H),
      w: Math.round(6 * colW),
      h: Math.round(7 * CANVAS_ROW_H),
    });
  });
});

describe("ensureCanvasReady", () => {
  const base: Dashboard = {
    id: "d1",
    name: "D",
    widgets: [widget("w_1", { x: 0, y: 0, w: 6, h: 6 })],
    elements: [],
    layoutMode: "grid",
  };

  it("adds a canvas config + derives per-widget canvasLayout when missing", () => {
    const ready = ensureCanvasReady(base);
    expect(ready).not.toBe(base); // changed → new object
    expect(ready.canvas).toEqual(DEFAULT_CANVAS);
    expect(ready.widgets[0].canvasLayout).toEqual(
      gridToCanvas(base.widgets[0].layout, DEFAULT_CANVAS.width),
    );
  });

  it("is a no-op (same reference) when already canvas-ready", () => {
    const once = ensureCanvasReady(base);
    const twice = ensureCanvasReady(once);
    expect(twice).toBe(once);
  });
});

describe("nextCanvasY", () => {
  it("stacks new items below the lowest existing box", () => {
    const d: Dashboard = {
      id: "d",
      name: "d",
      widgets: [widget("w_1", { x: 0, y: 0, w: 4, h: 4 }, { x: 0, y: 100, w: 200, h: 150 })],
      elements: [{ id: "el_1", kind: "text", canvasLayout: { x: 0, y: 300, w: 200, h: 60 }, content: { kind: "text", text: "hi" } }],
      layoutMode: "canvas",
    };
    expect(nextCanvasY(d)).toBe(300 + 60 + 16);
  });

  it("falls back to a top margin on an empty canvas", () => {
    expect(nextCanvasY({ id: "d", name: "d", widgets: [], elements: [] })).toBe(24);
  });
});

describe("defaultElement", () => {
  it("makes a text element with a fresh id + placement", () => {
    const el = defaultElement("text", { x: 40, y: 80 });
    expect(el.kind).toBe("text");
    expect(el.content).toMatchObject({ kind: "text" });
    expect(el.canvasLayout).toMatchObject({ x: 40, y: 80 });
    expect(el.id.startsWith("el_")).toBe(true);
  });
});

describe("isQueryWidget", () => {
  it("treats a missing kind as query", () => {
    expect(isQueryWidget(widget("w_1", { x: 0, y: 0, w: 4, h: 4 }))).toBe(true);
  });
});
