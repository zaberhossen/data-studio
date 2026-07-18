"use client";

/**
 * useAnalyticsEngine — React-friendly wrapper around BOTH compute engines.
 *
 * Two workers, one hook, clean Promise methods (components never touch
 * `postMessage`):
 *
 *   Builder path  →  chart.worker.ts (Rust/WASM)   runQuery(query)  → ChartPayload
 *   Raw-SQL path  →  sql.worker.ts   (DuckDB-WASM)  runSql(sql, …)   → SqlResult
 *
 * Routing is explicit: `runQuery` talks only to the Rust worker, `runSql` only
 * to the DuckDB worker. `load(rows)` fans the dataset to BOTH so a builder
 * query and a SQL statement run over identical data. Both engines hold the data
 * off the main thread — React never holds raw rows.
 *
 * Both workers share one request-id counter and one pending-request map, since
 * ids are globally unique; responses are matched back to their caller by id.
 *
 * The Rust worker boots on mount (`init`). The DuckDB worker is created on mount
 * but stays idle — its several-MB module downloads lazily inside the worker on
 * the first `runSql`, so it never blocks initial page load.
 *
 * IMPORTANT: the returned object is memoized and every method is `useCallback`-
 * stable, so consumers can safely list them in effect dependency arrays.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChartPayload,
  Query,
  Row,
  SqlToQueryResult,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/types/analytics";
import type { QueryIR } from "@/lib/query/ir";
import {
  DATASET_TABLE,
  tableNameFor,
  type FileSourceKind,
  type RunSqlOptions,
  type SqlColumn,
  type SqlResult,
  type SqlWorkerRequest,
  type SqlWorkerResponse,
} from "@/lib/types/sql";

/** Resolved result of a `runQuery` call. */
export interface QueryResult {
  payload: ChartPayload;
  elapsedMs: number;
}

/** Resolved result of loading a source (server fetch or file) into the engines. */
export interface SourceLoadResult {
  rowCount: number;
  columns: SqlColumn[];
}

/**
 * How the keyed registry should obtain a dataset's rows in `ensureLoaded`.
 * Mirrors the three source classes; only the `file`/`rows` variants ever touch
 * the main thread (a File the user picked, or client-generated rows), and even
 * then the rows are transient — they go straight into a worker, never React.
 */
export type SourceSpec =
  | { kind: "rows"; rows: Row[]; columns?: SqlColumn[] }
  | { kind: "server"; sourceId: string; table?: string; limit?: number; offset?: number }
  | { kind: "file"; file: File };

/** Options for pulling a bounded slice of a server source. */
export interface LoadFromSourceOptions {
  /** Table/view to read; the server validates it against the allowlist. */
  table?: string;
  /** Row cap for this pull (server clamps to its hard cap). */
  limit?: number;
  offset?: number;
}

/** Infer the DuckDB reader from a file's name. */
function inferFileKind(file: File): FileSourceKind {
  const name = file.name.toLowerCase();
  if (name.endsWith(".parquet") || name.endsWith(".pq")) return "parquet";
  if (name.endsWith(".json") || name.endsWith(".ndjson")) return "json";
  return "csv";
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  // Rejects with Error (builder/transport) or SqlError (raw SQL).
  reject: (reason: unknown) => void;
}

