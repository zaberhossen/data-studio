/**
 * sql.worker.ts — the RAW-SQL engine, running OFF the main thread.
 *
 * This is the DuckDB-WASM counterpart to `chart.worker.ts` (the Rust engine).
 * The two never mix: the hook owns both workers and routes `runQuery` → Rust
 * and `runSql` → here. This file does NOT touch the Rust engine.
 *
 * Arrow-canonical internals (worker-layer only — no React-facing change):
 *   • Canonical per-dataset format is Arrow IPC bytes (`Uint8Array`).
 *   • fetch layer (/api/datasources/[id]/data) emits Arrow IPC; a JSON
 *     fallback path converts to Arrow at ingest if the server returns JSON.
 *   • DuckDB is populated via `insertArrowFromIPCStream` — no JSON round-trip.
 *   • The peer port forwards Arrow IPC (as a transferable ArrayBuffer) to the
 *     Rust worker; that worker derives Row[] lazily and caches the result.
 *   • Type derivation reads Arrow schema field typeIds (or the X-Ds-Columns
 *     header from the server when connector types are more authoritative).
 *
 * Lifecycle / laziness:
 *   • On `load` the rows are converted to Arrow IPC and STASHED. DuckDB-WASM
 *     is NOT downloaded yet, so initial page load stays cheap.
 *   • On the FIRST `sql` request we instantiate DuckDB (CDN bundle, single-
 *     threaded — no COOP/COEP needed) and ingest the stashed IPC once.
 *
 * Pagination: a statement is executed ONCE; the full Arrow result is cached in
 * this worker keyed by the SQL text. Later pages with the same SQL are a cheap
 * Arrow `slice`, never a re-execution.
 */

/// <reference lib="webworker" />

import * as duckdb from "@duckdb/duckdb-wasm";
import { Type, tableFromJSON, tableFromIPC, tableToIPC, type Table } from "apache-arrow";
import {
  tableNameFor,
  type FileSourceKind,
  type SqlColumn,
  type SqlColumnType,
  type SqlError,
  type SqlWorkerRequest,
  type SqlWorkerResponse,
} from "@/lib/types/sql";
import type { PeerFromChart, Row } from "@/lib/types/analytics";

/** How many distinct result sets to keep materialized for instant paging. */
const RESULT_CACHE_MAX = 8;

// ── Module-level engine state ──────────────────────────────────────────────
let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let initPromise: Promise<void> | null = null;

/**
 * KEYED REGISTRY: one DuckDB table per dataset id. DuckDB is natively
 * multi-table, so a dashboard's many sources are all resident at once — no
 * swapping. Arrow IPC bytes are the canonical in-worker representation;
 * they are ingested into DuckDB natively via insertArrowFromIPCStream.
 */
interface DatasetEntry {
  /** DuckDB table name (see {@link tableNameFor}). */
  table: string;
  /**
   * Arrow IPC bytes awaiting lazy ingest into DuckDB; null once the table
   * exists in DuckDB (either ingested from here or created by handleLoadFile).
   */
  pendingIpc: Uint8Array | null;
  ingested: boolean;
}
const registry = new Map<string, DatasetEntry>();

/**
 * Materialized full results, keyed by `${datasetId}\0${sql}` (insertion-ordered
 * LRU). Keying by id keeps two sources' identically-worded statements distinct.
 */
const resultCache = new Map<string, Table>();

const cacheKey = (datasetId: string, sql: string) => `${datasetId} ${sql}`;

// ── Private channel to the Rust worker (IPC bytes are transferred, not copied) ─
let peerPort: MessagePort | null = null;
let peerSeq = 0;
const peerPending = new Map<
  number,
  { resolve: (rowCount: number) => void; reject: (reason: Error) => void }
>();

function attachPeerPort(port: MessagePort) {
  peerPort = port;
  port.onmessage = (event: MessageEvent<PeerFromChart>) => {
    const msg = event.data;
    const waiter = peerPending.get(msg.token);
    if (!waiter) return;
    peerPending.delete(msg.token);
    if (msg.kind === "ingested") waiter.resolve(msg.rowCount);
    else waiter.reject(new Error(msg.message));
  };
}

/**
 * Forward Arrow IPC bytes to the Rust engine (stashed under `id`).
 * The ArrayBuffer is TRANSFERRED (zero-copy); the caller must not use it after
 * this returns. Resolves to the rowCount confirmed by the chart worker.
 */
