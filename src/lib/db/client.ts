/**
 * The application database (Postgres via Drizzle).
 *
 * This is the persistence backend for the multi-tenant app: users, orgs,
 * data-source records (with encrypted secrets), saved queries, dashboards,
 * widgets, share links, and the audit log. It is SEPARATE from the *customer*
 * databases that the connectors in `lib/server/connectors/` reach — those are
 * the data being analyzed; this is our own metadata store.
 *
 * SERVER-ONLY. One `Pool` + one Drizzle instance per process, hung off
 * `globalThis` so Next.js dev HMR doesn't leak a new pool on every reload
 * (same pattern as the connector cache).
 */

import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

type Db = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as {
  __dataStudioPool?: Pool;
  __dataStudioDb?: Db;
};

function pool(): Pool {
  if (!globalForDb.__dataStudioPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Point it at the application Postgres database " +
          "(e.g. postgres://user:pass@localhost:5432/data_studio).",
      );
    }
    globalForDb.__dataStudioPool = new Pool({
      connectionString,
      // Modest pool: route handlers are short-lived and stateless.
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return globalForDb.__dataStudioPool;
}

/** The process-wide Drizzle database handle. */
export function db(): Db {
  if (!globalForDb.__dataStudioDb) {
    globalForDb.__dataStudioDb = drizzle(pool(), { schema });
  }
  return globalForDb.__dataStudioDb;
}

export { schema };
export type { Db };
