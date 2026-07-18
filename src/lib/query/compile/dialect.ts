/**
 * SQL dialect abstraction. The compiler is dialect-agnostic; each target DB
 * provides identifier quoting, value placeholders, temporal bucketing, aggregate
 * rendering, and relative-date compilation. DuckDB runs the LOCAL path;
 * Postgres / MySQL run PUSHDOWN via their connectors.
 */

import type { AggFn, RelativeDate, TemporalUnit } from "@/lib/query/ir";

export type DialectId = "duckdb" | "postgres" | "mysql";

export interface Dialect {
  readonly id: DialectId;
  /** Quote an identifier (already validated against the allowlist). */
  quoteIdent(name: string): string;
  /** Placeholder for the given 0-based bound-parameter index (`?` / `$1` / …). */
  placeholder(index: number): string;
  /** SQL that buckets a date/timestamp expression to a temporal unit. */
  temporalBucket(unit: TemporalUnit, colSql: string): string;
  /** SQL that bins a numeric expression into `width`-wide ranges (lower edge). */
  numericBin(width: number, colSql: string): string;
  /**
   * Render an aggregate call. `argSql` null ⇒ `COUNT(*)`. `p` is the percentile
   * fraction in (0,1), used only for `fn === "percentile"`. `count_if`/`sum_if`
   * never reach here — the compiler builds them as CASE expressions.
   */
  aggregate(fn: AggFn, argSql: string | null, distinct: boolean, p?: number): string;
  /**
   * Compile a relative-date predicate over `colSql` to a boolean SQL expression.
   * The `count` is a validated integer, inlined safely (no bound param needed).
   */
  relativeDate(rel: RelativeDate, colSql: string): string;
  /** The LIKE escape suffix, e.g. ` ESCAPE '\'`. */
  likeEscapeClause(): string;
}