export interface AnalyticsEngine {
  /** True once the Rust (builder) WASM module has loaded inside its worker. */
  ready: boolean;
  /** True while any load/query/sql request is in flight. */
  loading: boolean;
  /** Last error message, or null. */
  error: string | null;
  /** Upload an in-memory dataset to BOTH engines once; resolves the row count. */
  load: (rows: Row[]) => Promise<number>;
  /**
   * SERVER source: the DuckDB worker fetches a bounded slice of
   * /api/datasources/[id]/data and feeds BOTH engines — rows never touch the
   * main thread. Resolves with the loaded row count + column schema.
   */
  loadFromSource: (
    sourceId: string,
    opts?: LoadFromSourceOptions,
  ) => Promise<SourceLoadResult>;
  /**
   * FILE source: read bytes client-side and hand them to the worker, which
   * parses (CSV/Parquet/JSON) and feeds BOTH engines. Rows never enter React.
   */
  loadFile: (file: File) => Promise<SourceLoadResult>;
  /** Builder path: query the loaded dataset; resolves with payload + timing. */
  runQuery: (query: Query) => Promise<QueryResult>;
  /** Raw-SQL path: run read-only SQL via DuckDB; resolves a single page. */
  runSql: (sql: string, opts?: RunSqlOptions) => Promise<SqlResult>;
  /**
   * Cancel every in-flight raw-SQL run: their promises reject immediately with
   * "Query cancelled." and a best-effort interrupt is posted to DuckDB. Loads,
   * exports, and pushdown requests are untouched.
   */
  cancelSql: () => void;
  /**
   * EXPLORE: materialize `sql` against `datasetId` and register the result set
   * as its own dataset under `targetId` (queryable via `runSqlOn(targetId, …)`).
   * Lets the IR builder run over the RESULT of a raw SQL statement.
   */
  promoteSqlResult: (
    datasetId: string,
    sql: string,
    targetId: string,
  ) => Promise<SourceLoadResult>;

  // ── Keyed registry (dashboard: many datasets resident at once) ────────────
  /**
   * Load a dataset under `datasetId` if not already resident (idempotent is the
   * caller's job — the scheduler tracks residency). Server sources are fetched
   * inside the worker; rows/file specs carry data straight into a worker.
   */
  ensureLoaded: (datasetId: string, spec: SourceSpec) => Promise<SourceLoadResult>;
  /** Builder path against a specific dataset id (swaps it into Rust if needed). */
  runQueryOn: (datasetId: string, query: Query) => Promise<QueryResult>;
  /** Raw-SQL path against a specific dataset id (targets that id's table). */
  runSqlOn: (datasetId: string, sql: string, opts?: RunSqlOptions) => Promise<SqlResult>;
  /**
   * PUSHDOWN: POST a `QueryIR` to /api/datasources/[id]/run (compiled + run on
   * the live DB server-side) and ingest the small Arrow result under `datasetId`
   * — the worker fetches it, so rows never touch the main thread. Resolves with
   * the loaded row count + columns; query the result via `runSqlOn(datasetId, …)`.
   */
  runPushdown: (
    datasetId: string,
    sourceId: string,
    ir: QueryIR,
  ) => Promise<SourceLoadResult>;
  /** Full-result CSV export for a specific dataset id's statement. */
  exportSqlCsvOn: (datasetId: string, sql: string) => Promise<string>;
  /** Drop a dataset from both engines (dashboard removed its last consumer). */
  evictDataset: (datasetId: string) => void;
  /** DuckDB table name a SQL widget references for `datasetId`. */
  tableNameForId: (datasetId: string) => string;
  /**
   * Export the FULL materialized result of a SQL statement as a CSV string.
   * Serialized inside the worker (reusing the cached Arrow result), so the
   * whole dataset never crosses into React beyond the final string.
   */
  exportSqlCsv: (sql: string) => Promise<string>;
  /** Bridge (translation only): builder Query → SQL string. */
  queryToSql: (query: Query) => Promise<string>;
  /**
   * Bridge (translation only): SQL string → builder Query. Resolves a
   * `SqlToQueryResult`; REJECTS with a `BridgeParseError` for malformed SQL.
   */
  sqlToQuery: (sql: string) => Promise<SqlToQueryResult>;
  /** Table name the dataset is registered under (for SQL autocomplete/schema). */
  tableName: string;
}

const DEFAULT_SQL_LIMIT = 1000;