function feedRustEngine(id: string, ipc: ArrayBuffer): Promise<number> {
  if (!peerPort) {
    return Promise.reject(new Error("Rust engine channel not linked."));
  }
  const token = ++peerSeq;
  return new Promise<number>((resolve, reject) => {
    peerPending.set(token, { resolve, reject });
    peerPort!.postMessage({ kind: "ingest", token, id, ipc }, [ipc]);
  });
}

function reply(message: SqlWorkerResponse) {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

// ── Lazy DuckDB instantiation (CDN, single-threaded) ────────────────────────
function ensureDuckReady(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const bundles = duckdb.getJsDelivrBundles();
      const bundle = await duckdb.selectBundle(bundles);

      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker!}");`], {
          type: "text/javascript",
        }),
      );
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      const dbWorker = new Worker(workerUrl);
      db = new duckdb.AsyncDuckDB(logger, dbWorker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      conn = await db.connect();
    })();
  }
  return initPromise;
}

/**
 * Ingest a stashed Arrow IPC dataset into its own DuckDB table exactly once.
 * Uses insertArrowFromIPCStream — no JSON round-trip.
 */
async function ensureIngested(datasetId: string): Promise<void> {
  const entry = registry.get(datasetId);
  if (!entry || entry.ingested || !db || !conn || !entry.pendingIpc) return;

  // Drop any stale table from a previous load of this dataset.
  await conn.query(`DROP TABLE IF EXISTS "${entry.table}"`);
  await conn.insertArrowFromIPCStream(entry.pendingIpc, {
    name: entry.table,
    create: true,
  });

  entry.ingested = true;
  entry.pendingIpc = null; // release memory; DuckDB now owns the data
}

// ── Arrow type mapping ───────────────────────────────────────────────────────
function mapColumnType(typeId: number): SqlColumnType {
  switch (typeId) {
    case Type.Int:
    case Type.Float:
    case Type.Decimal:
      return "number";
    case Type.Bool:
      return "bool";
    case Type.Date:
    case Type.Timestamp:
    case Type.Time:
      return "date";
    case Type.Utf8:
    case Type.LargeUtf8:
      return "string";
    default:
      return "string";
  }
}

/** Make an Arrow cell structured-clone + JSON friendly for the UI. */
function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

// ── Safety: read-only SELECT / WITH only ────────────────────────────────────
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|attach|detach|copy|install|load|pragma|set|reset|export|import|truncate|replace|grant|revoke|call|vacuum|checkpoint|begin|commit|rollback)\b/i;

function assertReadOnly(sql: string): SqlError | null {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();

  if (!stripped) return { kind: "parse", message: "Empty statement." };

  const body = stripped.replace(/;\s*$/, "");
  if (body.includes(";")) {
    return { kind: "parse", message: "Only a single statement is allowed." };
  }
  if (!/^(select|with)\b/i.test(body)) {
    return {
      kind: "parse",
      message: "Only read-only SELECT / WITH queries are allowed.",
    };
  }
  const hit = body.match(FORBIDDEN);
  if (hit) {
    return {
      kind: "parse",
      message: `Statement type "${hit[1].toUpperCase()}" is not allowed — only read-only SELECT / WITH queries can run.`,
    };
  }
  return null;
}

// ── Error mapping (no raw stack traces leak to the UI) ──────────────────────
function toSqlError(err: unknown): SqlError {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw
    .split("\n")
    .filter((l) => !/^\s*at\s/.test(l))
    .join("\n")
    .replace(/^Error:\s*/, "")
    .trim();

  if (/Parser Error|syntax error/i.test(raw)) {
    const line = raw.match(/LINE\s+(\d+)/i);
    return {
      kind: "parse",
      message,
      line: line ? Number(line[1]) : undefined,
    };
  }
  return { kind: "execution", message };
}

