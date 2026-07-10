import { describe, it, expect } from "vitest";
import {
  compileIrDraft,
  emptyIrDraft,
  irOperatorsFor,
  irToDraft,
  newDraftFilter,
  newDraftMetric,
  newDraftDimension,
  allowlistFromFields,
  type IrDraft,
} from "./ir-draft";
import { compileIR, DuckDbDialect } from "./compile";
import { fieldsFromColumns, type Field } from "./schema";

const FIELDS: Field[] = [
  { name: "category", label: "Category", role: "dimension", dataType: "string" },
  { name: "created_at", label: "Created At", role: "dimension", dataType: "date" },
  { name: "amount", label: "Amount", role: "metric", dataType: "number" },
];

function draftWith(partial: Partial<IrDraft>): IrDraft {
  return {
    dimensions: [],
    metrics: [],
    filters: [],
    sortMetricIndex: null,
    sortDir: "desc",
    limit: 50,
    ...partial,
  };
}

describe("date DataType", () => {
  it("maps a date column to the date data-type", () => {
    const fields = fieldsFromColumns([{ name: "ts", type: "date" }]);
    expect(fields[0].dataType).toBe("date");
    expect(fields[0].role).toBe("dimension");
  });

  it("offers temporal-friendly operators for date columns", () => {
    expect(irOperatorsFor("date")).toContain("relative_date");
    expect(irOperatorsFor("date")).toContain("between");
    expect(irOperatorsFor("string")).toContain("contains");
    expect(irOperatorsFor("string")).not.toContain("relative_date");
  });
});

describe("compileIrDraft — calculated fields + windows (M10)", () => {
  it("compiles an arithmetic calculated field over two columns", () => {
    const draft = draftWith({
      calculated: [
        { id: "c1", name: "spend", a: { kind: "column", value: "amount" }, operator: "*", b: { kind: "number", value: "2" } },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(errors).toEqual([]);
    expect(ir?.calculated).toEqual([
      { name: "spend", expr: { op: "binary", operator: "*", left: { op: "field", ref: { kind: "column", name: "amount" } }, right: { op: "lit", value: 2 } } },
    ]);
  });

  it("errors on a duplicate calc name and an unnamed field", () => {
    const draft = draftWith({
      calculated: [
        { id: "c1", name: "", a: { kind: "column", value: "amount" }, operator: "+", b: { kind: "number", value: "1" } },
        { id: "c2", name: "amount", a: { kind: "column", value: "amount" }, operator: "+", b: { kind: "number", value: "1" } },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(ir).toBeNull();
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("compiles a running-total window over an aggregated output column", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "created_at", temporal: "month" }],
      metrics: [{ id: "m1", fn: "sum", column: "amount" }],
      windows: [
        { id: "w1", fn: "sum", column: "sum_amount", partition: "", orderColumn: "created_at_month", orderDir: "asc", running: true, arg: "", alias: "running" },
      ],
      sortMetricIndex: null,
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(errors).toEqual([]);
    expect(ir?.windows?.[0]).toMatchObject({ fn: "sum", frame: "running", alias: "running" });
    // The whole IR must compile to SQL end-to-end.
    const sql = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS)).sql;
    expect(sql).toContain('OVER (ORDER BY "created_at_month" ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)');
  });

  it("rejects a window referencing a non-output column", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "category" }],
      metrics: [{ id: "m1", fn: "count", column: "" }],
      windows: [
        { id: "w1", fn: "sum", column: "amount", partition: "", orderColumn: "", orderDir: "asc", running: false, arg: "", alias: "w" },
      ],
      sortMetricIndex: null,
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(ir).toBeNull();
    expect(errors.some((e) => e.includes("output column"))).toBe(true);
  });

  it("compiles a join (base key unqualified, joined key qualified) + round-trips", () => {
    const draft = draftWith({
      joins: [
        { id: "j1", table: "customers", type: "left", leftColumn: "amount", rightColumn: "order_id" },
      ],
      metrics: [{ id: "m1", fn: "count", column: "" }],
      sortMetricIndex: null,
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    expect(ir?.joins?.[0]).toEqual({
      table: "customers",
      alias: "customers",
      type: "left",
      on: [{ left: { kind: "column", name: "amount" }, right: { kind: "column", table: "customers", name: "order_id" } }],
    });
    const back = irToDraft(ir!);
    expect(back.joins?.[0]).toMatchObject({ table: "customers", type: "left", leftColumn: "amount", rightColumn: "order_id" });
  });

  it("errors on an incomplete join", () => {
    const draft = draftWith({
      joins: [{ id: "j1", table: "", type: "inner", leftColumn: "", rightColumn: "" }],
      metrics: [{ id: "m1", fn: "count", column: "" }],
      sortMetricIndex: null,
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(ir).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("round-trips calc + window through irToDraft", () => {
    const draft = draftWith({
      calculated: [
        { id: "c1", name: "net", a: { kind: "column", value: "amount" }, operator: "-", b: { kind: "number", value: "5" } },
      ],
      windows: [
        { id: "w1", fn: "rank", column: "", partition: "category", orderColumn: "amount", orderDir: "desc", running: false, arg: "", alias: "rnk" },
      ],
    });
    const { ir } = compileIrDraft(draft, FIELDS, "t");
    const back = irToDraft(ir!);
    expect(back.calculated?.[0]).toMatchObject({ name: "net", operator: "-", a: { kind: "column", value: "amount" }, b: { kind: "number", value: "5" } });
    expect(back.windows?.[0]).toMatchObject({ fn: "rank", partition: "category", orderColumn: "amount", orderDir: "desc", alias: "rnk" });
  });
});

describe("compileIrDraft", () => {
  it("compiles multiple metrics + a bucketed date dimension", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "created_at", temporal: "month" }],
      metrics: [
        { id: "m1", fn: "sum", column: "amount" },
        { id: "m2", fn: "count", column: "" },
      ],
      sortMetricIndex: 0,
      sortDir: "desc",
      limit: 20,
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    expect(ir).not.toBeNull();
    expect(ir!.dimensions).toEqual([
      { field: { kind: "column", name: "created_at" }, temporal: "month" },
    ]);
    expect(ir!.aggregations).toHaveLength(2);
    expect(ir!.order).toEqual([
      { ref: { kind: "aggregation", index: 0 }, dir: "desc" },
    ]);

    // And it compiles to valid grouped SQL.
    const sql = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS)).sql;
    expect(sql).toContain(`date_trunc('month', "created_at")`);
    expect(sql).toContain('sum("amount")');
    expect(sql).toContain("count(*)");
  });

  it("rejects bucketing on a non-date column", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "category", temporal: "month" }],
      metrics: [{ id: "m1", fn: "count", column: "" }],
      sortMetricIndex: null,
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS);
    expect(ir).toBeNull();
    expect(errors.join(" ")).toMatch(/only available on date/i);
  });

  it("compiles a between filter on a number column", () => {
    const filter = newDraftFilter("amount", "between");
    filter.low = "10";
    filter.high = "100";
    const draft = draftWith({
      metrics: [{ id: "m1", fn: "count", column: "" }],
      filters: [filter],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS);
    expect(errors).toEqual([]);
    expect(ir!.filters).toEqual({
      op: "between",
      field: { kind: "column", name: "amount" },
      low: 10,
      high: 100,
    });
  });

  it("compiles a relative_date filter on a date column", () => {
    const filter = newDraftFilter("created_at", "relative_date");
    filter.relative = { direction: "last", count: "30", unit: "day" };
    const draft = draftWith({
      metrics: [{ id: "m1", fn: "count", column: "" }],
      filters: [filter],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS);
    expect(errors).toEqual([]);
    expect(ir!.filters).toEqual({
      op: "relative_date",
      field: { kind: "column", name: "created_at" },
      relative: { direction: "last", unit: "day", count: 30 },
    });
  });

  it("errors when an operator is invalid for the column type", () => {
    const filter = newDraftFilter("category", "contains");
    filter.value = "x";
    // Force an invalid op for a string column.
    (filter as { op: string }).op = "relative_date";
    const draft = draftWith({
      metrics: [{ id: "m1", fn: "count", column: "" }],
      filters: [filter],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS);
    expect(ir).toBeNull();
    expect(errors.join(" ")).toMatch(/not valid/i);
  });

  it("requires at least one metric or dimension", () => {
    const { ir, errors } = compileIrDraft(draftWith({}), FIELDS);
    expect(ir).toBeNull();
    expect(errors.join(" ")).toMatch(/at least one/i);
  });
});

describe("emptyIrDraft", () => {
  it("seeds a first dimension + a count metric", () => {
    const draft = emptyIrDraft(FIELDS);
    expect(draft.dimensions[0].column).toBe("category");
    expect(draft.metrics[0].fn).toBe("count");
    const { errors } = compileIrDraft(draft, FIELDS);
    expect(errors).toEqual([]);
  });
});

describe("compileIR inline mode (LOCAL DuckDB)", () => {
  it("inlines values as escaped literals instead of bound params", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "category" }],
      metrics: [{ id: "m1", fn: "sum", column: "amount" }],
      filters: [{ ...newDraftFilter("category", "eq"), value: "O'Brien" }],
      sortMetricIndex: 0,
    });
    const { ir } = compileIrDraft(draft, FIELDS);
    const inline = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS), {
      inline: true,
    });
    expect(inline.params).toEqual([]);
    expect(inline.sql).toContain(`'O''Brien'`);
    expect(inline.sql).not.toContain("?");

    // The parameterized form (default) keeps values out of the SQL text
    // (filter value first, then the LIMIT).
    const bound = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS));
    expect(bound.params).toEqual(["O'Brien", 50]);
    expect(bound.sql).toContain("= ?");
  });
});