export function useAnalyticsEngine(): AnalyticsEngine {
  const chartRef = useRef<Worker | null>(null);
  const sqlRef = useRef<Worker | null>(null);
  const pending = useRef<Map<number, PendingRequest>>(new Map());
  const requestSeq = useRef(0);

  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Capture the (stable, never-reassigned) pending map so the cleanup below
    // references the same instance that was live when the effect mounted.
    const pendingRequests = pending.current;
    // Settle a pending request by id; clear the busy flag when the queue drains.
    const settle = (
      requestId: number,
      outcome: { ok: true; value: unknown } | { ok: false; reason: unknown },
    ) => {
      const req = pending.current.get(requestId);
      if (req) {
        pending.current.delete(requestId);
        if (outcome.ok) req.resolve(outcome.value);
        else req.reject(outcome.reason);
      }
      if (pending.current.size === 0) setLoading(false);
    };

    // ── Builder engine (Rust/WASM) ──────────────────────────────────────────
    const chart = new Worker(
      new URL("../workers/chart.worker.ts", import.meta.url),
      { type: "module" },
    );
    chartRef.current = chart;

    chart.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      switch (msg.type) {
        case "ready":
          setReady(true);
          break;
        case "loaded":
          settle(msg.requestId, { ok: true, value: msg.rows });
          break;
        case "result":
          settle(msg.requestId, {
            ok: true,
            value: { payload: msg.payload, elapsedMs: msg.elapsedMs },
          });
          break;
        case "sql_text":
          // Bridge: Query → SQL (deterministic).
          settle(msg.requestId, { ok: true, value: msg.sql });
          break;
        case "bridge_result":
          // Bridge: SQL → Query (best-effort SqlToQueryResult).
          settle(msg.requestId, { ok: true, value: msg.result });
          break;
        case "bridge_parse_error":
          // Malformed SQL → reject with the structured BridgeParseError.
          settle(msg.requestId, { ok: false, reason: msg.error });
          break;
        case "error":
          setError(msg.message);
          if (msg.requestId !== null)
            settle(msg.requestId, {
              ok: false,
              reason: new Error(msg.message),
            });
          else if (pending.current.size === 0) setLoading(false);
          break;
      }
    };
    chart.onerror = (e) => setError(e.message || "Builder worker crashed");

    // ── Raw-SQL engine (DuckDB-WASM) ────────────────────────────────────────
    const sql = new Worker(
      new URL("../workers/sql.worker.ts", import.meta.url),
      { type: "module" },
    );
    sqlRef.current = sql;

    sql.onmessage = (event: MessageEvent<SqlWorkerResponse>) => {
      const msg = event.data;
      switch (msg.type) {
        case "loaded":
          settle(msg.requestId, { ok: true, value: msg.rows });
          break;
        case "source_loaded":
          settle(msg.requestId, {
            ok: true,
            value: { rowCount: msg.rowCount, columns: msg.columns },
          });
          break;
        case "sql_result":
          settle(msg.requestId, { ok: true, value: msg.result });
          break;
        case "csv":
          settle(msg.requestId, { ok: true, value: msg.csv });
          break;
        case "sql_error":
          // Reject with the structured SqlError (NOT a generic Error).
          settle(msg.requestId, { ok: false, reason: msg.error });
          break;
        case "error":
          setError(msg.message);
          if (msg.requestId !== null)
            settle(msg.requestId, {
              ok: false,
              reason: new Error(msg.message),
            });
          else if (pending.current.size === 0) setLoading(false);
          break;
      }
    };
    sql.onerror = (e) => setError(e.message || "SQL worker crashed");

    // Establish the private worker↔worker channel so the DuckDB worker can feed
    // parsed source rows to the Rust worker without crossing the main thread.
    const link = new MessageChannel();
    chart.postMessage({ type: "link" } satisfies WorkerRequest, [link.port1]);
    sql.postMessage({ type: "link" } satisfies SqlWorkerRequest, [link.port2]);

    // Boot the Rust module now; DuckDB stays lazy (no init message).
    chart.postMessage({ type: "init" } satisfies WorkerRequest);

    return () => {
      pendingRequests.forEach((req) =>
        req.reject(new Error("Worker terminated")),
      );
      pendingRequests.clear();
      chart.terminate();
      sql.terminate();
      chartRef.current = null;
      sqlRef.current = null;
    };
  }, []);

  /** In-flight raw-SQL run request ids — the set `cancelSql` sweeps. */
  const sqlRunIds = useRef<Set<number>>(new Set());

  /** Register a pending request and post it to a specific worker. */
  const dispatch = useCallback(
    <T,>(
      worker: Worker | null,
      build: (requestId: number) => WorkerRequest | SqlWorkerRequest,
      transfer?: Transferable[],
      onRegister?: (requestId: number) => void,
    ) =>
      new Promise<T>((resolve, reject) => {
        if (!worker) return reject(new Error("Worker not available"));
        const requestId = ++requestSeq.current;
        pending.current.set(requestId, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        onRegister?.(requestId);
        setLoading(true);
        setError(null);
        worker.postMessage(build(requestId), transfer ?? []);
      }),
    [],
  );

  // ── Keyed primitives (the whole registry rides on these) ──────────────────

  /** Load a dataset's rows under `datasetId` into BOTH engines. */
  const loadRowsOn = useCallback(
    (datasetId: string, rows: Row[], columns?: SqlColumn[]) => {
      const toChart = dispatch<number>(chartRef.current, (requestId) => ({
        type: "load",
        requestId,
        datasetId,
        rows,
      }));
      const toSql = dispatch<number>(sqlRef.current, (requestId) => ({
        type: "load",
        requestId,
        datasetId,
        rows,
      }));
      // Columns: explicit if given, else inferred from one row's keys (never
      // holds the dataset — only reads the shape of a single row).
      const cols: SqlColumn[] =
        columns ??
        Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "string" }));
      return Promise.all([toChart, toSql]).then(([rowCount]) => ({
        rowCount,
        columns: cols,
      }));
    },
    [dispatch],
  );

  const ensureLoaded = useCallback(
    (datasetId: string, spec: SourceSpec): Promise<SourceLoadResult> => {
      switch (spec.kind) {
        case "rows":
          return loadRowsOn(datasetId, spec.rows, spec.columns);
        case "server":
          // The DuckDB worker fetches the slice + fans it to Rust over the peer
          // channel; rows never reach React.
          return dispatch<SourceLoadResult>(sqlRef.current, (requestId) => ({
            type: "load_source",
            requestId,
            datasetId,
            sourceId: spec.sourceId,
            table: spec.table,
            limit: spec.limit,
            offset: spec.offset,
          }));
        case "file":
          return spec.file.arrayBuffer().then((bytes) =>
            dispatch<SourceLoadResult>(
              sqlRef.current,
              (requestId) => ({
                type: "load_file",
                requestId,
                datasetId,
                fileKind: inferFileKind(spec.file),
                bytes,
                fileName: spec.file.name,
              }),
              [bytes],
            ),
          );
      }
    },
    [dispatch, loadRowsOn],
  );

  const runQueryOn = useCallback(
    (datasetId: string, query: Query) =>
      dispatch<QueryResult>(chartRef.current, (requestId) => ({
        type: "query",
        requestId,
        datasetId,
        query,
      })),
    [dispatch],
  );

  const runSqlOn = useCallback(
    (datasetId: string, sql: string, opts?: RunSqlOptions) => {
      let trackedId = 0;
      return dispatch<SqlResult>(
        sqlRef.current,
        (requestId) => ({
          type: "sql",
          requestId,
          datasetId,
          sql,
          limit: opts?.limit ?? DEFAULT_SQL_LIMIT,
          offset: opts?.offset ?? 0,
        }),
        undefined,
        (requestId) => {
          trackedId = requestId;
          sqlRunIds.current.add(requestId);
        },
      ).finally(() => sqlRunIds.current.delete(trackedId));
    },
    [dispatch],
  );

  /** Reject every in-flight SQL run now; nudge DuckDB to stop, best-effort. */
  const cancelSql = useCallback(() => {
    sqlRef.current?.postMessage({ type: "cancel" } satisfies SqlWorkerRequest);
    const ids = [...sqlRunIds.current];
    sqlRunIds.current.clear();
    for (const id of ids) {
      const req = pending.current.get(id);
      if (req) {
        pending.current.delete(id);
        req.reject({ kind: "execution", message: "Query cancelled." });
      }
    }
    if (pending.current.size === 0) setLoading(false);
  }, []);

  const promoteSqlResult = useCallback(
    (datasetId: string, sql: string, targetId: string) =>
      dispatch<SourceLoadResult>(sqlRef.current, (requestId) => ({
        type: "promote",
        requestId,
        datasetId,
        sql,
        targetId,
      })),
    [dispatch],
  );

  const runPushdown = useCallback(
    (datasetId: string, sourceId: string, ir: QueryIR) =>
      dispatch<SourceLoadResult>(sqlRef.current, (requestId) => ({
        type: "run_pushdown",
        requestId,
        datasetId,
        sourceId,
        ir,
      })),
    [dispatch],
  );

  const exportSqlCsvOn = useCallback(
    (datasetId: string, sql: string) =>
      dispatch<string>(sqlRef.current, (requestId) => ({
        type: "export_csv",
        requestId,
        datasetId,
        sql,
      })),
    [dispatch],
  );

  const evictDataset = useCallback((datasetId: string) => {
    // Fire-and-forget on both workers (no reply expected).
    chartRef.current?.postMessage({ type: "evict", datasetId } satisfies WorkerRequest);
    sqlRef.current?.postMessage({ type: "evict", datasetId } satisfies SqlWorkerRequest);
  }, []);

  // ── Single-dataset methods (query panel) — the default `dataset` id ───────

  const load = useCallback(
    (rows: Row[]) => loadRowsOn(DATASET_TABLE, rows).then((r) => r.rowCount),
    [loadRowsOn],
  );

  const loadFromSource = useCallback(
    (sourceId: string, opts?: LoadFromSourceOptions) =>
      ensureLoaded(DATASET_TABLE, {
        kind: "server",
        sourceId,
        table: opts?.table,
        limit: opts?.limit,
        offset: opts?.offset,
      }),
    [ensureLoaded],
  );

  const loadFile = useCallback(
    (file: File): Promise<SourceLoadResult> =>
      ensureLoaded(DATASET_TABLE, { kind: "file", file }),
    [ensureLoaded],
  );

  const runQuery = useCallback(
    (query: Query) => runQueryOn(DATASET_TABLE, query),
    [runQueryOn],
  );

  const runSql = useCallback(
    (sql: string, opts?: RunSqlOptions) => runSqlOn(DATASET_TABLE, sql, opts),
    [runSqlOn],
  );

  const exportSqlCsv = useCallback(
    (sql: string) => exportSqlCsvOn(DATASET_TABLE, sql),
    [exportSqlCsvOn],
  );

  // Bridge methods route to the Rust worker (translation, not execution).
  const queryToSql = useCallback(
    (query: Query) =>
      dispatch<string>(chartRef.current, (requestId) => ({
        type: "query_to_sql",
        requestId,
        query,
      })),
    [dispatch],
  );

  const sqlToQuery = useCallback(
    (sql: string) =>
      dispatch<SqlToQueryResult>(chartRef.current, (requestId) => ({
        type: "sql_to_query",
        requestId,
        sql,
      })),
    [dispatch],
  );

  return useMemo(
    () => ({
      ready,
      loading,
      error,
      load,
      loadFromSource,
      loadFile,
      runQuery,
      runSql,
      cancelSql,
      promoteSqlResult,
      exportSqlCsv,
      ensureLoaded,
      runQueryOn,
      runSqlOn,
      runPushdown,
      exportSqlCsvOn,
      evictDataset,
      tableNameForId: tableNameFor,
      queryToSql,
      sqlToQuery,
      tableName: DATASET_TABLE,
    }),
    [
      ready,
      loading,
      error,
      load,
      loadFromSource,
      loadFile,
      runQuery,
      runSql,
      cancelSql,
      promoteSqlResult,
      exportSqlCsv,
      ensureLoaded,
      runQueryOn,
      runSqlOn,
      runPushdown,
      exportSqlCsvOn,
      evictDataset,
      queryToSql,
      sqlToQuery,
    ],
  );
}
