/**
 * Execution routing: decide whether a compiled IR runs LOCAL (DuckDB over the
 * resident dataset) or PUSHDOWN (the connector runs it on the live source DB).
 *
 * PUSHDOWN is preferred for live databases when the query aggregates — the heavy
 * work happens server-side and only the small result returns. File/in-memory
 * sources always run LOCAL (the data is already in the browser). The user can
 * override this per query via the execution-mode toggle (M5).
 */

import type { DataSourceKind } from "@/lib/types/datasource";
import type { ExecutionMode } from "@/lib/types/query";
import { isAggregated, type QueryIR } from "@/lib/query/ir";

// Only real SQL databases can push down. Fetch-based sources (http-file /
// rest-api) have no server SQL engine, so their IR always runs LOCAL (DuckDB
// over the fetched slice).
const LIVE_KINDS: ReadonlySet<DataSourceKind> = new Set(["postgres", "mysql"]);

export function chooseExecution(kind: DataSourceKind, ir: QueryIR): ExecutionMode {
  // Joins reach across tables that only exist in the live DB — they can't run
  // LOCAL over the single resident dataset, so they always push down.
  if (LIVE_KINDS.has(kind) && (isAggregated(ir) || (ir.joins?.length ?? 0) > 0)) {
    return "pushdown";
  }
  return "local";
}
