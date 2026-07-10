import { describe, it, expect } from "vitest";
import { resultTableToChartPayload } from "./chart-payload";
import type { ResultTable } from "@/lib/types/results";

function table(): ResultTable {
  return {
    columns: [
      { name: "category", type: "string" },
      { name: "revenue", type: "number" },
    ],
    rows: [
      ["books", 120],
      ["toys", 80],
    ],
    page: 0,
    pageSize: 2,
    totalRows: 2,
    source: "sql",
  };
}

describe("resultTableToChartPayload", () => {
  it("defaults to first column (x) and first numeric column (y)", () => {
    const p = resultTableToChartPayload(table());
    expect(p.points).toEqual([
      { label: "books", value: 120 },
      { label: "toys", value: 80 },
    ]);
    expect(p.metric_label).toBe("revenue");
    expect(p.rows_matched).toBe(2);
  });

  it("honors explicit xKey / yKey", () => {
    const p = resultTableToChartPayload(table(), { xKey: "revenue", yKey: "revenue" });
    // x becomes the revenue column (stringified), y stays revenue.
    expect(p.points).toEqual([
      { label: "120", value: 120 },
      { label: "80", value: 80 },
    ]);
  });

  it("coerces nulls to a placeholder label and zero value", () => {
    const t = table();
    t.rows = [[null, null]];
    const p = resultTableToChartPayload(t);
    expect(p.points).toEqual([{ label: "∅", value: 0 }]);
  });
});