describe("irToDraft (reverse of compileIrDraft)", () => {
  it("round-trips a multi-metric / bucketed / filtered / sorted query", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "created_at", temporal: "month" }],
      metrics: [
        { id: "m1", fn: "sum", column: "amount" },
        { id: "m2", fn: "count", column: "" },
      ],
      filters: [
        { ...newDraftFilter("amount", "between"), low: "10", high: "100" },
        { ...newDraftFilter("category", "eq"), value: "books" },
      ],
      sortMetricIndex: 0,
      sortDir: "desc",
      limit: 20,
    });
    const { ir } = compileIrDraft(draft, FIELDS, "orders");
    expect(ir).not.toBeNull();

    // Re-hydrating the compiled IR and recompiling must yield the SAME IR.
    const rebuilt = compileIrDraft(irToDraft(ir!), FIELDS, "orders");
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.ir).toEqual(ir);
  });

  it("round-trips a relative-date filter and a dimensions-only query", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "category" }],
      metrics: [],
      filters: [
        {
          ...newDraftFilter("created_at", "relative_date"),
          relative: { direction: "last", count: "7", unit: "day" },
        },
      ],
      sortMetricIndex: null,
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    const rebuilt = compileIrDraft(irToDraft(ir!), FIELDS, "orders");
    expect(rebuilt.ir).toEqual(ir);
  });
});

describe("factories keep unique ids", () => {
  it("newDraftMetric / newDraftDimension produce distinct ids", () => {
    const a = newDraftMetric();
    const b = newDraftMetric();
    const c = newDraftDimension();
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });
});
