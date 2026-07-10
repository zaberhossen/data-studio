import { describe, it, expect } from "vitest";
import { compileIR, CompileError } from "./compile";
import { PostgresDialect } from "./postgres";
import { MySqlDialect } from "./mysql";
import { dialectFor } from "./dialects";
import { col, type QueryIR } from "@/lib/query/ir";

const IR: QueryIR = {
  version: 2,
  source: { table: "orders" },
  dimensions: [{ field: col("created_at"), temporal: "month" }],
  aggregations: [{ fn: "sum", field: col("amount") }],
  filters: { op: "gt", field: col("amount"), value: 100 },
  order: [{ ref: { kind: "aggregation", index: 0 }, dir: "desc" }],
  limit: 10,
};
const ALLOWED = new Set(["created_at", "amount"]);

describe("PostgresDialect", () => {
  it("uses numbered placeholders, double-quoted idents, date_trunc", () => {
    const out = compileIR(IR, PostgresDialect, ALLOWED);
    expect(out.sql).toBe(
      `SELECT date_trunc('month', "created_at") AS "created_at_month", ` +
        `sum("amount") AS "sum_amount" FROM "orders" ` +
        `WHERE "amount" > $1 GROUP BY date_trunc('month', "created_at") ` +
        `ORDER BY "sum_amount" DESC LIMIT $2`,
    );
    expect(out.params).toEqual([100, 10]);
  });

  it("compiles median via percentile_cont", () => {
    const out = compileIR(
      { version: 2, source: { table: "t" }, aggregations: [{ fn: "median", field: col("x") }] },
      PostgresDialect,
      new Set(["x"]),
    );
    expect(out.sql).toContain(`percentile_cont(0.5) WITHIN GROUP (ORDER BY "x")`);
  });

  it("compiles a relative-date filter with an interval", () => {
    const out = compileIR(
      {
        version: 2,
        source: { table: "t" },
        aggregations: [{ fn: "count" }],
        filters: {
          op: "relative_date",
          field: col("d"),
          relative: { direction: "last", count: 30, unit: "day" },
        },
      },
      PostgresDialect,
      new Set(["d"]),
    );
    expect(out.sql).toContain(`"d" >= current_date - INTERVAL '30 day'`);
  });
});

describe("MySqlDialect", () => {
  it("uses ? placeholders, backtick idents, DATE_FORMAT bucketing", () => {
    const out = compileIR(IR, MySqlDialect, ALLOWED);
    expect(out.sql).toContain("DATE_FORMAT(`created_at`, '%Y-%m-01')");
    expect(out.sql).toContain("sum(`amount`)");
    expect(out.sql).toContain("`amount` > ?");
    expect(out.sql).toContain("LIMIT ?");
    expect(out.params).toEqual([100, 10]);
  });

  it("rejects MEDIAN (unsupported on MySQL)", () => {
    expect(() =>
      compileIR(
        { version: 2, source: { table: "t" }, aggregations: [{ fn: "median", field: col("x") }] },
        MySqlDialect,
        new Set(["x"]),
      ),
    ).toThrow(CompileError);
  });
});

describe("dialectFor", () => {
  it("maps live kinds to dialects and rejects the rest", () => {
    expect(dialectFor("postgres").id).toBe("postgres");
    expect(dialectFor("mysql").id).toBe("mysql");
    expect(() => dialectFor("file")).toThrow(CompileError);
    expect(() => dialectFor("rest-api")).toThrow(CompileError);
  });
});
