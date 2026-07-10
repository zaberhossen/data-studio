/**
 * Connector factory + per-source instance cache.
 *
 * A `Connector` owns a connection pool, so we keep ONE instance per source id
 * and reuse it across requests (route handlers are stateless, but the module
 * graph persists in the running server process). The cache hangs off
 * `globalThis` so Next.js dev HMR doesn't leak a new pool on every reload.
 *
 * Only Postgres is wired today; the `switch` is the single place MySQL / REST
 * connectors slot in later, behind the same `Connector` interface.
 */

import type { DataSourceSecret } from "@/lib/types/datasource";
import { ConnectorError, type Connector } from "./types";
import { PostgresConnector } from "./postgres";
import { MySqlConnector } from "./mysql";
import { HttpFileConnector, RestApiConnector } from "./http";

function build(secret: DataSourceSecret): Connector {
  switch (secret.kind) {
    case "postgres":
      return new PostgresConnector(secret);
    case "mysql":
      return new MySqlConnector(secret);
    case "http-file":
      return new HttpFileConnector(secret);
    case "rest-api":
      return new RestApiConnector(secret);
    default: {
      const _never: never = secret;
      throw new ConnectorError(`Unknown source kind: ${JSON.stringify(_never)}`);
    }
  }
}

interface ConnectorCache {
  map: Map<string, Connector>;
}

const globalForConnectors = globalThis as unknown as {
  __dataStudioConnectors?: ConnectorCache;
};

function cache(): ConnectorCache {
  if (!globalForConnectors.__dataStudioConnectors) {
    globalForConnectors.__dataStudioConnectors = { map: new Map() };
  }
  return globalForConnectors.__dataStudioConnectors;
}

/** Get (or lazily build) the cached connector for a source id. */
export function connectorFor(id: string, secret: DataSourceSecret): Connector {
  const { map } = cache();
  let conn = map.get(id);
  if (!conn) {
    conn = build(secret);
    map.set(id, conn);
  }
  return conn;
}

/** Drop + dispose a source's connector (on deletion). Safe if absent. */
export async function disposeConnector(id: string): Promise<void> {
  const { map } = cache();
  const conn = map.get(id);
  if (conn) {
    map.delete(id);
    try {
      await conn.dispose();
    } catch {
      /* best-effort: the source is going away regardless */
    }
  }
}

export { ConnectorError };
export type { Connector };
