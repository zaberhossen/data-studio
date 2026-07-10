/**
 * Contract for the RAW-SQL path (DuckDB-WASM engine).
 *
 * This is intentionally separate from `analytics.ts` (the Rust/builder
 * contract) so the two engines stay decoupled. The first three types
 * (`SqlColumn`, `SqlResult`, `SqlError`) are the public surface the SQL-editor
 * UI consumes; the rest is the worker message protocol, mirroring the shape of
 * the existing chart-worker protocol so the hook can route both identically.
 */

import type { Row } from "./analytics";
import type { QueryIR } from "@/lib/query/ir";

/** Default table name the single (query-panel) dataset is registered under. */
export const DATASET_TABLE = "dataset";

/**
 * Deterministic DuckDB table name for a keyed dataset id.
 *
 * The dashboard's keyed registry holds one table per dataset id (no swapping).
 * The default id keeps the canonical `dataset` name so the existing single-source
 * query panel is unaffected; every other id maps to a sanitized `ds_…` table so
 * arbitrary source ids (UUIDs, names) become valid SQL identifiers. This is the
 * table name a SQL widget's statement references, so the UI, worker, and cache
 * all derive it from here.
 */
export function tableNameFor(datasetId: string): string {
  if (datasetId === DATASET_TABLE) return DATASET_TABLE;
  return `ds_${datasetId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

/** The four column types the results table understands. */
export type SqlColumnType = "number" | "string" | "date" | "bool";

export interface SqlColumn {
  name: string;
  type: SqlColumnType;
}

/** A single page of a SQL result. */
export interface SqlResult {
  columns: SqlColumn[];
  /** ONLY the requested page (default cap 1000 rows), in column order. */
  rows: unknown[][];
  /** Total rows of the FULL result — drives pagination in the UI. */
  rowCount: number;
  /** Time to produce this page: full execution on page 1, slice on later pages. */
  elapsedMs: number;
}

/** Rejection shape for `runSql`. Never carries an internal stack trace. */
export interface SqlError {
  kind: "parse" | "execution";
  message: string;
  line?: number;
  column?: number;
}

export interface RunSqlOptions {
  /** Page size. Defaults to 1000 in the worker. */
  limit?: number;
  /** Page offset into the full result. Defaults to 0. */
  offset?: number;
}

/** Public signature the SQL-editor UI calls. */
export type RunSql = (
  sql: string,
  opts?: RunSqlOptions,
) => Promise<SqlResult>;

// ---------------------------------------------------------------------------
// Worker message protocol (typed both directions) — DuckDB worker
// ---------------------------------------------------------------------------

/** Local-file source kinds the DuckDB worker can parse from bytes. */
export type FileSourceKind = "csv" | "parquet" | "json";

/**
 * Messages the main thread posts INTO the DuckDB worker.
 *
 * KEYED REGISTRY: every data-carrying message names a `datasetId`. DuckDB holds
 * one table per id (see {@link tableNameFor}) — no swapping — so a dashboard's
 * many sources stay resident simultaneously. `datasetId` defaults to
 * DATASET_TABLE for the single-source query panel.
 */
export type SqlWorkerRequest =
  | {
      // Hand the DuckDB worker its end of the private peer channel (port in
      // `event.ports[0]`). Sent once, right after spawn.
      type: "link";
    }
  | {
      // Stash a dataset's rows for lazy ingestion under `datasetId`. Does NOT
      // instantiate DuckDB — the several-MB module is fetched on first `sql`.
      type: "load";
      requestId: number;
      datasetId: string;
      rows: Row[];
    }
  | {
      // SERVER source: fetch a bounded slice of /api/datasources/[id]/data
      // INSIDE the worker (rows never touch the main thread), feed both engines
      // under `datasetId`.
      type: "load_source";
      requestId: number;
      datasetId: string;
      sourceId: string;
      /** Table/view to read; the endpoint validates it against the allowlist. */
      table?: string;
      limit?: number;
      offset?: number;
    }
  | {
      // PUSHDOWN: POST a QueryIR (never SQL) to /api/datasources/[id]/run,
      // which compiles + runs it on the LIVE database and returns the small
      // aggregated result as Arrow IPC. The worker fetches it (rows never touch
      // the main thread) and stashes it under `datasetId` as its own table, so
      // the ordinary `sql` path can page/sort/export it like any other dataset.
      type: "run_pushdown";
      requestId: number;
      datasetId: string;
      sourceId: string;
      ir: QueryIR;
    }
  | {
      // FILE source: parse uploaded bytes (CSV/Parquet/JSON) and feed both
      // engines under `datasetId`. Bytes are read client-side.
      type: "load_file";
      requestId: number;
      datasetId: string;
      fileKind: FileSourceKind;
      bytes: ArrayBuffer;
      fileName: string;
    }
  | {
      // Run one read-only statement against `datasetId`'s table; paginate via
      // limit/offset.
      type: "sql";
      requestId: number;
      datasetId: string;
      sql: string;
      limit: number;
      offset: number;
    }
  | {
      // Serialize the FULL materialized result of a statement to CSV (for
      // export). Reuses the cached Arrow table when the SQL was already run.
      type: "export_csv";
      requestId: number;
      datasetId: string;
      sql: string;
    }
  | {
      // Drop a dataset's table + cached results (dashboard removed a source).
      type: "evict";
      datasetId: string;
    };

/** Messages the DuckDB worker posts BACK to the main thread. */
export type SqlWorkerResponse =
  | { type: "loaded"; requestId: number; rows: number }
  | {
      // A source (server or file) finished loading into BOTH engines.
      type: "source_loaded";
      requestId: number;
      rowCount: number;
      columns: SqlColumn[];
    }
  | { type: "sql_result"; requestId: number; result: SqlResult }
  | { type: "sql_error"; requestId: number; error: SqlError }
  | {
      // Full-result CSV (the entire materialized result, not just one page).
      type: "csv";
      requestId: number;
      csv: string;
      rowCount: number;
    }
  | { type: "error"; requestId: number | null; message: string };
