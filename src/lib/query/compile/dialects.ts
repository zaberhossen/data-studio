/**
 * Dialect selection for pushdown. Maps a live-source kind to its SQL dialect;
 * throws for sources that can't accept a pushed-down query (files, REST).
 */

import type { DataSourceKind } from "@/lib/types/datasource";
import type { Dialect } from "./dialect";
import { CompileError } from "./compile";
import { PostgresDialect } from "./postgres";
import { MySqlDialect } from "./mysql";

export function dialectFor(kind: DataSourceKind): Dialect {
  switch (kind) {
    case "postgres":
      return PostgresDialect;
    case "mysql":
      return MySqlDialect;
    default:
      throw new CompileError(`Pushdown is not supported for "${kind}" sources.`);
  }
}
