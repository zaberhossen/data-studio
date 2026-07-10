import { describe, it, expect } from "vitest";
import { compileIR, CompileError } from "./compile";
import { DuckDbDialect } from "./duckdb";
import { rustFastPath } from "./capability";
import { queryV1ToIR } from "./migrate";
import { chooseExecution } from "./route";
import { col, type QueryIR } from "@/lib/query/ir";
import type { Query } from "@/lib/types/analytics";

const D = DuckDbDialect;

describe("compileIR windows + calculated fields (M10)", () => {
  it("wraps a grouped query and adds a running-total window over its output", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "orders" },
      dimensions: [{ field: col("month") }],
      aggregations: [{ fn: "sum", field: col("amount") }],
      windows: [
        {
          fn: "sum",
          field: col("sum_amount"),
          orderBy: [{ field: col("month"), dir: "asc" }],
          frame: "running",
          alias: "running_total",
        },
      ],
      order: [{ ref: col("month"), dir: "asc" }],
    };
    const out = compileIR(ir, D, new Set(["month", "amount"]));
    expect(out.sql).toBe(
      'SELECT *, sum("sum_amount") OVER (ORDER BY "month" ASC ' +
        "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS \"running_total\" " +
        'FROM (SELECT "month" AS "month", sum("amount") AS "sum_amount" ' +
        'FROM "orders" GROUP BY "month") AS "__base" ORDER BY "month" ASC',
    );
    expect(out.columns).toContainEqual({ name: "running_total", role: "window" });
  });

  it("compiles rank + partition and an ntile bucket over raw output columns", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "players" },
      windows: [
        {
          fn: "rank",
          partitionBy: [col("team")],
          orderBy: [{ field: col("score"), dir: "desc" }],
          alias: "team_rank",
        },
        { fn: "ntile", arg: 4, orderBy: [{ field: col("score"), dir: "desc" }], alias: "quartile" },
      ],
    };
    const out = compileIR(ir, D, new Set(["team", "score"]));
    expect(out.sql).toContain('rank() OVER (PARTITION BY "team" ORDER BY "score" DESC) AS "team_rank"');
    expect(out.sql).toContain('ntile(4) OVER (ORDER BY "score" DESC) AS "quartile"');
  });

  it("rejects a window field that isn't an output column", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "orders" },
      dimensions: [{ field: col("month") }],
      aggregations: [{ fn: "sum", field: col("amount") }],
      windows: [{ fn: "sum", field: col("amount"), alias: "w" }], // "amount" isn't output
    };
    expect(() => compileIR(ir, D, new Set(["month", "amount"]))).toThrow(CompileError);
  });

  it("inlines a calculated field in a raw listing", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "orders" },
      calculated: [
        {
          name: "profit",
          expr: { op: "binary", operator: "-", left: { op: "field", ref: col("revenue") }, right: { op: "field", ref: col("cost") } },
        },
      ],
    };
    const out = compileIR(ir, D, new Set(["revenue", "cost"]));
    expect(out.sql).toBe('SELECT *, ("revenue" - "cost") AS "profit" FROM "orders"');
    expect(out.columns).toEqual([{ name: "profit", role: "raw" }]);
  });
});

describe("compileIR (DuckDB)", () => {
  it("compiles a grouped aggregation with a filter, order, and limit", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "orders" },
      dimensions: [{ field: col("category") }],
      aggregations: [{ fn: "sum", field: col("amount") }],
      filters: { op: "gt", field: col("amount"), value: 100 },
      order: [{ ref: { kind: "aggregation", index: 0 }, dir: "desc" }],
      limit: 10,
    };
    const out = compileIR(ir, D, new Set(["category", "amount"]));
    expect(out.sql).toBe(
      'SELECT "category" AS "category", sum("amount") AS "sum_amount" ' +
        'FROM "orders" WHERE "amount" > ? GROUP BY "category" ' +
        'ORDER BY "sum_amount" DESC LIMIT ?',
    );
    expect(out.params).toEqual([100, 10]);
    expect(out.columns).toEqual([
      { name: "category", role: "dimension" },
      { name: "sum_amount", role: "metric" },
    ]);
  });

  it("buckets a temporal dimension and counts", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "events" },
      dimensions: [{ field: col("created_at"), temporal: "month" }],
      aggregations: [{ fn: "count" }],
    };
    const out = compileIR(ir, D, new Set(["created_at"]));
    expect(out.sql).toBe(
      `SELECT date_trunc('month', "created_at") AS "created_at_month", ` +
        `count(*) AS "count" FROM "events" ` +
        `GROUP BY date_trunc('month', "created_at")`,
    );
    expect(out.params).toEqual([]);
  });

  it("compiles contains as an escaped LIKE with a bound pattern", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "t" },
      dimensions: [{ field: col("name") }],
      aggregations: [{ fn: "count" }],
      filters: { op: "contains", field: col("name"), value: "ab" },
    };
    const out = compileIR(ir, D, new Set(["name"]));
    expect(out.sql).toContain(`"name" LIKE ? ESCAPE '\\'`);
    expect(out.params).toEqual(["%ab%"]);
  });

  it("compiles IN and BETWEEN with bound params", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "t" },
      aggregations: [{ fn: "count" }],
      filters: {
        op: "and",
        clauses: [
          { op: "in", field: col("status"), values: ["a", "b"] },
          { op: "between", field: col("age"), low: 18, high: 65 },
        ],
      },
    };
    const out = compileIR(ir, D, new Set(["status", "age"]));
    expect(out.sql).toContain('"status" IN (?, ?)');
    expect(out.sql).toContain('"age" BETWEEN ? AND ?');
    expect(out.params).toEqual(["a", "b", 18, 65]);
  });

  it("inlines calculated-field literals safely in a raw listing", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "t" },
      calculated: [
        {
          name: "total",
          expr: {
            op: "binary",
            operator: "*",
            left: { op: "field", ref: col("price") },
            right: { op: "lit", value: 2 },
          },
        },
      ],
    };
    const out = compileIR(ir, D, new Set(["price"]));
    expect(out.sql).toBe('SELECT *, ("price" * 2) AS "total" FROM "t"');
    expect(out.columns).toEqual([{ name: "total", role: "raw" }]);
  });

  it("escapes string literals in expressions (injection-safe)", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "t" },
      calculated: [
        { name: "lbl", expr: { op: "lit", value: "O'Brien" } },
      ],
    };
    const out = compileIR(ir, D, new Set([]));
    expect(out.sql).toContain(`'O''Brien'`);
  });

  it("rejects a column not in the allowlist (tampered IR)", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "t" },
      dimensions: [{ field: col("category") }],
      aggregations: [{ fn: "sum", field: col("password") }],
    };
    expect(() => compileIR(ir, D, new Set(["category"]))).toThrow(CompileError);
  });

  it("compiles an inner join with a qualified ON and grouped aggregation", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "orders" },
      joins: [
        {
          table: "customers",
          alias: "customers",
          type: "left",
          on: [{ left: col("customer_id"), right: col("id", "customers") }],
        },
      ],
      dimensions: [{ field: col("country", "customers") }],
      aggregations: [{ fn: "sum", field: col("amount") }],
    };
    const out = compileIR(ir, D, new Set(["customer_id", "id", "country", "amount"]));
    expect(out.sql).toBe(
      'SELECT "customers"."country" AS "country", sum("amount") AS "sum_amount" ' +
        'FROM "orders" LEFT JOIN "customers" AS "customers" ' +
        'ON "customer_id" = "customers"."id" GROUP BY "customers"."country"',
    );
  });

  it("rejects a join to a table outside the allowedTables allowlist", () => {
    const ir: QueryIR = {
      version: 2,
      source: { table: "orders" },
      joins: [{ table: "secrets", alias: "secrets", type: "inner", on: [] }],
      aggregations: [{ fn: "count" }],
    };
    expect(() =>
      compileIR(ir, D, new Set(["id"]), { allowedTables: new Set(["orders", "customers"]) }),
    ).toThrow(CompileError);
  });
});

