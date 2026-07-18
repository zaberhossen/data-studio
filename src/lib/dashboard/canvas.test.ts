import { describe, it, expect } from "vitest";
import {
  CANVAS_ROW_H,
  defaultElement,
  defaultFrame,
  ensureCanvasReady,
  ensureGridReady,
  frameMemberIds,
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

describe("defaultFrame", () => {
  it("places the first frame at the origin margin, later ones to the right", () => {
    const first = defaultFrame([]);
    expect(first).toMatchObject({ x: 24, y: 24, name: "Frame 1" });
    expect(first.id.startsWith("fr_")).toBe(true);

    const second = defaultFrame([first]);
    expect(second.x).toBe(first.x + first.w + 48);
    expect(second.name).toBe("Frame 2");
  });
});

describe("frameMemberIds", () => {
  const frame = { x: 0, y: 0, w: 400, h: 400 };
  it("includes items whose center is inside; excludes the rest", () => {
    const inside = widget("w_in", { x: 0, y: 0, w: 4, h: 4 }, { x: 100, y: 100, w: 200, h: 200 });
    const straddling = widget("w_edge", { x: 0, y: 0, w: 4, h: 4 }, { x: 350, y: 0, w: 200, h: 100 }); // center x=450 → out
    const outside = widget("w_out", { x: 0, y: 0, w: 4, h: 4 }, { x: 500, y: 500, w: 100, h: 100 });
    const el = defaultElement("text", { x: 10, y: 10 });

    const ids = frameMemberIds(frame, {
      widgets: [inside, straddling, outside],
      elements: [el],
    });
    expect(ids).toContain("w_in");
    expect(ids).toContain(el.id);
    expect(ids).not.toContain("w_edge");
    expect(ids).not.toContain("w_out");
  });

  it("ignores widgets without a canvas box", () => {
    const noBox = widget("w_nobox", { x: 0, y: 0, w: 4, h: 4 });
    expect(frameMemberIds(frame, { widgets: [noBox], elements: [] })).toEqual([]);
  });
});

describe("ensureGridReady", () => {
  it("assigns grid boxes to text elements missing one, stacked below content", () => {
    const d: Dashboard = {
      id: "d",
      name: "d",
      widgets: [widget("w_1", { x: 0, y: 0, w: 6, h: 4 })],
      elements: [
        defaultElement("text", { x: 0, y: 0 }),
        defaultElement("shape", { x: 0, y: 0 }),
      ],
    };
    const ready = ensureGridReady(d);
    const [text, shape] = ready.elements!;
    expect(text.layout).toEqual({ x: 0, y: 4, w: 6, h: 2 });
    expect(shape.layout).toBeUndefined(); // non-text stays canvas-only
  });

  it("returns the same object when nothing is missing", () => {
    const d: Dashboard = { id: "d", name: "d", widgets: [], elements: [] };
    expect(ensureGridReady(d)).toBe(d);
  });
});
