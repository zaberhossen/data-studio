import { describe, it, expect } from "vitest";
import { hasClipboard, readClipboard, writeClipboard } from "./clipboard";
import type { CanvasElement, Widget } from "@/lib/types/dashboard";

// In the node test env `window` is absent, so these exercise the in-memory
// mirror path (localStorage access throws and is swallowed).

const widget: Widget = {
  id: "w_1",
  title: "Chart",
  sourceId: "s1",
  queryKind: "sql",
  sql: "select 1",
  viz: { type: "bar" },
  layout: { x: 0, y: 0, w: 4, h: 4 },
  canvasLayout: { x: 10, y: 20, w: 300, h: 200 },
};

const element: CanvasElement = {
  id: "el_1",
  kind: "text",
  canvasLayout: { x: 5, y: 5, w: 100, h: 40 },
  content: { kind: "text", text: "hi" },
};

describe("canvas clipboard", () => {
  it("round-trips widgets + elements through the memory mirror", () => {
    writeClipboard({ widgets: [widget], elements: [element] });
    const read = readClipboard();
    expect(read).not.toBeNull();
    expect(read!.widgets).toHaveLength(1);
    expect(read!.widgets[0].id).toBe("w_1");
    expect(read!.elements[0].content).toMatchObject({ kind: "text", text: "hi" });
    expect(hasClipboard()).toBe(true);
  });

  it("hasClipboard is false for an empty payload", () => {
    writeClipboard({ widgets: [], elements: [] });
    expect(hasClipboard()).toBe(false);
  });
});
