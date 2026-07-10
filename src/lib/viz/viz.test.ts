import { describe, it, expect } from "vitest";
import { resultTableToChartData, categoryValues, singleValue, CATEGORY_KEY } from "./chart-data";
import { makeNumberFormatter, conditionalColor } from "./format";
import { STATUS } from "./palette";
import type { ResultTable } from "@/lib/types/results";
import type { WidgetViz } from "@/lib/types/query";

function table(): ResultTable {
  return {
    columns: [
      { name: "month", type: "string" },
      { name: "revenue", type: "number" },
      { name: "cost", type: "number" },
    ],
    rows: [
      ["Jan", 120, 80],
      ["Feb", 150, 90],
    ],
    page: 0,
    pageSize: 2,
    totalRows: 2,
    source: "sql",
  };
}

describe("resultTableToChartData", () => {
  it("defaults x to the first column and series to every other numeric column", () => {
    const d = resultTableToChartData(table(), { type: "bar" });
    expect(d.categoryLabel).toBe("month");
    expect(d.series.map((s) => s.key)).toEqual(["revenue", "cost"]);
    expect(d.rows[0]).toEqual({ [CATEGORY_KEY]: "Jan", revenue: 120, cost: 80 });
  });

  it("honors explicit yKeys (order + subset)", () => {
    const viz: WidgetViz = { type: "bar", xKey: "month", yKeys: ["cost"] };
    const d = resultTableToChartData(table(), viz);
    expect(d.series.map((s) => s.key)).toEqual(["cost"]);
    expect(d.rows[1]).toEqual({ [CATEGORY_KEY]: "Feb", cost: 90 });
  });

  it("coerces non-finite measures to null and missing category to a placeholder", () => {
    const t = table();
    t.rows = [[null, "oops", 5]];
    const d = resultTableToChartData(t, { type: "line" });
    expect(d.rows[0][CATEGORY_KEY]).toBe("∅");
    expect(d.rows[0].revenue).toBeNull();
    expect(d.rows[0].cost).toBe(5);
  });
});

describe("categoryValues", () => {
  it("defaults label to the first non-numeric column and value to the first numeric", () => {
    const rows = categoryValues(table(), { type: "funnel" });
    expect(rows).toEqual([
      { label: "Jan", value: 120 },
      { label: "Feb", value: 150 },
    ]);
  });

  it("honors a preferred label column (map region key) and explicit yKey", () => {
    const rows = categoryValues(table(), { type: "map", yKey: "cost" }, "month");
    expect(rows).toEqual([
      { label: "Jan", value: 80 },
      { label: "Feb", value: 90 },
    ]);
  });

  it("coerces non-numeric values to 0", () => {
    const t = table();
    t.rows = [["Q1", "n/a", 3]];
    const rows = categoryValues(t, { type: "waterfall", yKey: "revenue" });
    expect(rows).toEqual([{ label: "Q1", value: 0 }]);
  });
});

describe("singleValue", () => {
  it("reads the first row's numeric value (or the chosen yKey)", () => {
    expect(singleValue(table(), { type: "gauge" })).toBe(120);
    expect(singleValue(table(), { type: "gauge", yKey: "cost" })).toBe(80);
  });
  it("returns null for an empty table", () => {
    const t = table();
    t.rows = [];
    expect(singleValue(t, { type: "gauge" })).toBeNull();
  });
});

describe("makeNumberFormatter", () => {
  it("formats currency, percent, compact, and plain with decimals", () => {
    expect(makeNumberFormatter({ style: "currency", currency: "USD", decimals: 0 })(1200)).toBe("$1,200");
    expect(makeNumberFormatter({ style: "percent", decimals: 1 })(0.427)).toBe("42.7%");
    expect(makeNumberFormatter({ style: "compact" })(1500000)).toBe("1.5M");
    expect(makeNumberFormatter({ decimals: 2, suffix: " ms" })(3)).toBe("3.00 ms");
  });

  it("shows an em dash for nullish values", () => {
    expect(makeNumberFormatter()(null)).toBe("—");
  });
});

describe("conditionalColor", () => {
  const rules = [
    { op: "gte" as const, value: 100, color: "good" },
    { op: "lt" as const, value: 100, color: "critical" },
  ];
  it("resolves a status role name to its reserved var, first match wins", () => {
    expect(conditionalColor(120, rules)).toBe(STATUS.good);
    expect(conditionalColor(50, rules)).toBe(STATUS.critical);
  });
  it("scopes by column and ignores non-numeric values", () => {
    const scoped = [{ column: "revenue", op: "gt" as const, value: 0, color: "#123456" }];
    expect(conditionalColor(5, scoped, "revenue")).toBe("#123456");
    expect(conditionalColor(5, scoped, "other")).toBeNull();
    expect(conditionalColor("x", rules)).toBeNull();
  });
});
