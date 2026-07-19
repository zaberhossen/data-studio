import { describe, it, expect } from "vitest";
import { columnRef, spliceSnippet } from "./formula-insert";

describe("spliceSnippet", () => {
  it("inserts at a collapsed caret", () => {
    expect(spliceSnippet("a + b", 4, 4, "[c]")).toEqual({ text: "a + [c]b", caret: 7 });
  });

  it("replaces the selected range", () => {
    // select "b" (index 4..5) and replace with [cost]
    expect(spliceSnippet("a + b", 4, 5, "[cost]")).toEqual({ text: "a + [cost]", caret: 10 });
  });

  it("appends at the end", () => {
    const r = spliceSnippet("x", 1, 1, " + [y]");
    expect(r.text).toBe("x + [y]");
    expect(r.caret).toBe(7);
  });

  it("clamps out-of-range / inverted selections instead of throwing", () => {
    expect(spliceSnippet("abc", 99, 99, "Z")).toEqual({ text: "abcZ", caret: 4 });
    // inverted (end < start) is clamped so end >= start
    expect(spliceSnippet("abc", 2, 0, "Z")).toEqual({ text: "abZc", caret: 3 });
  });
});

describe("columnRef", () => {
  it("wraps a name in brackets verbatim", () => {
    expect(columnRef("revenue")).toBe("[revenue]");
    expect(columnRef("order date")).toBe("[order date]");
  });
});
