/**
 * The `Connector` abstraction — the seam that lets Postgres ship today and
 * MySQL / REST slot in later without touching the route handlers.
 *
 * SERVER-ONLY. A connector is constructed from a `DataSourceSecret` (which holds
 * the credentials) and exposes only safe, bounded operations. It never returns
 * a credential and never runs client-supplied SQL — the data endpoint asks for
 * a validated table + limit/offset and the connector builds the query itself.
 */

import type {
  DataSourceSecret,
  DataSlice,
  SourceSchema,
} from "@/lib/types/datasource";

/** Bounded read request the data endpoint hands to a connector. */
export interface FetchRowsOptions {
  /** Table/view to read — MUST already be validated against the allowlist. */
  table: string;
  /** Hard cap on rows returned to the browser. */
  limit: number;
  /** Page offset. */
  offset: number;
  /** Per-request timeout (ms). The connector aborts/cancels past this. */
  timeoutMs: number;
}

/**
 * A pushed-down, already-compiled + validated query. The `sql` was produced by
 * `compileIR` against this source's dialect + allowlist, with `params` bound —
 * the connector wraps it in a hard `LIMIT` envelope and runs it as-is. It NEVER
 * builds SQL from client strings.
 */
export interface RunCompiledOptions {
  sql: string;
  params: unknown[];
  /** Hard cap on rows returned. */
  limit: number;
  timeoutMs: number;
}

export interface Connector {
  readonly kind: DataSourceSecret["kind"];
  /** Cheap liveness check — open a connection and round-trip a trivial query. */
  test(): Promise<void>;
  /** Introspect tables + columns the client is allowed to select from. */
  introspectSchema(): Promise<SourceSchema>;
  /**
   * The union of ALL selectable column names across every allowlisted table —
   * the compiler allowlist for a multi-table JOIN. Optional: connectors that
   * can't join (file/REST) omit it.
   */
  columnAllowlist?(): Promise<Set<string>>;
  /** Pull a bounded, validated slice. NEVER interpolates client input as SQL. */
  fetchRows(opts: FetchRowsOptions): Promise<DataSlice>;
  /** Run a pre-compiled, parameterized pushdown query under a LIMIT envelope. */
  runCompiled(opts: RunCompiledOptions): Promise<DataSlice>;
  /** Release pooled resources (called on source deletion / shutdown). */
  dispose(): Promise<void>;
}

/** Thrown by connectors for expected, client-presentable failures. */
export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}
