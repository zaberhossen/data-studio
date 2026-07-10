import { describe, it, expect } from "vitest";
import { coerceCell, parseDelimited, extractJsonRows, parseBody, inferColumns } from "./http";

describe("coerceCell", () => {
  it("coerces numbers/bools/blank, keeps leading-zero + plain strings", () => {
    expect(coerceCell(" 42 ")).toBe(42);
    expect(coerceCell("3.14")).toBe(3.14);
    expect(coerceCell("true")).toBe(true);
    expect(coerceCell("")).toBeNull();
    expect(coerceCell("007")).toBe("007"); // zip-like, kept as string
    expect(coerceCell("hello")).toBe("hello");
  });
});

describe("parseDelimited", () => {
  it("parses a header + quoted fields with embedded commas/quotes", () => {
    const csv = 'name,amount,note\n"Doe, John",100,"say ""hi"""\nJane,,plain\n';
    const rows = parseDelimited(csv);
    expect(rows).toEqual([
      { name: "Doe, John", amount: 100, note: 'say "hi"' },
      { name: "Jane", amount: null, note: "plain" },
    ]);
  });
});

describe("extractJsonRows", () => {
  it("handles arrays, wrapper objects, and single objects", () => {
    expect(extractJsonRows([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(extractJsonRows({ data: [{ a: 1 }, { a: 2 }] })).toEqual([{ a: 1 }, { a: 2 }]);
    expect(extractJsonRows({ a: 1 })).toEqual([{ a: 1 }]);
    expect(extractJsonRows(42)).toEqual([]);
  });
});

describe("parseBody", () => {
  it("routes to JSON on content-type or a leading brace, else CSV", () => {
    expect(parseBody('[{"x":1}]', "application/json")).toEqual([{ x: 1 }]);
    expect(parseBody('  [{"x":1}]', "text/plain")).toEqual([{ x: 1 }]); // sniffed
    expect(parseBody("x\n1\n", "text/csv")).toEqual([{ x: 1 }]);
  });
});

describe("inferColumns", () => {
  it("infers number/bool/date/string from a sample", () => {
    const cols = inferColumns([
      { n: 1, b: true, d: "2024-01-02", s: "hi" },
      { n: 2, b: false, d: "2024-02-03", s: "yo" },
    ]);
    expect(cols).toEqual([
      { name: "n", type: "number" },
      { name: "b", type: "bool" },
      { name: "d", type: "date" },
      { name: "s", type: "string" },
    ]);
  });
});
