/**
 * SQL dialect abstraction. The compiler is dialect-agnostic; each target DB
 * provides identifier quoting, value placeholders, temporal bucketing, aggregate
 * rendering, and relative-date compilation. DuckDB (LOCAL) ships in M3; Postgres
 * / MySQL / BigQuery (PUSHDOWN) land with their connectors (M5+).
 */

import type { AggFn, RelativeDate, TemporalUnit } from "@/lib/query/ir";

export type DialectId = "duckdb" | "postgres" | "mysql" | "bigquery";

export interface Dialect {
  readonly id: DialectId;
  /** Quote an identifier (already validated against the allowlist). */
  quoteIdent(name: string): string;
  /** Placeholder for the given 0-based bound-parameter index (`?` / `$1` / …). */
  placeholder(index: number): string;
  /** SQL that buckets a date/timestamp expression to a temporal unit. */
  temporalBucket(unit: TemporalUnit, colSql: string): string;
  /** Render an aggregate call. `argSql` null ⇒ `COUNT(*)`. */
  aggregate(fn: AggFn, argSql: string | null, distinct: boolean): string;
  /**
   * Compile a relative-date predicate over `colSql` to a boolean SQL expression.
   * The `count` is a validated integer, inlined safely (no bound param needed).
   */
  relativeDate(rel: RelativeDate, colSql: string): string;
  /** The LIKE escape suffix, e.g. ` ESCAPE '\'`. */
  likeEscapeClause(): string;
}
