/**
 * Align + distribute geometry for canvas selections — pure functions over boxes
 * so they're unit-testable and reused by the canvas toolbar. Each returns a
 * `{ id → CanvasLayout }` patch (only the moved items), ready for
 * `applyCanvasLayout`.
 */

import type { CanvasLayout } from "@/lib/types/dashboard";

export interface BoxedItem {
  id: string;
  box: CanvasLayout;
}

export type AlignEdge = "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom";
export type DistributeAxis = "h" | "v";

/** Align every item to the selection's bounding box on `edge`. Needs ≥ 2 items. */
export function alignBoxes(items: BoxedItem[], edge: AlignEdge): Record<string, CanvasLayout> {
  if (items.length < 2) return {};
  const minX = Math.min(...items.map((i) => i.box.x));
  const maxRight = Math.max(...items.map((i) => i.box.x + i.box.w));
  const minY = Math.min(...items.map((i) => i.box.y));
  const maxBottom = Math.max(...items.map((i) => i.box.y + i.box.h));
  const cx = (minX + maxRight) / 2;
  const cy = (minY + maxBottom) / 2;

  const out: Record<string, CanvasLayout> = {};
  for (const { id, box } of items) {
    let { x, y } = box;
    switch (edge) {
      case "left":
        x = minX;
        break;
      case "hcenter":
        x = Math.round(cx - box.w / 2);
        break;
      case "right":
        x = maxRight - box.w;
        break;
      case "top":
        y = minY;
        break;
      case "vmiddle":
        y = Math.round(cy - box.h / 2);
        break;
      case "bottom":
        y = maxBottom - box.h;
        break;
    }
    if (x !== box.x || y !== box.y) out[id] = { ...box, x, y };
  }
  return out;
}

/**
 * Distribute items so the GAPS between them are equal along `axis`, keeping the
 * two extremes fixed. Needs ≥ 3 items (fewer has no interior gap to balance).
 */
export function distributeBoxes(items: BoxedItem[], axis: DistributeAxis): Record<string, CanvasLayout> {
  if (items.length < 3) return {};
  const size = (b: CanvasLayout) => (axis === "h" ? b.w : b.h);
  const start = (b: CanvasLayout) => (axis === "h" ? b.x : b.y);

  const sorted = [...items].sort((a, b) => start(a.box) - start(b.box));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = start(last.box) + size(last.box) - start(first.box);
  const totalSize = sorted.reduce((sum, i) => sum + size(i.box), 0);
  const gap = (span - totalSize) / (sorted.length - 1);

  const out: Record<string, CanvasLayout> = {};
  let cursor = start(first.box);
  for (const { id, box } of sorted) {
    const pos = Math.round(cursor);
    const moved = axis === "h" ? { ...box, x: pos } : { ...box, y: pos };
    if ((axis === "h" ? box.x : box.y) !== pos) out[id] = moved;
    cursor += size(box) + gap;
  }
  return out;
}
