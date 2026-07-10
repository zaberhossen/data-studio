/**
 * DuckDB dialect — the LOCAL execution target. Compiled SQL runs in the DuckDB
 * worker over the resident Arrow dataset.
 */

import type { AggFn, RelativeDate, TemporalUnit } from "@/lib/query/ir";
import type { Dialect } from "./dialect";

const INTERVAL_UNIT: Record<RelativeDate["unit"], string> = {
  day: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

export const DuckDbDialect: Dialect = {
  id: "duckdb",

  quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  },

  // DuckDB accepts positional `?` markers.
  placeholder(): string {
    return "?";
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

  aggregate(fn: AggFn, argSql: string | null, distinct: boolean): string {
    if (fn === "count") {
      if (argSql === null) return "count(*)";
      return distinct ? `count(distinct ${argSql})` : `count(${argSql})`;
    }
    if (fn === "count_distinct") {
      return `count(distinct ${argSql ?? "*"})`;
    }
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
        return `median(${argSql})`;
      case "stddev":
        return `stddev(${argSql})`;
    }
  },

  relativeDate(rel: RelativeDate, colSql: string): string {
    const unit = INTERVAL_UNIT[rel.unit];
    const n = Math.max(0, Math.floor(rel.count ?? 1)); // validated integer, inlined
    if (rel.direction === "current") {
      return `date_trunc('${unit}', ${colSql}) = date_trunc('${unit}', current_date)`;
    }
    if (rel.direction === "last") {
      return `${colSql} >= current_date - INTERVAL '${n} ${unit}' AND ${colSql} <= current_date`;
    }
    // next
    return `${colSql} > current_date AND ${colSql} <= current_date + INTERVAL '${n} ${unit}'`;
  },

  likeEscapeClause(): string {
    return " ESCAPE '\\'";
  },
};
