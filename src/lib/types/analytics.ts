/**
 * Shared contract between the React UI, the Web Worker, and the Rust engine.
 *
 * These types MUST stay in lock-step with `wasm/src/lib.rs`. The field names
 * here (snake_case for query fields) match serde's expectations on the Rust
 * side, so the JSON crosses the boundary with zero transformation.
 */

/** A raw cell value as it arrives from CSV/JSON/DB. */
export type Cell = string | number | boolean | null;

/** A raw dataset row: column name → cell. */
export type Row = Record<string, Cell>;

/** Comparison operators — mirror of Rust `Operator` (serde snake_case). */
export type Operator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "in_list";

/** Aggregation functions — mirror of Rust `AggFn`. */
export type AggFn = "sum" | "avg" | "count" | "min" | "max";

export type SortDir = "asc" | "desc";

export interface Filter {
  column: string;
  operator: Operator;
  /** Scalar target (all operators except `in_list`). */
  value?: Cell;
  /** Set target (only `in_list`). */
  values?: Cell[];
}

export interface Aggregation {
  /** Omitted/undefined for COUNT. */
  column?: string;
  func: AggFn;
}

/** The declarative query the UI sends to the engine. */
export interface Query {
  filters?: Filter[];
  group_by: string;
  aggregation: Aggregation;
  sort?: SortDir;
  limit?: number;
}

/** One bar/point in the chart. */
export interface DataPoint {
  label: string;
  value: number;
}

/** The chart-ready result returned by the Rust engine. */
export interface ChartPayload {
  points: DataPoint[];
  rows_matched: number;
  rows_total: number;
  metric_label: string;
}

// ---------------------------------------------------------------------------
// Builder ↔ SQL bridge (translation only — NOT execution)
// ---------------------------------------------------------------------------

/**
 * Result of translating a SQL string back into a builder `Query`.
 *
 * `ok:true`  → the SQL fits the builder's subset; `query` is the equivalent.
 * `ok:false` → valid SQL that the builder can't represent; `reason` explains
 *              why (e.g. "JOINs aren't supported in the builder"). The caller
 *              should keep the user in SQL mode and surface the reason — never
 *              discard their SQL.
 *
 * A genuinely malformed SQL string does NOT produce this — it REJECTS the
 * `sqlToQuery` promise with a `BridgeParseError`.
 */
export type SqlToQueryResult =
  | { ok: true; query: Query }
  | { ok: false; reason: string };

/** Rejection shape for a malformed SQL string passed to `sqlToQuery`. */
export interface BridgeParseError {
  kind: "parse";
  message: string;
  line?: number;
  column?: number;
}

// ---------------------------------------------------------------------------
// Worker message protocol (typed both directions)
// ---------------------------------------------------------------------------

/**
 * Private worker↔worker channel (a `MessagePort` pair). The DuckDB worker is
 * the data-loading worker: it fetches/parses a source and forwards the Arrow
 * IPC bytes to the Rust worker over this port — zero-copy via transfer — so a
 * source's data reaches BOTH engines without ever touching the main thread.
 * Each direction has its own messages.
 */
export type PeerToChart = {
  // DuckDB worker → Rust worker: stash Arrow IPC bytes in the Rust worker's
  // keyed dataset cache under `id`. The Rust engine derives Row[] lazily from
  // the IPC on the first query for that id and caches the result.
  kind: "ingest";
  token: number;
  id: string;
  /** Arrow IPC stream bytes — transferred (not copied) across the worker boundary. */
  ipc: ArrayBuffer;
};
export type PeerFromChart =
  | { kind: "ingested"; token: number; rowCount: number }
  | { kind: "ingest_error"; token: number; message: string };

/** Messages the main thread posts INTO the worker. */
export type WorkerRequest =
  | { type: "init" }
  | {
      // Hand the Rust worker its end of the private peer channel (port in
      // `event.ports[0]`). Sent once, right after spawn.
      type: "link";
    }
  | {
      // Stash a dataset's rows in the worker's keyed row cache under `datasetId`
      // (loaded into the single Rust engine lazily, on first query for that id).
      type: "load";
      /** Correlation id so responses can be matched to requests. */
      requestId: number;
      datasetId: string;
      rows: Row[];
    }
  | {
      // Run a query against `datasetId`. The worker swaps that dataset into the
      // single Rust engine first if it isn't the currently-active one.
      type: "query";
      requestId: number;
      datasetId: string;
      query: Query;
    }
  | {
      // Drop a dataset from the worker's keyed row cache (source removed).
      type: "evict";
      datasetId: string;
    }
  | {
      // Bridge: translate a builder Query → SQL string (no execution).
      type: "query_to_sql";
      requestId: number;
      query: Query;
    }
  | {
      // Bridge: translate a SQL string → builder Query (no execution).
      type: "sql_to_query";
      requestId: number;
      sql: string;
    };

/** Messages the worker posts BACK to the main thread. */
export type WorkerResponse =
  | { type: "ready" }
  | { type: "loaded"; requestId: number; rows: number }
  | { type: "result"; requestId: number; payload: ChartPayload; elapsedMs: number }
  | { type: "sql_text"; requestId: number; sql: string }
  | { type: "bridge_result"; requestId: number; result: SqlToQueryResult }
  | { type: "bridge_parse_error"; requestId: number; error: BridgeParseError }
  | { type: "error"; requestId: number | null; message: string };