// ── Cache helpers (insertion-ordered, capped) ───────────────────────────────
function cachePut(key: string, table: Table) {
  if (!resultCache.has(key) && resultCache.size >= RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next().value as string | undefined;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(key, table);
}

/** Drop every cached result belonging to a dataset (its rows changed/left). */
function clearDatasetCache(datasetId: string) {
  const prefix = `${datasetId} `;
  for (const key of resultCache.keys()) {
    if (key.startsWith(prefix)) resultCache.delete(key);
  }
}

// ── Arrow IPC stashing ───────────────────────────────────────────────────────

/** Store Arrow IPC bytes for `datasetId`; DuckDB ingest happens lazily on first query. */
function stashArrow(datasetId: string, ipc: Uint8Array) {
  registry.set(datasetId, {
    table: tableNameFor(datasetId),
    pendingIpc: ipc,
    ingested: false,
  });
  clearDatasetCache(datasetId);
}

// ── Source loading ───────────────────────────────────────────────────────────

/**
 * SERVER source: fetch Arrow IPC from the data endpoint INSIDE the worker
 * (bytes never touch the main thread), stash for DuckDB, and transfer to the
 * Rust engine over the private channel. Falls back to JSON→Arrow conversion if
 * the server returns JSON instead of Arrow IPC.
 */
async function handleLoadSource(
  requestId: number,
  datasetId: string,
  sourceId: string,
  table: string | undefined,
  limit: number | undefined,
  offset: number | undefined,
): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (table) params.set("table", table);
    if (limit != null) params.set("limit", String(limit));
    if (offset != null) params.set("offset", String(offset));

    const res = await fetch(
      `/api/datasources/${encodeURIComponent(sourceId)}/data?${params.toString()}`,
      { headers: { Accept: "application/vnd.apache.arrow.stream" } },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Data request failed (${res.status}).`);
    }

    const contentType = res.headers.get("Content-Type") ?? "";
    let ipcForRegistry: Uint8Array;
    let ipcForTransfer: ArrayBuffer;
    let columns: SqlColumn[];
    let rowCount: number;

    if (contentType.includes("application/vnd.apache.arrow.stream")) {
      // ── Native Arrow IPC path ──────────────────────────────────────────────
      const buffer = await res.arrayBuffer();
      // Parse schema + rowCount before transferring the buffer.
      const arrowTable = tableFromIPC(new Uint8Array(buffer));
      rowCount = arrowTable.numRows;

      // Column types: prefer the authoritative X-Ds-Columns header (preserves
      // connector type mapping, e.g. date vs string for ISO-string columns).
      const dsColumnsHeader = res.headers.get("X-Ds-Columns");
      if (dsColumnsHeader) {
        columns = JSON.parse(dsColumnsHeader) as SqlColumn[];
      } else {
        columns = arrowTable.schema.fields.map((f) => ({
          name: f.name,
          type: mapColumnType(f.type.typeId),
        }));
      }

      // Keep a copy for DuckDB (pendingIpc); transfer the original to Rust.
      ipcForRegistry = new Uint8Array(buffer.slice(0));
      ipcForTransfer = buffer; // transferred → detaches buffer after postMessage
    } else {
      // ── JSON fallback: convert to Arrow IPC at ingest ──────────────────────
      const body = (await res.json()) as { columns?: SqlColumn[]; rows?: Row[] };
      const rows = body.rows ?? [];
      columns =
        body.columns ??
        Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "string" as SqlColumnType }));

      const arrowTable = tableFromJSON(rows as Record<string, unknown>[]);
      const ipc = tableToIPC(arrowTable, "stream");
      rowCount = arrowTable.numRows;

      ipcForRegistry = new Uint8Array(ipc); // copy (ipc might share buffer)
      ipcForTransfer = ipc.buffer.slice(ipc.byteOffset, ipc.byteOffset + ipc.byteLength) as ArrayBuffer;
    }

    stashArrow(datasetId, ipcForRegistry);
    await feedRustEngine(datasetId, ipcForTransfer);

    reply({ type: "source_loaded", requestId, rowCount, columns });
  } catch (err) {
    reply({
      type: "error",
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * PUSHDOWN: POST a QueryIR to /api/datasources/[id]/run — the server compiles it
 * to dialect SQL, runs it on the LIVE database, and returns the small aggregated
 * result as Arrow IPC. We fetch it INSIDE the worker (rows never touch the main
 * thread) and stash it under `datasetId` as its own DuckDB table, so the ordinary
 * `sql` path can page/sort/export it. The Rust (builder) engine is NOT fed — a
 * pushdown result is displayed through the SQL path only.
 */
async function handleRunPushdown(
  requestId: number,
  datasetId: string,
  sourceId: string,
  ir: unknown,
): Promise<void> {
  try {
    const res = await fetch(
      `/api/datasources/${encodeURIComponent(sourceId)}/run`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/vnd.apache.arrow.stream",
        },
        body: JSON.stringify({ ir }),
      },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Pushdown query failed (${res.status}).`);
    }

    const contentType = res.headers.get("Content-Type") ?? "";
    let ipcForRegistry: Uint8Array;
    let columns: SqlColumn[];
    let rowCount: number;

    if (contentType.includes("application/vnd.apache.arrow.stream")) {
      const buffer = await res.arrayBuffer();
      const arrowTable = tableFromIPC(new Uint8Array(buffer));
      rowCount = arrowTable.numRows;

      const dsColumnsHeader = res.headers.get("X-Ds-Columns");
      if (dsColumnsHeader) {
        columns = JSON.parse(dsColumnsHeader) as SqlColumn[];
      } else {
        columns = arrowTable.schema.fields.map((f) => ({
          name: f.name,
          type: mapColumnType(f.type.typeId),
        }));
      }
      ipcForRegistry = new Uint8Array(buffer);
    } else {
      // JSON fallback (shouldn't normally happen — /run emits Arrow).
      const body = (await res.json()) as { columns?: SqlColumn[]; rows?: Row[] };
      const rows = body.rows ?? [];
      columns =
        body.columns ??
        Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "string" as SqlColumnType }));
      const arrowTable = tableFromJSON(rows as Record<string, unknown>[]);
      ipcForRegistry = new Uint8Array(tableToIPC(arrowTable, "stream"));
      rowCount = arrowTable.numRows;
    }

    stashArrow(datasetId, ipcForRegistry);
    reply({ type: "source_loaded", requestId, rowCount, columns });
  } catch (err) {
    reply({
      type: "error",
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Map a file kind to the DuckDB reader function over a registered buffer. */
function readerFor(kind: FileSourceKind, file: string): string {
  switch (kind) {
    case "csv":
      return `read_csv_auto('${file}')`;
    case "parquet":
      return `read_parquet('${file}')`;
    case "json":
      return `read_json_auto('${file}')`;
  }
}

/**
 * FILE source: parse uploaded bytes with DuckDB (the universal reader),
 * derive Arrow IPC for the Rust engine, and keep the table for SQL. The file
 * bytes crossed from the main thread — the user picked the file.
 */
async function handleLoadFile(
  requestId: number,
  datasetId: string,
  fileKind: FileSourceKind,
  bytes: ArrayBuffer,
  fileName: string,
): Promise<void> {
  try {
    await ensureDuckReady();
    if (!db || !conn) throw new Error("DuckDB connection unavailable");

    const table = tableNameFor(datasetId);
    const file = `${table}__${fileName || `upload.${fileKind}`}`;
    await db.registerFileBuffer(file, new Uint8Array(bytes));

    await conn.query(`DROP TABLE IF EXISTS "${table}"`);
    await conn.query(
      `CREATE TABLE "${table}" AS SELECT * FROM ${readerFor(fileKind, file)}`,
    );

    // Read the newly-created table as an Arrow result to derive schema + IPC.
    const full = (await conn.query(`SELECT * FROM "${table}"`)) as unknown as Table;
    const ipc = tableToIPC(full, "stream");
    const columns: SqlColumn[] = full.schema.fields.map((f) => ({
      name: f.name,
      type: mapColumnType(f.type.typeId),
    }));

    // DuckDB already holds the table natively; mark as ingested immediately.
    registry.set(datasetId, { table, pendingIpc: null, ingested: true });
    clearDatasetCache(datasetId);

    // Transfer IPC to Rust worker (ipc owns its buffer from tableToIPC).
    const transferBuf = ipc.buffer.slice(
      ipc.byteOffset,
      ipc.byteOffset + ipc.byteLength,
    ) as ArrayBuffer;
    await feedRustEngine(datasetId, transferBuf);
    reply({ type: "source_loaded", requestId, rowCount: full.numRows, columns });
  } catch (err) {
    reply({
      type: "error",
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Request handling ────────────────────────────────────────────────────────

/**
 * Ensure DuckDB + dataset are ready and return the FULL materialized Arrow
 * result for `sql`, executing once and caching it for paging/export reuse.
 */
async function materialize(datasetId: string, sql: string): Promise<Table> {
  await ensureDuckReady();
  await ensureIngested(datasetId);
  if (!conn) throw new Error("DuckDB connection unavailable");

  const key = cacheKey(datasetId, sql);
  let full = resultCache.get(key);
  if (!full) {
    full = (await conn.query(sql)) as unknown as Table;
    cachePut(key, full);
  }
  return full;
}

/** Quote a CSV field iff it contains a comma, quote, or newline (RFC 4180). */
function csvField(value: unknown): string {
  const v = normalize(value);
  if (v === null || v === undefined) return "";
  const s = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize an ENTIRE Arrow table to a CSV string (header + every row). */
function arrowTableToCsv(table: Table): string {
  const names = table.schema.fields.map((f) => f.name);
  const lines: string[] = [names.map(csvField).join(",")];
  for (let i = 0; i < table.numRows; i++) {
    const row = table.get(i) as Record<string, unknown> | null;
    lines.push(names.map((name) => csvField(row?.[name])).join(","));
  }
  return lines.join("\n");
}

async function handleExportCsv(
  requestId: number,
  datasetId: string,
  sql: string,
): Promise<void> {
  const unsafe = assertReadOnly(sql);
  if (unsafe) {
    reply({ type: "sql_error", requestId, error: unsafe });
    return;
  }
  try {
    const full = await materialize(datasetId, sql);
    reply({
      type: "csv",
      requestId,
      csv: arrowTableToCsv(full),
      rowCount: full.numRows,
    });
  } catch (err) {
    reply({ type: "sql_error", requestId, error: toSqlError(err) });
  }
}

async function handleSql(
  requestId: number,
  datasetId: string,
  sql: string,
  limit: number,
  offset: number,
): Promise<void> {
  const unsafe = assertReadOnly(sql);
  if (unsafe) {
    reply({ type: "sql_error", requestId, error: unsafe });
    return;
  }

  try {
    const t0 = performance.now();

    const full = await materialize(datasetId, sql);

    // Column types are derived from the Arrow result schema (not value inference).
    const columns: SqlColumn[] = full.schema.fields.map((f) => ({
      name: f.name,
      type: mapColumnType(f.type.typeId),
    }));

    const rowCount = full.numRows;
    const start = Math.min(Math.max(offset, 0), rowCount);
    const end = Math.min(start + Math.max(limit, 0), rowCount);

    const page = full.slice(start, end);
    const names = columns.map((c) => c.name);
    const rows: unknown[][] = [];
    for (let i = 0; i < page.numRows; i++) {
      const row = page.get(i);
      rows.push(
        names.map((name) =>
          normalize((row as Record<string, unknown> | null)?.[name]),
        ),
      );
    }

    const elapsedMs = performance.now() - t0;
    reply({
      type: "sql_result",
      requestId,
      result: { columns, rows, rowCount, elapsedMs },
    });
  } catch (err) {
    reply({ type: "sql_error", requestId, error: toSqlError(err) });
  }
}

self.onmessage = async (event: MessageEvent<SqlWorkerRequest>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "link": {
        const port = event.ports[0];
        if (port) attachPeerPort(port);
        break;
      }
      case "load": {
        // Convert Row[] → Arrow IPC so DuckDB can ingest natively on first query.
        // The chart worker receives its rows directly via its own `load` message
        // (sent by useAnalyticsEngine.loadRowsOn), so no feedRustEngine here.
        const arrowTable = tableFromJSON(msg.rows as Record<string, unknown>[]);
        const ipc = tableToIPC(arrowTable, "stream");
        stashArrow(msg.datasetId, ipc);
        reply({ type: "loaded", requestId: msg.requestId, rows: msg.rows.length });
        break;
      }
      case "load_source": {
        await handleLoadSource(
          msg.requestId,
          msg.datasetId,
          msg.sourceId,
          msg.table,
          msg.limit,
          msg.offset,
        );
        break;
      }
      case "run_pushdown": {
        await handleRunPushdown(
          msg.requestId,
          msg.datasetId,
          msg.sourceId,
          msg.ir,
        );
        break;
      }
      case "load_file": {
        await handleLoadFile(
          msg.requestId,
          msg.datasetId,
          msg.fileKind,
          msg.bytes,
          msg.fileName,
        );
        break;
      }
      case "sql": {
        await handleSql(msg.requestId, msg.datasetId, msg.sql, msg.limit, msg.offset);
        break;
      }
      case "export_csv": {
        await handleExportCsv(msg.requestId, msg.datasetId, msg.sql);
        break;
      }
      case "evict": {
        const entry = registry.get(msg.datasetId);
        if (entry) {
          registry.delete(msg.datasetId);
          clearDatasetCache(msg.datasetId);
          if (conn && entry.ingested) {
            await conn.query(`DROP TABLE IF EXISTS "${entry.table}"`);
          }
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