describe("rustFastPath", () => {
  const simple: QueryIR = {
    version: 2,
    source: { table: "dataset" },
    dimensions: [{ field: col("category") }],
    aggregations: [{ fn: "sum", field: col("amount") }],
    filters: { op: "gt", field: col("amount"), value: 100 },
    order: [{ ref: { kind: "aggregation", index: 0 }, dir: "desc" }],
    limit: 10,
  };

  it("accepts a simple single-dim single-agg IR", () => {
    expect(rustFastPath(simple)).toEqual({
      filters: [{ column: "amount", operator: "gt", value: 100 }],
      group_by: "category",
      aggregation: { func: "sum", column: "amount" },
      sort: "desc",
      limit: 10,
    });
  });

  it("rejects temporal bucketing", () => {
    expect(
      rustFastPath({ ...simple, dimensions: [{ field: col("category"), temporal: "month" }] }),
    ).toBeNull();
  });

  it("rejects multiple aggregations", () => {
    expect(
      rustFastPath({
        ...simple,
        aggregations: [
          { fn: "sum", field: col("amount") },
          { fn: "count" },
        ],
      }),
    ).toBeNull();
  });

  it("rejects count_distinct / median / stddev", () => {
    expect(
      rustFastPath({ ...simple, aggregations: [{ fn: "count_distinct", field: col("amount") }] }),
    ).toBeNull();
  });

  it("rejects OR filters", () => {
    expect(
      rustFastPath({
        ...simple,
        filters: {
          op: "or",
          clauses: [
            { op: "eq", field: col("a"), value: 1 },
            { op: "eq", field: col("b"), value: 2 },
          ],
        },
      }),
    ).toBeNull();
  });
});

describe("queryV1ToIR", () => {
  it("round-trips through rustFastPath", () => {
    const q: Query = {
      filters: [
        { column: "amount", operator: "gt", value: 100 },
        { column: "status", operator: "in_list", values: ["a", "b"] },
      ],
      group_by: "category",
      aggregation: { func: "sum", column: "amount" },
      sort: "desc",
      limit: 25,
    };
    const ir = queryV1ToIR(q);
    expect(ir.version).toBe(2);
    expect(ir.dimensions).toEqual([{ field: col("category") }]);
    expect(rustFastPath(ir)).toEqual(q);
  });

  it("handles a query with no filters/sort", () => {
    const q: Query = {
      group_by: "region",
      aggregation: { func: "count" },
    };
    const ir = queryV1ToIR(q);
    expect(ir.filters).toBeUndefined();
    expect(rustFastPath(ir)).toEqual({
      group_by: "region",
      aggregation: { func: "count", column: undefined },
      sort: undefined,
      limit: undefined,
    });
  });
});

describe("chooseExecution", () => {
  const agg: QueryIR = {
    version: 2,
    source: { table: "t" },
    dimensions: [{ field: col("x") }],
    aggregations: [{ fn: "count" }],
  };
  const raw: QueryIR = { version: 2, source: { table: "t" } };

  it("pushes down aggregated queries on live DBs", () => {
    expect(chooseExecution("postgres", agg)).toBe("pushdown");
    expect(chooseExecution("mysql", agg)).toBe("pushdown");
  });

  it("runs locally for files or non-aggregated queries", () => {
    expect(chooseExecution("file", agg)).toBe("local");
    expect(chooseExecution("postgres", raw)).toBe("local");
  });
});
