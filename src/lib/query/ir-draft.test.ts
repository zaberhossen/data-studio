import { describe, it, expect } from "vitest";
import {
  compileIrDraft,
  draftUpToStep,
  emptyIrDraft,
  irOperatorsFor,
  irToDraft,
  newDraftFilter,
  newDraftFilterGroup,
  newDraftHaving,
  newDraftMetric,
  newDraftDimension,
  newDraftSort,
  stageOutputFields,
  allowlistFromFields,
  type DraftFilterGroup,
  type IrDraft,
} from "./ir-draft";
import { compileIR, DuckDbDialect, PostgresDialect } from "./compile";
import { irColumns } from "@/lib/query/ir";
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
    having: [],
    sort: [],
    limit: 50,
    offset: 0,
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

describe("compileIrDraft — calculated fields + windows", () => {
  it("compiles a formula calculated field over columns", () => {
    const draft = draftWith({
      calculated: [{ id: "c1", name: "spend", text: "[amount] * 2" }],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(errors).toEqual([]);
    expect(ir?.calculated).toEqual([
      {
        name: "spend",
        expr: {
          op: "binary",
          operator: "*",
          left: { op: "field", ref: { kind: "column", name: "amount" } },
          right: { op: "lit", value: 2 },
        },
      },
    ]);
  });

  it("compiles a case/when formula end-to-end to SQL", () => {
    const draft = draftWith({
      calculated: [
        { id: "c1", name: "size", text: "case when [amount] > 100 then 'big' else 'small' end" },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(errors).toEqual([]);
    const sql = compileIR(ir!, DuckDbDialect, irColumns(ir!), { inline: true }).sql;
    expect(sql).toContain("CASE WHEN");
    expect(sql).toContain("'big'");
  });

  it("lets a later formula reference an earlier calculated field", () => {
    const draft = draftWith({
      calculated: [
        { id: "c1", name: "net", text: "[amount] - 5" },
        { id: "c2", name: "net2", text: "[net] * 2" },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(errors).toEqual([]);
    expect(ir?.calculated?.[1].expr).toMatchObject({
      left: { op: "field", ref: { kind: "expression", name: "net" } },
    });
  });

  it("errors on a duplicate calc name, an unnamed field, and unknown columns", () => {
    const draft = draftWith({
      calculated: [
        { id: "c1", name: "", text: "[amount] + 1" },
        { id: "c2", name: "amount", text: "[amount] + 1" },
        { id: "c3", name: "bad", text: "[nope] + 1" },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(ir).toBeNull();
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("compiles a running-total window over an aggregated output column", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "created_at", temporal: "month" }],
      metrics: [{ id: "m1", fn: "sum", column: "amount" }],
      windows: [
        {
          id: "w1",
          fn: "sum",
          column: "sum_amount",
          partitions: [],
          orders: [{ id: "o1", column: "created_at_month", dir: "asc" }],
          running: true,
          arg: "",
          alias: "running",
        },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(errors).toEqual([]);
    expect(ir?.windows?.[0]).toMatchObject({ fn: "sum", frame: "running", alias: "running" });
    const sql = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS)).sql;
    expect(sql).toContain(
      'OVER (ORDER BY "created_at_month" ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)',
    );
  });

  it("compiles multi-column partition + order windows", () => {
    const draft = draftWith({
      windows: [
        {
          id: "w1",
          fn: "rank",
          column: "",
          partitions: ["category", "created_at"],
          orders: [
            { id: "o1", column: "amount", dir: "desc" },
            { id: "o2", column: "created_at", dir: "asc" },
          ],
          running: false,
          arg: "",
          alias: "rnk",
        },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(errors).toEqual([]);
    const sql = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS)).sql;
    expect(sql).toContain('PARTITION BY "category", "created_at"');
    expect(sql).toContain('ORDER BY "amount" DESC, "created_at" ASC');
  });

  it("rejects a window referencing a non-output column", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "category" }],
      metrics: [{ id: "m1", fn: "count", column: "" }],
      windows: [
        { id: "w1", fn: "sum", column: "amount", partitions: [], orders: [], running: false, arg: "", alias: "w" },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(ir).toBeNull();
    expect(errors.some((e) => e.includes("output column"))).toBe(true);
  });

  it("compiles a multi-condition join with an alias + round-trips", () => {
    const draft = draftWith({
      joins: [
        {
          id: "j1",
          table: "customers",
          alias: "c",
          type: "left",
          conditions: [
            { id: "jc1", left: "amount", right: "order_id" },
            { id: "jc2", left: "category", right: "segment" },
          ],
        },
      ],
      metrics: [{ id: "m1", fn: "count", column: "" }],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    expect(ir?.joins?.[0]).toEqual({
      table: "customers",
      alias: "c",
      type: "left",
      on: [
        { left: { kind: "column", name: "amount" }, right: { kind: "column", table: "c", name: "order_id" } },
        { left: { kind: "column", name: "category" }, right: { kind: "column", table: "c", name: "segment" } },
      ],
    });
    const back = irToDraft(ir!);
    expect(back.joins?.[0]).toMatchObject({ table: "customers", alias: "c", type: "left" });
    expect(back.joins?.[0].conditions).toHaveLength(2);
  });

  it("errors on an incomplete join", () => {
    const draft = draftWith({
      joins: [{ id: "j1", table: "", type: "inner", conditions: [{ id: "jc1", left: "", right: "" }] }],
      metrics: [{ id: "m1", fn: "count", column: "" }],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(ir).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("round-trips calc + window through irToDraft", () => {
    const draft = draftWith({
      calculated: [{ id: "c1", name: "net", text: "[amount] - 5" }],
      windows: [
        {
          id: "w1",
          fn: "rank",
          column: "",
          partitions: ["category"],
          orders: [{ id: "o1", column: "amount", dir: "desc" }],
          running: false,
          arg: "",
          alias: "rnk",
        },
      ],
    });
    const { ir } = compileIrDraft(draft, FIELDS, "t");
    const back = irToDraft(ir!);
    expect(back.calculated?.[0]).toMatchObject({ name: "net", text: "[amount] - 5" });
    expect(back.windows?.[0]).toMatchObject({ fn: "rank", partitions: ["category"], alias: "rnk" });
    expect(back.windows?.[0].orders[0]).toMatchObject({ column: "amount", dir: "desc" });
  });
});

describe("compileIrDraft — filter tree", () => {
  it("compiles nested OR groups with NOT", () => {
    const group: DraftFilterGroup = {
      ...newDraftFilterGroup("or"),
      not: true,
      children: [
        { ...newDraftFilter("category", "eq"), value: "books" },
        { ...newDraftFilter("amount", "gt"), value: "100" },
      ],
    };
    const draft = draftWith({
      metrics: [{ id: "m1", fn: "count", column: "" }],
      filters: [group, { ...newDraftFilter("category", "not_null") }],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS);
    expect(errors).toEqual([]);
    expect(ir!.filters).toEqual({
      op: "and",
      clauses: [
        {
          op: "not",
          clause: {
            op: "or",
            clauses: [
              { op: "eq", field: { kind: "column", name: "category" }, value: "books" },
              { op: "gt", field: { kind: "column", name: "amount" }, value: 100 },
            ],
          },
        },
        { op: "not_null", field: { kind: "column", name: "category" } },
      ],
    });
  });

  it("round-trips a nested filter tree", () => {
    const group: DraftFilterGroup = {
      ...newDraftFilterGroup("or"),
      children: [
        { ...newDraftFilter("category", "eq"), value: "books" },
        { ...newDraftFilter("category", "eq"), value: "games" },
      ],
    };
    const draft = draftWith({
      metrics: [{ id: "m1", fn: "count", column: "" }],
      filters: [group, { ...newDraftFilter("amount", "gt"), value: "10" }],
    });
    const { ir } = compileIrDraft(draft, FIELDS, "orders");
    const rebuilt = compileIrDraft(irToDraft(ir!), FIELDS, "orders");
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.ir).toEqual(ir);
  });

  it("rejects an empty group", () => {
    const group = { ...newDraftFilterGroup("or"), children: [] };
    const draft = draftWith({
      metrics: [{ id: "m1", fn: "count", column: "" }],
      filters: [group],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS);
    expect(ir).toBeNull();
    expect(errors.join(" ")).toMatch(/empty/i);
  });
});

describe("compileIrDraft — having + sort + aliases + offset", () => {
  it("compiles HAVING over a metric and emits the aggregate expression on Postgres", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "category" }],
      metrics: [{ id: "m1", fn: "sum", column: "amount" }],
      having: [{ ...newDraftHaving(), metricIndex: 0, op: "gt", value: "100" }],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    expect(ir!.having).toEqual({
      op: "gt",
      field: { kind: "aggregation", index: 0 },
      value: 100,
    });
    // Postgres can't reference SELECT aliases in HAVING — the aggregate
    // expression must be repeated there.
    const pg = compileIR(ir!, PostgresDialect, allowlistFromFields(FIELDS));
    expect(pg.sql).toMatch(/HAVING sum\("amount"\) > /);
  });

  it("compiles multi-key sort incl. a dimension alias", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "created_at", temporal: "month" }],
      metrics: [{ id: "m1", fn: "sum", column: "amount" }],
      sort: [
        { id: "s1", column: "sum_amount", dir: "desc" },
        { id: "s2", column: "created_at_month", dir: "asc" },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    expect(ir!.order).toEqual([
      { ref: { kind: "aggregation", index: 0 }, dir: "desc" },
      { ref: { kind: "column", name: "created_at_month" }, dir: "asc" },
    ]);
    const sql = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS)).sql;
    expect(sql).toContain('ORDER BY "sum_amount" DESC, "created_at_month" ASC');
  });

  it("honors dimension/metric aliases in output names and sort", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "category", alias: "cat" }],
      metrics: [{ id: "m1", fn: "sum", column: "amount", alias: "revenue" }],
      sort: [{ id: "s1", column: "revenue", dir: "desc" }],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    const sql = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS)).sql;
    expect(sql).toContain('AS "cat"');
    expect(sql).toContain('AS "revenue"');
    expect(sql).toContain('ORDER BY "revenue" DESC');
  });

  it("rejects duplicate output names", () => {
    const draft = draftWith({
      metrics: [
        { id: "m1", fn: "sum", column: "amount" },
        { id: "m2", fn: "sum", column: "amount" },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS);
    expect(ir).toBeNull();
    expect(errors.join(" ")).toMatch(/used twice/i);
  });

  it("compiles offset", () => {
    const draft = draftWith({
      metrics: [{ id: "m1", fn: "count", column: "" }],
      limit: 10,
      offset: 20,
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS);
    expect(errors).toEqual([]);
    expect(ir!.offset).toBe(20);
    const out = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS));
    expect(out.sql).toMatch(/LIMIT \? OFFSET \?/);
    expect(out.params).toEqual([10, 20]);
  });

  it("round-trips having + multi-sort + aliases + offset", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "category", alias: "cat" }],
      metrics: [{ id: "m1", fn: "sum", column: "amount", alias: "revenue" }],
      having: [
        { ...newDraftHaving(), metricIndex: 0, op: "between", low: "10", high: "99" },
        { ...newDraftHaving(), metricIndex: 0, op: "gt", value: "5" },
      ],
      sort: [
        { id: "s1", column: "revenue", dir: "desc" },
        { id: "s2", column: "cat", dir: "asc" },
      ],
      limit: 25,
      offset: 5,
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    const rebuilt = compileIrDraft(irToDraft(ir!), FIELDS, "orders");
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.ir).toEqual(ir);
  });
});

