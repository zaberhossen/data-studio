/**
 * chart.worker.ts — the JS ↔ Rust bridge, running OFF the main thread.
 *
 * Lifecycle:
 *   1. Main thread spawns this worker and posts `{ type: "init" }`.
 *   2. We dynamically import the wasm-pack glue and call its default init(),
 *      which fetches + instantiates the `.wasm` binary. Done once.
 *   3. We reply `{ type: "ready" }`.
 *   4. For each `{ type: "query" }` we hand the dataset + query straight to
 *      Rust's `query()` and post the chart-ready payload back.
 *
 * Arrow-canonical internals (worker-layer only — no React-facing change):
 *   • Per-datasetId storage holds Arrow IPC bytes (from the peer port) OR
 *     Row[] (from a direct `load` message). Row[] is NEVER re-derived from IPC
 *     when already present; IPC → Row[] conversion is LAZY and CACHED so the
 *     first builder query for a given id pays the cost and subsequent queries
 *     (including after a Rust engine swap) reuse the cached rows.
 *   • The peer port receives Arrow IPC as a transferred ArrayBuffer — zero-copy.
 */

/// <reference lib="webworker" />

import { tableFromIPC } from "apache-arrow";
import type {
  BridgeParseError,
  Cell,
  PeerToChart,
  Row,
  SqlToQueryResult,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/types/analytics";

type WasmModule = typeof import("@/wasm/pkg/analytics_engine");

let wasm: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

// ── Per-dataset storage ──────────────────────────────────────────────────────
//
// `ipc`  — Arrow IPC bytes received from the peer port (sql.worker).
// `rows` — Row[] either loaded directly via `load` message OR derived lazily
//           from `ipc` on the first builder query for this id (then cached).
//
// Invariant: at least one of { ipc, rows } is non-null for a resident dataset.
interface DatasetEntry {
  ipc: Uint8Array | null;
  rows: Row[] | null;
}

const datasets = new Map<string, DatasetEntry>();
/** The dataset id currently resident in the Rust engine, or null if none. */
let activeId: string | null = null;

// ── Arrow IPC → Row[] (lazy, cached inside ensureActive) ─────────────────────

/** Make an Arrow cell structured-clone + JSON friendly. */
function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Coerce an Arrow cell into a `Cell` (string | number | boolean | null). */
function toCell(value: unknown): Cell {
  const v = normalize(value);
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  return String(v);
}

/** Decode Arrow IPC bytes into Row[] for the Rust engine. */
function arrowIpcToRows(ipc: Uint8Array): Row[] {
  const table = tableFromIPC(ipc);
  const names = table.schema.fields.map((f) => f.name);
  const rows: Row[] = new Array(table.numRows);
  for (let i = 0; i < table.numRows; i++) {
    const r = table.get(i) as Record<string, unknown> | null;
    const obj: Row = {};
    for (const name of names) obj[name] = toCell(r?.[name]);
    rows[i] = obj;
  }
  return rows;
}

/**
 * Make `datasetId` the active dataset in the Rust engine, loading it lazily if
 * it isn't already resident. Row[] is derived from Arrow IPC ONCE per dataset
 * and cached so repeat engine swaps do not re-convert.
 */
async function ensureActive(datasetId: string): Promise<void> {
  await ensureReady();
  if (!wasm) throw new Error("WASM module not initialized");
  if (activeId === datasetId) return;

  const entry = datasets.get(datasetId);
  if (!entry) {
    throw new Error(`Dataset "${datasetId}" is not loaded in the builder engine.`);
  }

  // Derive rows from IPC lazily on first access; cache to avoid re-conversion.
  if (!entry.rows) {
    if (!entry.ipc) {
      throw new Error(`Dataset "${datasetId}" has no data available.`);
    }
    entry.rows = arrowIpcToRows(entry.ipc);
  }

  wasm.load_dataset(entry.rows);
  activeId = datasetId;
}

/** Idempotently load + instantiate the WASM module. */
function ensureReady(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const mod = (await import("@/wasm/pkg/analytics_engine")) as WasmModule;
      await mod.default();
      wasm = mod;
    })();
  }
  return initPromise;
}

/** Strongly-typed post back to the main thread. */
function reply(message: WorkerResponse) {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

/**
 * Private channel to the DuckDB worker. The DuckDB worker fetches/parses a
 * source off-thread and forwards Arrow IPC bytes here as a transferable
 * ArrayBuffer — zero-copy across the worker boundary.
 */
function attachPeerPort(port: MessagePort) {
  port.onmessage = (event: MessageEvent<PeerToChart>) => {
    const msg = event.data;
    if (msg.kind !== "ingest") return;
    try {
      const ipc = new Uint8Array(msg.ipc);
      // Store IPC as canonical; derive Row[] lazily on first query for this id.
      datasets.set(msg.id, { ipc, rows: null });
      if (activeId === msg.id) activeId = null; // invalidate if replacing active

      // Parse rowCount from the IPC metadata (fast: reads header only).
      const table = tableFromIPC(ipc);
      port.postMessage({ kind: "ingested", token: msg.token, rowCount: table.numRows });
    } catch (err) {
      port.postMessage({
        kind: "ingest_error",
        token: msg.token,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

function asBridgeParseError(thrown: unknown): BridgeParseError {
  if (
    thrown &&
    typeof thrown === "object" &&
    "kind" in thrown &&
    (thrown as { kind?: unknown }).kind === "parse"
  ) {
    return thrown as BridgeParseError;
  }
  return {
    kind: "parse",
    message: thrown instanceof Error ? thrown.message : String(thrown),
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case "init": {
        await ensureReady();
        reply({ type: "ready" });
        break;
      }

      case "link": {
        const port = event.ports[0];
        if (port) attachPeerPort(port);
        break;
      }

      case "load": {
        // Direct Row[] from the main thread (e.g. query-panel manual load).
        // Store rows immediately; no IPC needed for this path since we already
        // have the decoded values. Invalidate activeId if replacing.
        datasets.set(msg.datasetId, { ipc: null, rows: msg.rows });
        if (activeId === msg.datasetId) activeId = null;
        reply({ type: "loaded", requestId: msg.requestId, rows: msg.rows.length });
        break;
      }

      case "query": {
        await ensureActive(msg.datasetId);
        if (!wasm) throw new Error("WASM module not initialized");

        const start = performance.now();
        const payload = wasm.query(msg.query);
        const elapsedMs = performance.now() - start;
        reply({ type: "result", requestId: msg.requestId, payload, elapsedMs });
        break;
      }

      case "evict": {
        datasets.delete(msg.datasetId);
        if (activeId === msg.datasetId) activeId = null;
        break;
      }

      case "query_to_sql": {
        await ensureReady();
        if (!wasm) throw new Error("WASM module not initialized");

        const sql = wasm.query_to_sql(msg.query) as string;
        reply({ type: "sql_text", requestId: msg.requestId, sql });
        break;
      }

      case "sql_to_query": {
        await ensureReady();
        if (!wasm) throw new Error("WASM module not initialized");

        try {
          const result = wasm.sql_to_query(msg.sql) as SqlToQueryResult;
          reply({ type: "bridge_result", requestId: msg.requestId, result });
        } catch (thrown) {
          reply({
            type: "bridge_parse_error",
            requestId: msg.requestId,
            error: asBridgeParseError(thrown),
          });
        }
        break;
      }

      default: {
        const _never: never = msg;
        throw new Error(`Unknown message: ${JSON.stringify(_never)}`);
      }
    }
  } catch (err) {
    const requestId = "requestId" in msg ? msg.requestId : null;
    reply({
      type: "error",
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};
