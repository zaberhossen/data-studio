import { describe, it, expect } from "vitest";
import { alignBoxes, distributeBoxes, type BoxedItem } from "./align";
import type { CanvasLayout } from "@/lib/types/dashboard";

const b = (id: string, x: number, y: number, w = 100, h = 50): BoxedItem => ({
  id,
  box: { x, y, w, h },
});

describe("alignBoxes", () => {
  const items = [b("a", 0, 0, 100, 50), b("c", 200, 100, 60, 80)];

  it("aligns left to the min x", () => {
    const out = alignBoxes(items, "left");
    expect(out.c.x).toBe(0);
    expect(out.a).toBeUndefined(); // already at min → not moved
  });

  it("aligns right to the max right edge", () => {
    const out = alignBoxes(items, "right");
    // maxRight = 260 → a.x = 260 - 100 = 160 ; c already ends at 260
    expect(out.a.x).toBe(160);
    expect(out.c).toBeUndefined();
  });

  it("aligns horizontal center to the selection center", () => {
    const out = alignBoxes(items, "hcenter");
    // bbox x:[0,260] center 130 ; a.x = 130-50=80 ; c.x = 130-30=100
    expect(out.a.x).toBe(80);
    expect(out.c.x).toBe(100);
  });

  it("returns nothing for a single item", () => {
    expect(alignBoxes([b("a", 0, 0)], "left")).toEqual({});
  });
});

describe("distributeBoxes", () => {
  it("equalizes horizontal gaps, keeping extremes fixed", () => {
    // three 100-wide boxes across span 0..500 → total 300, gap = (500-300)/2 = 100
    const items = [b("a", 0, 0, 100, 50), b("b", 120, 0, 100, 50), b("c", 400, 0, 100, 50)];
    const out = distributeBoxes(items, "h");
    // a stays 0 ; b → 0+100+100 = 200 ; c stays 400
    expect(out.b.x).toBe(200);
    expect(out.a).toBeUndefined();
    expect(out.c).toBeUndefined();
  });

  it("needs at least three items", () => {
    expect(distributeBoxes([b("a", 0, 0), b("b", 100, 0)], "h")).toEqual({});
  });

  it("distributes vertically by the y axis", () => {
    const items = [b("a", 0, 0, 100, 50), b("b", 0, 60, 100, 50), b("c", 0, 300, 100, 50)];
    const out = distributeBoxes(items, "v");
    // span 0..350, total h 150, gap = (350-150)/2 = 100 → b.y = 0+50+100 = 150
    expect(out.b.y).toBe(150);
  });
});

describe("distribute is order-independent", () => {
  it("sorts by position before spacing", () => {
    const shuffled = [b("c", 400, 0, 100, 50), b("a", 0, 0, 100, 50), b("b", 120, 0, 100, 50)];
    const out = distributeBoxes(shuffled, "h");
    const bBox = out.b as CanvasLayout;
    expect(bBox.x).toBe(200);
  });
});
