/**
 * Legacy `Query` (v1) → `QueryIR` (v2) migration.
 *
 * Non-destructive and lazy: a saved builder query keeps its `query` (so the Rust
 * fast-path still fires) and gains a derived `ir` that persists on the next save.
 * `table` defaults to the resident local dataset name; the execution layer
 * overrides `source.table` with the real table when pushing down.
 */

import type { Filter as LegacyFilter, Query } from "@/lib/types/analytics";
import { col, type Aggregation, type Filter, type QueryIR } from "@/lib/query/ir";

export function queryV1ToIR(query: Query, table = "dataset"): QueryIR {
  const aggregation: Aggregation = {
    fn: query.aggregation.func,
    field: query.aggregation.column ? col(query.aggregation.column) : undefined,
  };

  const ir: QueryIR = {
    version: 2,
    source: { table },
    dimensions: [{ field: col(query.group_by) }],
    aggregations: [aggregation],
  };

  const filters = (query.filters ?? []).map(toIrLeaf);
  if (filters.length === 1) {
    ir.filters = filters[0];
  } else if (filters.length > 1) {
    ir.filters = { op: "and", clauses: filters };
  }

  if (query.sort) {
    ir.order = [{ ref: { kind: "aggregation", index: 0 }, dir: query.sort }];
  }
  if (query.limit !== undefined) ir.limit = query.limit;

  return ir;
}

function toIrLeaf(f: LegacyFilter): Filter {
  const field = col(f.column);
  if (f.operator === "in_list") {
    return { op: "in", field, values: (f.values ?? []).filter(notNull) };
  }
  // Scalar operators. Legacy `value` is a Cell (may be null); coerce to the IR's
  // scalar union — a null scalar is degenerate here and defaults to "".
  const value = f.value == null ? "" : f.value;
  return { op: f.operator, field, value };
}

function notNull(v: string | number | boolean | null): v is string | number | boolean {
  return v !== null;
}
