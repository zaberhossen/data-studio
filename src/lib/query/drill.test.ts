import { describe, expect, it } from "vitest";
import {
  bucketRange,
  drillDistribution,
  drillFilterEq,
  drillSummarize,
  drillViewRecords,
  drillZoomIn,
  resolveResultColumn,
} from "./drill";
import { compileIrDraft, type IrDraft } from "./ir-draft";
import type { Field } from "./schema";

const FIELDS: Field[] = [
  { name: "category", label: "Category", role: "dimension", dataType: "string" },
  { name: "created_at", label: "Created At", role: "dimension", dataType: "date" },
  { name: "amount", label: "Amount", role: "metric", dataType: "number" },
];

function base(partial: Partial<IrDraft>): IrDraft {
  return {
    dimensions: [],
    metrics: [],
    filters: [],
    having: [],
    sort: [],
    limit: 50,
    offset: 0,
    ...partial,
  };
}

const AGG = base({
  dimensions: [
    { id: "d1", column: "created_at", temporal: "month" },
    { id: "d2", column: "category" },
  ],
  metrics: [{ id: "m1", fn: "sum", column: "amount" }],
});

describe("resolveResultColumn", () => {
  it("maps aliases back to dimensions/metrics and raw columns", () => {
    expect(resolveResultColumn(AGG, FIELDS, "created_at_month")).toEqual({
      kind: "dimension",
      index: 0,
    });
    expect(resolveResultColumn(AGG, FIELDS, "sum_amount")).toEqual({ kind: "metric", index: 0 });
    expect(resolveResultColumn(AGG, FIELDS, "nope")).toEqual({ kind: "other" });
    expect(resolveResultColumn(base({}), FIELDS, "amount")).toMatchObject({ kind: "raw" });
  });
});

describe("bucketRange", () => {
  it("computes a half-open month range in UTC", () => {
    expect(bucketRange("2024-03-01", "month")).toEqual({
      low: "2024-03-01 00:00:00",
      high: "2024-04-01 00:00:00",
    });
  });
  it("handles timestamps, weeks, and year rollover", () => {
    expect(bucketRange("2024-12-30 00:00:00", "week")).toEqual({
      low: "2024-12-30 00:00:00",
      high: "2025-01-06 00:00:00",
    });
    expect(bucketRange("2024-01-01", "year")?.high).toBe("2025-01-01 00:00:00");
  });
  it("returns null for derived buckets and junk", () => {
    expect(bucketRange("3", "day_of_week")).toBeNull();
    expect(bucketRange("not a date", "month")).toBeNull();
  });
});

describe("drillFilterEq", () => {
  it("filters a categorical dimension by value", () => {
    const next = drillFilterEq(AGG, FIELDS, "category", "books");
    expect(next).not.toBeNull();
    expect(next!.filters).toHaveLength(1);
    expect(next!.filters[0]).toMatchObject({ column: "category", op: "eq", value: "books" });
    // Still compiles.
    expect(compileIrDraft(next!, FIELDS, "t").errors).toEqual([]);
  });

  it("filters a temporal dimension as a half-open range", () => {
    const next = drillFilterEq(AGG, FIELDS, "created_at_month", "2024-03-01");
    expect(next!.filters).toEqual([
      expect.objectContaining({ column: "created_at", op: "gte", value: "2024-03-01 00:00:00" }),
      expect.objectContaining({ column: "created_at", op: "lt", value: "2024-04-01 00:00:00" }),
    ]);
  });

  it("null value → is_null; metric column → no action", () => {
    const next = drillFilterEq(AGG, FIELDS, "category", null);
    expect(next!.filters[0]).toMatchObject({ op: "is_null" });
    expect(drillFilterEq(AGG, FIELDS, "sum_amount", 5)).toBeNull();
  });
});

describe("drillZoomIn", () => {
  it("pins the bucket and re-buckets one step finer", () => {
    const next = drillZoomIn(AGG, FIELDS, "created_at_month", "2024-03-01");
    expect(next).not.toBeNull();
    expect(next!.dimensions[0].temporal).toBe("week");
    expect(next!.filters).toHaveLength(2);
    expect(compileIrDraft(next!, FIELDS, "t").errors).toEqual([]);
  });
  it("is unavailable for non-temporal dimensions", () => {
    expect(drillZoomIn(AGG, FIELDS, "category", "books")).toBeNull();
  });
});

describe("drillViewRecords", () => {
  it("turns an aggregated row into a filtered raw listing", () => {
    const next = drillViewRecords(AGG, FIELDS, [
      { column: "created_at_month", value: "2024-03-01" },
      { column: "category", value: "books" },
      { column: "sum_amount", value: 123 },
    ]);
    expect(next).not.toBeNull();
    expect(next!.dimensions).toEqual([]);
    expect(next!.metrics).toEqual([]);
    expect(next!.limit).toBe(100);
    // 2 range leaves for the month + 1 eq for category; the metric cell is ignored.
    expect(next!.filters).toHaveLength(3);
    expect(compileIrDraft(next!, FIELDS, "t", { allowBare: true }).errors).toEqual([]);
  });
  it("does nothing for an already-raw listing", () => {
    expect(drillViewRecords(base({}), FIELDS, [])).toBeNull();
  });
});

describe("drillDistribution / drillSummarize", () => {
  it("distribution groups by the column with a count", () => {
    const next = drillDistribution(base({}), FIELDS, "category");
    expect(next!.dimensions[0]).toMatchObject({ column: "category" });
    expect(next!.metrics[0]).toMatchObject({ fn: "count" });
    expect(next!.sort[0]).toMatchObject({ column: "count", dir: "desc" });
  });
  it("distribution buckets dates by month and rejects numerics (no binning yet)", () => {
    expect(drillDistribution(base({}), FIELDS, "created_at")!.dimensions[0].temporal).toBe("month");
    expect(drillDistribution(base({}), FIELDS, "amount")).toBeNull();
  });
  it("summarize keeps filters and swaps the summarize layer", () => {
    const withFilter = base({
      filters: [
        { id: "f1", kind: "leaf", column: "category", op: "eq", value: "books", values: [], low: "", high: "", relative: { direction: "last", count: "7", unit: "day" } },
      ],
    });
    const next = drillSummarize(withFilter, FIELDS, "amount", "avg");
    expect(next!.metrics[0]).toMatchObject({ fn: "avg", column: "amount" });
    expect(next!.filters).toHaveLength(1);
    expect(drillSummarize(base({}), FIELDS, "category", "sum")).toBeNull();
    expect(drillSummarize(base({}), FIELDS, "category", "count_distinct")).not.toBeNull();
  });
  it("distribution resolves a dimension alias to its underlying column", () => {
    const next = drillDistribution(AGG, FIELDS, "category");
    expect(next!.dimensions[0]).toMatchObject({ column: "category" });
  });
});