describe("compileIrDraft — basics", () => {
  it("compiles multiple metrics + a bucketed date dimension", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "created_at", temporal: "month" }],
      metrics: [
        { id: "m1", fn: "sum", column: "amount" },
        { id: "m2", fn: "count", column: "" },
      ],
      sort: [newDraftSort("sum_amount", "desc")],
      limit: 20,
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    expect(ir).not.toBeNull();
    expect(ir!.dimensions).toEqual([
      { field: { kind: "column", name: "created_at" }, temporal: "month", alias: undefined },
    ]);
    expect(ir!.aggregations).toHaveLength(2);
    expect(ir!.order).toEqual([{ ref: { kind: "aggregation", index: 0 }, dir: "desc" }]);

    const sql = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS)).sql;
    expect(sql).toContain(`date_trunc('month', "created_at")`);
    expect(sql).toContain('sum("amount")');
    expect(sql).toContain("count(*)");
  });

  it("rejects bucketing on a non-date column", () => {
    const draft = draftWith({
      dimensions: [{ id: "d1", column: "category", temporal: "month" }],
      metrics: [{ id: "m1", fn: "count", column: "" }],
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
  it("seeds a first dimension + a count metric + a default sort", () => {
    const draft = emptyIrDraft(FIELDS);
    expect(draft.dimensions[0].column).toBe("category");
    expect(draft.metrics[0].fn).toBe("count");
    expect(draft.sort[0]).toMatchObject({ column: "count", dir: "desc" });
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
      sort: [newDraftSort("sum_amount", "desc")],
    });
    const { ir } = compileIrDraft(draft, FIELDS);
    const inline = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS), {
      inline: true,
    });
    expect(inline.params).toEqual([]);
    expect(inline.sql).toContain(`'O''Brien'`);
    expect(inline.sql).not.toContain("?");

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
      sort: [newDraftSort("sum_amount", "desc")],
      limit: 20,
    });
    const { ir } = compileIrDraft(draft, FIELDS, "orders");
    expect(ir).not.toBeNull();

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
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    const rebuilt = compileIrDraft(irToDraft(ir!), FIELDS, "orders");
    expect(rebuilt.ir).toEqual(ir);
  });

  it("collects warnings instead of silently dropping unsupported shapes", () => {
    const warnings: string[] = [];
    irToDraft(
      {
        version: 2,
        source: { table: "t" },
        aggregations: [{ fn: "sum", field: { kind: "column", name: "amount" } }],
        having: {
          op: "or",
          clauses: [
            { op: "gt", field: { kind: "aggregation", index: 0 }, value: 1 },
            { op: "lt", field: { kind: "aggregation", index: 0 }, value: 0 },
          ],
        },
      },
      warnings,
    );
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("rawColumns (data-step column picker)", () => {
  it("compiles an explicit raw column selection", () => {
    const draft = draftWith({ rawColumns: ["category", "amount"] });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    expect(ir!.fields).toEqual([
      { kind: "column", name: "category" },
      { kind: "column", name: "amount" },
    ]);
    const sql = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS)).sql;
    expect(sql).toContain('SELECT "category", "amount" FROM');
  });

  it("round-trips through irToDraft and is ignored when aggregated", () => {
    const draft = draftWith({ rawColumns: ["category"] });
    const { ir } = compileIrDraft(draft, FIELDS, "orders");
    expect(irToDraft(ir!).rawColumns).toEqual(["category"]);

    const agg = draftWith({
      rawColumns: ["category"],
      metrics: [{ id: "m1", fn: "count", column: "" }],
    });
    const { ir: aggIr } = compileIrDraft(agg, FIELDS, "orders");
    expect(aggIr!.fields).toBeUndefined();
  });
});

