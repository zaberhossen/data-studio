/**
 * MySqlConnector — the MySQL implementation of `Connector`, mirroring the
 * security model of `postgres.ts`:
 *   • Credentials come from the server-side store, never the request.
 *   • Schema introspection produces the ALLOWLIST; `fetchRows` refuses any table
 *     not in it, so a forged `?table=` can never reach the DB.
 *   • The validated identifier is backtick-quoted (backticks doubled); values
 *     (limit/offset) are bound — no string interpolation of client input.
 *   • Every connection sets `max_execution_time` (SELECT timeout) and a hard row
 *     cap is applied via LIMIT. There is no unbounded-table code path.
 *   • One pool per source id (connection pooling), cached across requests.
 *
 * In MySQL the connection's `database` IS the schema, so tables are unqualified.
 */

import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
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

/** The secret shape this connector needs (mysql branch of DataSourceSecret). */
export interface MySqlSecret {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  table?: string;
}

/** Map a MySQL `DATA_TYPE` (information_schema) to our column vocabulary. */
function mapMysqlType(dataType: string): SourceColumnType {
  const t = dataType.toLowerCase();
  if (
    t.includes("int") ||
    t.includes("decimal") ||
    t.includes("numeric") ||
    t.includes("float") ||
    t.includes("double") ||
    t === "year"
  ) {
    return "number";
  }
  if (t === "bit" || t.includes("bool")) return "bool";
  if (t.includes("date") || t.includes("time")) return "date";
  return "string";
}

/** Backtick-quote an identifier, doubling any embedded backticks. */
function quoteIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

export class MySqlConnector implements Connector {
  readonly kind = "mysql" as const;
  private pool: Pool;
  private allowlist: Set<string> | null = null;

  constructor(private readonly secret: MySqlSecret) {
    this.pool = mysql.createPool({
      host: secret.host,
      port: secret.port,
      database: secret.database,
      user: secret.user,
      password: secret.password,
      ssl: secret.ssl ? { rejectUnauthorized: false } : undefined,
      connectionLimit: 4,
      idleTimeout: 30_000,
      connectTimeout: 10_000,
      // Numbers can exceed JS safe range; keep big ints as strings, decimals too.
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
    });
  }

  /** Run `fn` on a pooled connection with a per-request SELECT timeout. */
  private async withConnection<T>(
    timeoutMs: number,
    fn: (conn: PoolConnection) => Promise<T>,
  ): Promise<T> {
    let conn: PoolConnection;
    try {
      conn = await this.pool.getConnection();
    } catch (err) {
      throw new ConnectorError(`Could not connect to MySQL: ${describe(err)}`);
    }
    try {
      // max_execution_time bounds SELECTs at the server (milliseconds).
      await conn.query(`SET SESSION max_execution_time = ${Math.floor(timeoutMs)}`);
      return await fn(conn);
    } finally {
      conn.release();
    }
  }

  async test(): Promise<void> {
    await this.withConnection(10_000, async (c) => {
      await c.query("SELECT 1");
    });
  }

  async introspectSchema(): Promise<SourceSchema> {
    return this.withConnection(15_000, async (c) => {
      const [tableRows] = await c.query<RowDataPacket[]>(
        `SELECT table_name AS name
           FROM information_schema.tables
          WHERE table_schema = DATABASE()
          ORDER BY table_name`,
      );
      const tables = tableRows.map((r) => String(r.name));

      this.allowlist = new Set<string>(tables);

      const target = this.secret.table ?? tables[0];
      let columns: SourceColumn[] = [];
      if (target) {
        const [colRows] = await c.query<RowDataPacket[]>(
          `SELECT column_name AS name, data_type AS type
             FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ?
            ORDER BY ordinal_position`,
          [target],
        );
        columns = colRows.map((r) => ({
          name: String(r.name),
          type: mapMysqlType(String(r.type)),
        }));
      }

      return { columns, tables };
    });
  }

  async columnAllowlist(): Promise<Set<string>> {
    return this.withConnection(15_000, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        `SELECT DISTINCT COLUMN_NAME AS c
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()`,
      );
      return new Set(rows.map((r) => String((r as { c: unknown }).c)));
    });
  }

  async fetchRows(opts: FetchRowsOptions): Promise<DataSlice> {
    if (!this.allowlist) await this.introspectSchema();
    if (!this.allowlist || !this.allowlist.has(opts.table)) {
      throw new ConnectorError(
        `Table "${opts.table}" is not in this source's allowlist.`,
      );
    }

    // Identifier quoted ONLY after the allowlist check; limit/offset are bound.
    const qualified = quoteIdent(opts.table);

    return this.withConnection(opts.timeoutMs, async (c) => {
      const probeLimit = opts.limit + 1; // one extra row → detect truncation
      const [rows, fields] = await c.query<RowDataPacket[]>(
        `SELECT * FROM ${qualified} LIMIT ? OFFSET ?`,
        [probeLimit, opts.offset],
      );

      const capped = rows.length > opts.limit;
      const sliced = capped ? rows.slice(0, opts.limit) : rows;

      const columns: SourceColumn[] = (fields ?? []).map((f) => {
        const codes = f as { columnType?: number; type?: number };
        return {
          name: f.name,
          type: mapMysqlColumnType(codes.columnType ?? codes.type),
        };
      });

      return {
        columns,
        rows: sliced as Array<Record<string, unknown>>,
        rowCount: sliced.length,
        capped,
      };
    });
  }

  async runCompiled(opts: RunCompiledOptions): Promise<DataSlice> {
    const probeLimit = Math.floor(opts.limit) + 1;
    const wrapped = `SELECT * FROM (${opts.sql}) AS _ds_sub LIMIT ${probeLimit}`;

    return this.withConnection(opts.timeoutMs, async (c) => {
      const [rows, fields] = await c.query<RowDataPacket[]>(wrapped, opts.params);
      const capped = rows.length > opts.limit;
      const sliced = capped ? rows.slice(0, opts.limit) : rows;
      const columns: SourceColumn[] = (fields ?? []).map((f) => {
        const codes = f as { columnType?: number; type?: number };
        return { name: f.name, type: mapMysqlColumnType(codes.columnType ?? codes.type) };
      });
      return {
        columns,
        rows: sliced as Array<Record<string, unknown>>,
        rowCount: sliced.length,
        capped,
      };
    });
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Map a MySQL protocol column-type code (from the result field descriptor) to
 * our vocabulary. Codes per the MySQL client/server protocol.
 */
function mapMysqlColumnType(code: number | undefined): SourceColumnType {
  switch (code) {
    case 1: // TINY
    case 2: // SHORT
    case 3: // LONG
    case 8: // LONGLONG
    case 9: // INT24
    case 4: // FLOAT
    case 5: // DOUBLE
    case 246: // NEWDECIMAL
    case 0: // DECIMAL
    case 13: // YEAR
      return "number";
    case 16: // BIT
      return "bool";
    case 10: // DATE
    case 12: // DATETIME
    case 7: // TIMESTAMP
    case 11: // TIME
    case 14: // NEWDATE
      return "date";
    default:
      return "string";
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
