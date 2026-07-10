/**
 * Rust fast-path capability check.
 *
 * The legacy Rust engine (`wasm/src/lib.rs`) handles a narrow shape very fast:
 * single table, one dimension, one aggregation, a flat AND of simple filters,
 * optional sort-by-metric + limit. `rustFastPath` returns the equivalent legacy
 * `Query` when an IR fits that shape (so we keep the hot local path), or `null`
 * when the IR is richer and must be compiled to SQL instead.
 */

import type { AggFn as LegacyAggFn, Filter as LegacyFilter, Operator, Query } from "@/lib/types/analytics";
import type { AggFn as IrAggFn, Filter, QueryIR } from "@/lib/query/ir";

const RUST_AGG: ReadonlySet<IrAggFn> = new Set(["sum", "avg", "count", "min", "max"]);

export function rustFastPath(ir: QueryIR): Query | null {
  // Disqualifiers: anything the Rust engine can't express.
  if (ir.joins?.length) return null;
  if (ir.calculated?.length) return null;
  if (ir.windows?.length) return null;
  if (ir.having) return null;
  if (ir.offset && ir.offset > 0) return null;

  const dims = ir.dimensions ?? [];
  const aggs = ir.aggregations ?? [];
  if (dims.length !== 1 || aggs.length !== 1) return null;

  const dim = dims[0];
  if (dim.temporal) return null;
  if (dim.field.kind !== "column") return null;

  const agg = aggs[0];
  if (agg.distinct) return null;
  if (!RUST_AGG.has(agg.fn)) return null;
  if (agg.field && agg.field.kind !== "column") return null;

  const filters = flattenAndLeaves(ir.filters);
  if (filters === null) return null;

  // Sort: none, or a single order on the (only) aggregation.
  let sort: Query["sort"];
  if (ir.order && ir.order.length > 0) {
    if (ir.order.length !== 1) return null;
    const o = ir.order[0];
    if (o.ref.kind !== "aggregation" || o.ref.index !== 0) return null;
    sort = o.dir;
  }

  return {
    filters: filters.length > 0 ? filters : undefined,
    group_by: dim.field.name,
    aggregation: {
      func: agg.fn as LegacyAggFn,
      column: agg.field?.kind === "column" ? agg.field.name : undefined,
    },
    sort,
    limit: ir.limit,
  };
}

/**
 * Flatten the filter tree into legacy leaf filters IF it is a flat AND (or a
 * single leaf, or absent) whose leaves use only Rust-representable operators.
 * Returns `null` if the tree contains OR/NOT/between/null/relative/starts/ends.
 */
function flattenAndLeaves(f: Filter | undefined): LegacyFilter[] | null {
  if (!f) return [];
  const out: LegacyFilter[] = [];

  const leaves: Filter[] = f.op === "and" ? f.clauses : [f];
  for (const leaf of leaves) {
    const mapped = toLegacyLeaf(leaf);
    if (mapped === null) return null;
    out.push(mapped);
  }
  return out;
}

function toLegacyLeaf(f: Filter): LegacyFilter | null {
  switch (f.op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains": {
      if (f.field.kind !== "column") return null;
      return { column: f.field.name, operator: f.op as Operator, value: f.value };
    }
    case "in": {
      if (f.field.kind !== "column") return null;
      return { column: f.field.name, operator: "in_list", values: f.values };
    }
    // not_in / starts_with / ends_with / between / null / relative_date and the
    // composite ops (and/or/not) have no Rust equivalent → force the SQL path.
    default:
      return null;
  }
}
