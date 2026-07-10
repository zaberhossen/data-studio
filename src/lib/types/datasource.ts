/**
 * Data-source contract — the metadata layer shared between the React UI, the
 * Next.js API routes (the server backend), and the Web Workers.
 *
 * CRITICAL SECURITY INVARIANT: nothing in the *client-facing* half of this file
 * (everything above the "SERVER-ONLY" banner) may ever carry a credential.
 * `DataSourceMeta` is what every endpoint returns and what the panel renders —
 * it is secret-free by construction. Connection secrets live ONLY in the
 * server-only `*Secret*` types and never cross the wire back to the browser.
 */

// ---------------------------------------------------------------------------
// Client-facing metadata (NEVER contains secrets)
// ---------------------------------------------------------------------------

export type DataSourceKind =
  | "file"
  | "postgres"
  | "mysql"
  | "http-file"
  | "rest-api";

export type DataSourceStatus = "idle" | "connecting" | "ready" | "error";

/**
 * The public shape of a source. Returned by every endpoint, held by the panel.
 * It describes a source's identity + live status — never how to connect to it.
 */
export interface DataSourceMeta {
  id: string;
  name: string;
  kind: DataSourceKind;
  status: DataSourceStatus;
  rowCount?: number;
  /** Default table/view the source reads from (server-validated allowlist). */
  tableName?: string;
  error?: string;
}

/** Column type vocabulary shared by schema introspection + the result grid. */
export type SourceColumnType = "number" | "string" | "date" | "bool";

export interface SourceColumn {
  name: string;
  type: SourceColumnType;
}

/**
 * Introspected schema of a source. `tables` lists every table/view the client
 * may select (the allowlist the data endpoint validates `?table=` against).
 */
export interface SourceSchema {
  columns: SourceColumn[];
  tables?: string[];
}

// ---------------------------------------------------------------------------
// Create payload (client → POST /api/datasources)
// ---------------------------------------------------------------------------

/**
 * What the Add-source dialog POSTs. The password is accepted ONCE over HTTPS,
 * stored server-side, and never echoed back. `kind` discriminates the union.
 */
export type CreateDataSourceInput =
  | {
      kind: "postgres" | "mysql";
      name: string;
      host: string;
      port: number;
      database: string;
      user: string;
      /** Sent once; persisted server-side; never returned. */
      password: string;
      /** Optional default table/view to read from. */
      table?: string;
      /** Optional SSL toggle (managed Postgres usually requires it). */
      ssl?: boolean;
    }
  | {
      kind: "http-file";
      name: string;
      url: string;
    }
  | {
      kind: "rest-api";
      name: string;
      url: string;
      /** Bearer/API token — stored server-side, never returned. */
      authToken?: string;
    };

// ---------------------------------------------------------------------------
// Result of a connection test
// ---------------------------------------------------------------------------

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
}

/** One bounded page pulled by the data endpoint (rows never reach React state). */
export interface DataSlice {
  columns: SourceColumn[];
  /** Row objects in `Row` shape (column name → cell). */
  rows: Array<Record<string, unknown>>;
  /** Rows in THIS slice (bounded by the row cap). */
  rowCount: number;
  /** True when the row cap was hit and more rows exist upstream. */
  capped: boolean;
}

// ===========================================================================
// SERVER-ONLY — these types carry credentials and MUST NOT be imported into
// any client component or worker. They live behind the /api/datasources layer.
// ===========================================================================

/** Per-kind connection secrets, persisted in the server-side store only. */
export type DataSourceSecret =
  | {
      kind: "postgres" | "mysql";
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      ssl?: boolean;
      table?: string;
    }
  | { kind: "http-file"; url: string }
  | { kind: "rest-api"; url: string; authToken?: string };

/** A full server-side record: public meta + the secret half kept server-side. */
export interface StoredDataSource {
  meta: DataSourceMeta;
  secret: DataSourceSecret;
}

/** Strip a stored record down to its secret-free public projection. */
export function toMeta(record: StoredDataSource): DataSourceMeta {
  return record.meta;
}