describe("draftUpToStep (per-step preview)", () => {
  const full = draftWith({
    dimensions: [{ id: "d1", column: "category" }],
    metrics: [{ id: "m1", fn: "sum", column: "amount" }],
    filters: [{ ...newDraftFilter("amount", "gt"), value: "5" }],
    having: [{ ...newDraftHaving(), metricIndex: 0, op: "gt", value: "10" }],
    sort: [newDraftSort("sum_amount", "desc")],
    limit: 500,
  });

  it("data step is a bare 10-row listing (allowBare)", () => {
    const step = draftUpToStep(full, "data");
    expect(step.dimensions).toEqual([]);
    expect(step.filters).toEqual([]);
    expect(step.limit).toBe(10);
    const { ir, errors } = compileIrDraft(step, FIELDS, "orders", { allowBare: true });
    expect(errors).toEqual([]);
    const sql = compileIR(ir!, DuckDbDialect, allowlistFromFields(FIELDS)).sql;
    expect(sql).toContain("SELECT *");
  });

  it("filters step keeps filters but drops summarize/having/sort", () => {
    const step = draftUpToStep(full, "filters");
    expect(step.filters).toHaveLength(1);
    expect(step.dimensions).toEqual([]);
    expect(step.having).toEqual([]);
    expect(step.sort).toEqual([]);
  });

  it("having step keeps summarize + having", () => {
    const step = draftUpToStep(full, "having");
    expect(step.dimensions).toHaveLength(1);
    expect(step.having).toHaveLength(1);
    expect(step.sort).toEqual([]);
    const { errors } = compileIrDraft(step, FIELDS, "orders", { allowBare: true });
    expect(errors).toEqual([]);
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

describe("compileIrDraft — numeric binning + new aggregations (M12 Stage 3)", () => {
  it("bins a numeric dimension and aliases it _bin", () => {
    const draft = draftWith({
      dimensions: [{ ...newDraftDimension("amount"), bin: "100" }],
      metrics: [newDraftMetric("count")],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(errors).toEqual([]);
    expect(ir?.dimensions?.[0].bin).toEqual({ width: 100 });
    const { sql } = compileIR(ir!, DuckDbDialect, irColumns(ir!), { inline: true });
    expect(sql).toContain('floor("amount" / 100) * 100 AS "amount_bin"');
  });

  it("rejects binning on a non-numeric column and a bad width", () => {
    expect(
      compileIrDraft(
        draftWith({ dimensions: [{ ...newDraftDimension("category"), bin: "10" }], metrics: [newDraftMetric("count")] }),
        FIELDS,
        "t",
      ).errors[0],
    ).toMatch(/numeric/);
    expect(
      compileIrDraft(
        draftWith({ dimensions: [{ ...newDraftDimension("amount"), bin: "-5" }], metrics: [newDraftMetric("count")] }),
        FIELDS,
        "t",
      ).errors[0],
    ).toMatch(/positive/);
  });

  it("parses a percentile given as a 0–100 percentage", () => {
    const draft = draftWith({ metrics: [{ ...newDraftMetric("percentile", "amount"), p: "90" }] });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(errors).toEqual([]);
    expect(ir?.aggregations?.[0].p).toBe(0.9);
  });

  it("compiles count_if / sum_if from a single condition", () => {
    const draft = draftWith({
      metrics: [
        { ...newDraftMetric("count_if"), cond: { column: "amount", op: "gt", value: "100" }, alias: "big" },
        { ...newDraftMetric("sum_if", "amount"), cond: { column: "category", op: "eq", value: "a" }, alias: "asum" },
      ],
    });
    const { ir, errors } = compileIrDraft(draft, FIELDS, "t");
    expect(errors).toEqual([]);
    expect(ir?.aggregations?.[0]).toMatchObject({ fn: "count_if", alias: "big" });
    const { sql } = compileIR(ir!, DuckDbDialect, irColumns(ir!), { inline: true });
    expect(sql).toContain('count(CASE WHEN "amount" > 100 THEN 1 END) AS "big"');
    expect(sql).toContain(`sum(CASE WHEN "category" = 'a' THEN "amount" END) AS "asum"`);
  });

  it("flags a conditional aggregate missing its condition", () => {
    const draft = draftWith({ metrics: [newDraftMetric("count_if")] });
    expect(compileIrDraft(draft, FIELDS, "t").errors[0]).toMatch(/condition/);
  });

  it("round-trips binning + percentile + count_if through irToDraft", () => {
    const draft = draftWith({
      dimensions: [{ ...newDraftDimension("amount"), bin: "50" }],
      metrics: [
        { ...newDraftMetric("percentile", "amount"), p: "0.75", alias: "p75" },
        { ...newDraftMetric("count_if"), cond: { column: "amount", op: "gte", value: "10" }, alias: "n" },
      ],
    });
    const { ir } = compileIrDraft(draft, FIELDS, "t");
    const back = irToDraft(ir!);
    expect(back.dimensions[0].bin).toBe("50");
    expect(back.metrics[0].p).toBe("0.75");
    expect(back.metrics[1].cond).toEqual({ column: "amount", op: "gte", value: "10" });
  });
});

describe("compileIrDraft — multi-stage (M12 Stage 3)", () => {
  it("nests stage 1 as a subquery and re-aggregates over its output", () => {
    const stage1 = draftWith({
      dimensions: [newDraftDimension("category")],
      metrics: [newDraftMetric("sum", "amount")],
    });
    const draft: IrDraft = {
      ...stage1,
      nextStage: draftWith({
        // Over stage-1 output columns: category, sum_amount.
        metrics: [{ ...newDraftMetric("avg", "sum_amount"), alias: "avg_cat" }],
      }),
    };
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(errors).toEqual([]);
    expect(ir?.source).toMatchObject({ query: { source: { table: "orders" } }, alias: "__stage" });
    const { sql } = compileIR(ir!, DuckDbDialect, irColumns(ir!), { inline: true });
    expect(sql).toBe(
      'SELECT avg("sum_amount") AS "avg_cat" FROM (' +
        'SELECT "category" AS "category", sum("amount") AS "sum_amount" ' +
        'FROM "orders" GROUP BY "category") AS "__stage" LIMIT 50',
    );
  });

  it("drops the base stage's limit so it doesn't truncate before the next stage", () => {
    const draft: IrDraft = {
      ...draftWith({
        dimensions: [newDraftDimension("category")],
        metrics: [newDraftMetric("sum", "amount")],
        limit: 10,
      }),
      nextStage: draftWith({ metrics: [newDraftMetric("count")] }),
    };
    const { ir } = compileIrDraft(draft, FIELDS, "orders");
    // inner (nested query) limit is cleared; only the outer stage may limit.
    expect(ir?.source && "query" in ir.source && ir.source.query.limit).toBeUndefined();
  });

  it("surfaces stage-2 errors prefixed", () => {
    const draft: IrDraft = {
      ...draftWith({
        dimensions: [newDraftDimension("category")],
        metrics: [newDraftMetric("sum", "amount")],
      }),
      nextStage: draftWith({ metrics: [newDraftMetric("sum", "nonexistent")] }),
    };
    const { ir, errors } = compileIrDraft(draft, FIELDS, "orders");
    expect(ir).toBeNull();
    expect(errors[0]).toMatch(/^Stage 2 —/);
  });

  it("round-trips a two-stage query through irToDraft", () => {
    const draft: IrDraft = {
      ...draftWith({
        dimensions: [newDraftDimension("category")],
        metrics: [newDraftMetric("sum", "amount")],
      }),
      nextStage: draftWith({
        dimensions: [{ ...newDraftDimension("sum_amount"), bin: "100" }],
        metrics: [newDraftMetric("count")],
      }),
    };
    const { ir } = compileIrDraft(draft, FIELDS, "orders");
    const back = irToDraft(ir!);
    expect(back.dimensions[0].column).toBe("category");
    expect(back.nextStage?.dimensions[0]).toMatchObject({ column: "sum_amount", bin: "100" });
    expect(back.nextStage?.metrics[0].fn).toBe("count");
  });
});

describe("stageOutputFields", () => {
  it("describes an aggregated stage's output as its dimension + metric aliases", () => {
    const draft = draftWith({
      dimensions: [newDraftDimension("category"), { ...newDraftDimension("amount"), bin: "10" }],
      metrics: [newDraftMetric("sum", "amount"), newDraftMetric("count")],
    });
    const out = stageOutputFields(draft, FIELDS);
    expect(out.map((f) => [f.name, f.dataType])).toEqual([
      ["category", "string"],
      ["amount_bin", "number"],
      ["sum_amount", "number"],
      ["count", "number"],
    ]);
  });
});
