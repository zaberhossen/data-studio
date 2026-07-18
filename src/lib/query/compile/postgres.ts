/**
 * Postgres dialect — the primary PUSHDOWN target. Compiled SQL runs on the live
 * Postgres source via `PostgresConnector.runCompiled`, so aggregation happens
 * server-side and only the small result returns.
 */

import type { AggFn, RelativeDate, TemporalUnit } from "@/lib/query/ir";
import type { Dialect } from "./dialect";
import { CompileError, percentileFraction } from "./compile";

const INTERVAL_UNIT: Record<RelativeDate["unit"], string> = {
  day: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

export const PostgresDialect: Dialect = {
  id: "postgres",

  quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  },

  // Postgres uses numbered placeholders: $1, $2, …
  placeholder(index: number): string {
    return `$${index + 1}`;
  },

  temporalBucket(unit: TemporalUnit, colSql: string): string {
    switch (unit) {
      case "minute":
      case "hour":
      case "day":
      case "week":
      case "month":
      case "quarter":
      case "year":
        return `date_trunc('${unit}', ${colSql})`;
      case "day_of_week":
        return `extract(dow from ${colSql})`;
      case "month_of_year":
        return `extract(month from ${colSql})`;
    }
  },

  numericBin(width: number, colSql: string): string {
    return `floor(${colSql} / ${width}) * ${width}`;
  },

  aggregate(fn: AggFn, argSql: string | null, distinct: boolean, p?: number): string {
    if (fn === "count") {
      if (argSql === null) return "count(*)";
      return distinct ? `count(distinct ${argSql})` : `count(${argSql})`;
    }
    if (fn === "count_distinct") return `count(distinct ${argSql ?? "*"})`;
    const inner = distinct ? `distinct ${argSql}` : argSql;
    switch (fn) {
      case "sum":
        return `sum(${inner})`;
      case "avg":
        return `avg(${inner})`;
      case "min":
        return `min(${inner})`;
      case "max":
        return `max(${inner})`;
      case "median":
        return `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${argSql})`;
      case "stddev":
        return `stddev_samp(${argSql})`;
      case "variance":
        return `var_samp(${argSql})`;
      case "percentile":
        return `percentile_cont(${percentileFraction(p)}) WITHIN GROUP (ORDER BY ${argSql})`;
      case "count_if":
      case "sum_if":
        throw new CompileError(`"${fn}" is compiled as a conditional aggregate, not here.`);
    }
  },

  relativeDate(rel: RelativeDate, colSql: string): string {
    const unit = INTERVAL_UNIT[rel.unit];
    const n = Math.max(0, Math.floor(rel.count ?? 1));
    if (rel.direction === "current") {
      return `date_trunc('${unit}', ${colSql}) = date_trunc('${unit}', current_date)`;
    }
    if (rel.direction === "last") {
      return `${colSql} >= current_date - INTERVAL '${n} ${unit}' AND ${colSql} <= current_date`;
    }
    return `${colSql} > current_date AND ${colSql} <= current_date + INTERVAL '${n} ${unit}'`;
  },

  // Postgres LIKE defaults to backslash as the escape char, matching how the
  // compiler escapes user values — so no explicit ESCAPE clause is needed.
  likeEscapeClause(): string {
    return "";
  },
};
