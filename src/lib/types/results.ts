/**
 * Results view-model — the SINGLE shape the results table renders.
 *
 * Two engines produce two very different result shapes:
 *   • Builder path → `ChartPayload` (a handful of aggregated points)
 *   • Raw-SQL path → `SqlResult` (one materialized page of arbitrary columns)
 *
 * Both are normalized into `ResultTable` by the pure adapters below, so the
 * table component is fed ONE shape and never learns which engine produced it.
 *
 * INVARIANT: a `ResultTable` handed to the table component holds the CURRENT
 * page only. Raw rows live exclusively in the workers — never in React.
 */

import type { ChartPayload } from "./analytics";
import type { SqlResult } from "./sql";

/** Column type vocabulary shared with schema introspection + the result grid. */
export type ResultColumnType = "number" | "string" | "date" | "bool";

export interface ResultColumn {
  name: string;
  type: ResultColumnType;
}

export interface ResultTable {
  columns: ResultColumn[];
  /** CURRENT page only, in column order. */
  rows: unknown[][];
  /** 0-based page index. */
  page: number;
  pageSize: number;
  /** Full result size — drives pagination + the truncation note. */
  totalRows: number;
  source: "builder" | "sql";
  elapsedMs?: number;
  /** True when `totalRows` hit the server/worker row cap. */
  capped?: boolean;
}

/** Sort intent emitted by the table; the PARENT re-queries (never client-side). */
export interface SortSpec {
  column: string;
  dir: "asc" | "desc";
}

/**
 * Builder result → `ResultTable`.
 *
 * A `ChartPayload` is tiny (≈50 points) and fully in hand, so this returns the
 * WHOLE result as a two-column table (the grouped dimension + its aggregated
 * metric). The caller pages it client-side via {@link pageResultTable} — no
 * re-query needed. `page`/`pageSize` describe "all of it on one page".
 */
export function chartPayloadToResultTable(
  p: ChartPayload,
  elapsedMs?: number,
): ResultTable {
  const columns: ResultColumn[] = [
    { name: "label", type: "string" },
    { name: p.metric_label || "value", type: "number" },
  ];
  const rows: unknown[][] = p.points.map((pt) => [pt.label, pt.value]);
  return {
    columns,
    rows,
    page: 0,
    pageSize: rows.length,
    totalRows: rows.length,
    source: "builder",
    elapsedMs,
    capped: false,
  };
}

/**
 * SQL result → `ResultTable`.
 *
 * `SqlResult.rows` is ALREADY the requested page (the worker materializes the
 * full result once and slices), so this is a near-identity map that records the
 * page coordinates the caller asked for.
 */
export function sqlResultToResultTable(
  r: SqlResult,
  page: number,
  pageSize: number,
  capped?: boolean,
): ResultTable {
  return {
    columns: r.columns.map((c) => ({ name: c.name, type: c.type })),
    rows: r.rows,
    page,
    pageSize,
    totalRows: r.rowCount,
    source: "sql",
    elapsedMs: r.elapsedMs,
    capped,
  };
}

/**
 * Slice a fully-in-hand `ResultTable` (whose `rows` is the WHOLE result) down to
 * one page. Used for the builder path, where the payload is small and
 * client-side paging is correct. The input's `rows` must be the complete set.
 */
export function pageResultTable(
  full: ResultTable,
  page: number,
  pageSize: number,
): ResultTable {
  const start = page * pageSize;
  return {
    ...full,
    page,
    pageSize,
    rows: full.rows.slice(start, start + pageSize),
  };
}
