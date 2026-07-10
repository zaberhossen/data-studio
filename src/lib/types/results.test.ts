import { describe, expect, it } from "vitest";
import {
  chartPayloadToResultTable,
  pageResultTable,
  sqlResultToResultTable,
} from "./results";
import type { ChartPayload } from "./analytics";
import type { SqlResult } from "./sql";

describe("chartPayloadToResultTable", () => {
  const payload: ChartPayload = {
    points: [
      { label: "APAC", value: 300 },
      { label: "EMEA", value: 200 },
      { label: "NA", value: 100 },
    ],
    rows_matched: 600,
    rows_total: 600,
    metric_label: "SUM(revenue)",
  };

  it("maps points to a 2-column table with the metric label", () => {
    const t = chartPayloadToResultTable(payload);
    expect(t.source).toBe("builder");
    expect(t.columns).toEqual([
      { name: "label", type: "string" },
      { name: "SUM(revenue)", type: "number" },
    ]);
    expect(t.rows).toEqual([
      ["APAC", 300],
      ["EMEA", 200],
      ["NA", 100],
    ]);
  });

  it("returns the WHOLE result as one page (client-side paging upstream)", () => {
    const t = chartPayloadToResultTable(payload);
    expect(t.totalRows).toBe(3);
    expect(t.page).toBe(0);
    expect(t.pageSize).toBe(3);
    expect(t.rows).toHaveLength(3);
    expect(t.capped).toBe(false);
  });

  it("threads elapsedMs through and falls back to 'value' label", () => {
    const t = chartPayloadToResultTable(
      { ...payload, metric_label: "" },
      12.5,
    );
    expect(t.elapsedMs).toBe(12.5);
    expect(t.columns[1].name).toBe("value");
  });

  it("handles an empty payload", () => {
    const t = chartPayloadToResultTable({ ...payload, points: [] });
    expect(t.rows).toEqual([]);
    expect(t.totalRows).toBe(0);
    expect(t.pageSize).toBe(0);
  });
});

describe("sqlResultToResultTable", () => {
  const result: SqlResult = {
    columns: [
      { name: "id", type: "number" },
      { name: "name", type: "string" },
      { name: "active", type: "bool" },
    ],
    rows: [
      [11, "alice", true],
      [12, "bob", false],
    ],
    rowCount: 4200,
    elapsedMs: 3.2,
  };

  it("records page coordinates and the FULL row count", () => {
    const t = sqlResultToResultTable(result, 2, 50);
    expect(t.source).toBe("sql");
    expect(t.page).toBe(2);
    expect(t.pageSize).toBe(50);
    expect(t.totalRows).toBe(4200);
    expect(t.elapsedMs).toBe(3.2);
  });

  it("passes rows + columns through unchanged (already a page)", () => {
    const t = sqlResultToResultTable(result, 0, 50);
    expect(t.columns).toEqual(result.columns);
    expect(t.rows).toBe(result.rows);
  });

  it("threads the capped flag", () => {
    expect(sqlResultToResultTable(result, 0, 50, true).capped).toBe(true);
    expect(sqlResultToResultTable(result, 0, 50).capped).toBeUndefined();
  });
});

describe("pageResultTable", () => {
  const full = chartPayloadToResultTable({
    points: Array.from({ length: 10 }, (_, i) => ({
      label: `r${i}`,
      value: i,
    })),
    rows_matched: 10,
    rows_total: 10,
    metric_label: "v",
  });

  it("slices the in-hand result to the requested page", () => {
    const p1 = pageResultTable(full, 1, 4);
    expect(p1.page).toBe(1);
    expect(p1.pageSize).toBe(4);
    expect(p1.rows).toEqual([
      ["r4", 4],
      ["r5", 5],
      ["r6", 6],
      ["r7", 7],
    ]);
    // totalRows is unchanged — it still describes the whole result.
    expect(p1.totalRows).toBe(10);
  });

  it("clamps the final partial page", () => {
    const last = pageResultTable(full, 2, 4);
    expect(last.rows).toEqual([
      ["r8", 8],
      ["r9", 9],
    ]);
  });

  it("returns an empty page past the end", () => {
    expect(pageResultTable(full, 5, 4).rows).toEqual([]);
  });
});
