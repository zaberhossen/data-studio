/**
 * PostgresConnector — the reference implementation of `Connector`.
 *
 * Security model (non-negotiable, enforced here):
 *   • Credentials come from the server-side store, never the request.
 *   • Schema introspection produces the ALLOWLIST. `fetchRows` refuses any
 *     table not in it, so a forged `?table=` can never reach the DB.
 *   • The validated identifier is quoted with `pg`'s `escapeIdentifier`; values
 *     (limit/offset) are passed as bound parameters — no string interpolation.
 *   • Every connection enforces a `statement_timeout`, and a hard row cap is
 *     applied via LIMIT. There is no unbounded-table code path.
 *   • One `Pool` per source id (connection pooling), cached across requests.
 */

import { Pool, escapeIdentifier, type PoolClient } from "pg";
import type {
  DataSlice,
  SourceColumn,
  SourceColumnType,
  SourceSchema,
} from "@/lib/types/datasource";
import {
  ConnectorError,
  type Connector,
  type FetchRowsOptions,
  type RunCompiledOptions,
} from "./types";

/** The secret shape this connector needs (postgres branch of DataSourceSecret). */
export interface PostgresSecret {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  table?: string;
}

/** Map a Postgres `data_type` (information_schema) to our column vocabulary. */
function mapPgType(dataType: string): SourceColumnType {
  const t = dataType.toLowerCase();
  if (
    t.includes("int") ||
    t.includes("numeric") ||
    t.includes("decimal") ||
    t.includes("real") ||
    t.includes("double") ||
    t === "money"
  ) {
    return "number";
  }
  if (t.includes("bool")) return "bool";
  if (t.includes("date") || t.includes("time")) return "date";
  return "string";
}

export class PostgresConnector implements Connector {
  readonly kind = "postgres" as const;
  private pool: Pool;
  /** Lazily-built allowlist of selectable "schema.table" + bare table names. */
  private allowlist: Set<string> | null = null;

  constructor(private readonly secret: PostgresSecret) {
    this.pool = new Pool({
      host: secret.host,
      port: secret.port,
      database: secret.database,
      user: secret.user,
      password: secret.password,
      ssl: secret.ssl ? { rejectUnauthorized: false } : undefined,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Belt-and-braces: cap planning/exec time at the connection level too.
      statement_timeout: 30_000,
    });
    // Surface pool-level errors instead of crashing the server process.
    this.pool.on("error", () => {
      /* idle client error — pool will recycle it */
    });
  }

  /** Run `fn` on a pooled client with a per-request statement timeout. */
  private async withClient<T>(
    timeoutMs: number,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw new ConnectorError(
        `Could not connect to Postgres: ${describe(err)}`,
      );
    }
    try {
      await client.query(`SET statement_timeout = ${Math.floor(timeoutMs)}`);
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async test(): Promise<void> {
    await this.withClient(10_000, async (c) => {
      await c.query("SELECT 1");
    });
  }

  async introspectSchema(): Promise<SourceSchema> {
    return this.withClient(15_000, async (c) => {
      // Tables/views in user schemas the role can see.
      const tablesRes = await c.query<{ schema: string; name: string }>(
        `SELECT table_schema AS schema, table_name AS name
           FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY table_schema, table_name`,
      );
      const tables = tablesRes.rows.map((r) =>
        r.schema === "public" ? r.name : `${r.schema}.${r.name}`,
      );

      // Build the allowlist now so fetchRows can validate against it.
      this.allowlist = new Set<string>();
      for (const r of tablesRes.rows) {
        this.allowlist.add(`${r.schema}.${r.name}`);
        if (r.schema === "public") this.allowlist.add(r.name);
      }

      // Columns of the default table (or the first table) drive the field list.
      const target = this.secret.table ?? tables[0];
      let columns: SourceColumn[] = [];
      if (target) {
        const { schema, name } = splitQualified(target);
        const colsRes = await c.query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position`,
          [schema, name],
        );
        columns = colsRes.rows.map((r) => ({
          name: r.column_name,
          type: mapPgType(r.data_type),
        }));
      }

      return { columns, tables };
    });
  }

  async columnAllowlist(): Promise<Set<string>> {
    return this.withClient(15_000, async (c) => {
      const res = await c.query<{ column_name: string }>(
        `SELECT DISTINCT column_name
           FROM information_schema.columns
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`,
      );
      return new Set(res.rows.map((r) => r.column_name));
    });
  }

  async fetchRows(opts: FetchRowsOptions): Promise<DataSlice> {
    // Ensure the allowlist exists, then VALIDATE the requested table against it.
    if (!this.allowlist) await this.introspectSchema();
    if (!this.allowlist || !this.allowlist.has(opts.table)) {
      throw new ConnectorError(
        `Table "${opts.table}" is not in this source's allowlist.`,
      );
    }

    const { schema, name } = splitQualified(opts.table);
    // The identifier is quoted ONLY after passing the allowlist check; values
    // are bound parameters. No client string ever lands in the SQL text raw.
    const qualified = `${escapeIdentifier(schema)}.${escapeIdentifier(name)}`;

    return this.withClient(opts.timeoutMs, async (c) => {
      // Pull one extra row to detect whether the cap truncated the table.
      const probeLimit = opts.limit + 1;
      const res = await c.query(
        `SELECT * FROM ${qualified} LIMIT $1 OFFSET $2`,
        [probeLimit, opts.offset],
      );

      const capped = res.rows.length > opts.limit;
      const rows = capped ? res.rows.slice(0, opts.limit) : res.rows;

      const columns: SourceColumn[] = res.fields.map((f) => ({
        name: f.name,
        type: pgOidToType(f.dataTypeID),
      }));

      return {
        columns,
        rows: rows as Array<Record<string, unknown>>,
        rowCount: rows.length,
        capped,
      };
    });
  }

  async runCompiled(opts: RunCompiledOptions): Promise<DataSlice> {
    // The SQL is already compiled + parameterized against this source's dialect
    // and allowlist. We only wrap it in a hard LIMIT envelope (probe +1 to detect
    // truncation); the envelope size is an inlined integer, params stay bound.
    const probeLimit = Math.floor(opts.limit) + 1;
    const wrapped = `SELECT * FROM (${opts.sql}) AS _ds_sub LIMIT ${probeLimit}`;

    return this.withClient(opts.timeoutMs, async (c) => {
      const res = await c.query(wrapped, opts.params);
      const capped = res.rows.length > opts.limit;
      const rows = capped ? res.rows.slice(0, opts.limit) : res.rows;
      const columns: SourceColumn[] = res.fields.map((f) => ({
        name: f.name,
        type: pgOidToType(f.dataTypeID),
      }));
      return {
        columns,
        rows: rows as Array<Record<string, unknown>>,
        rowCount: rows.length,
        capped,
      };
    });
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}

/** Split "schema.table" → parts; bare names default to the `public` schema. */
function splitQualified(table: string): { schema: string; name: string } {
  const dot = table.indexOf(".");
  if (dot === -1) return { schema: "public", name: table };
  return { schema: table.slice(0, dot), name: table.slice(dot + 1) };
}

/** Map common Postgres type OIDs (from row description) to our vocabulary. */
function pgOidToType(oid: number): SourceColumnType {
  switch (oid) {
    case 20: // int8
    case 21: // int2
    case 23: // int4
    case 700: // float4
    case 701: // float8
    case 1700: // numeric
    case 790: // money
      return "number";
    case 16: // bool
      return "bool";
    case 1082: // date
    case 1114: // timestamp
    case 1184: // timestamptz
    case 1083: // time
      return "date";
    default:
      return "string";
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
