/**
 * MySQL dialect — PUSHDOWN target for MySQL sources. Runs on the live source via
 * `MySqlConnector.runCompiled`.
 */

import type { AggFn, RelativeDate, TemporalUnit } from "@/lib/query/ir";
import type { Dialect } from "./dialect";
import { CompileError } from "./compile";

const INTERVAL_UNIT: Record<RelativeDate["unit"], string> = {
  day: "DAY",
  week: "WEEK",
  month: "MONTH",
  quarter: "QUARTER",
  year: "YEAR",
};

export const MySqlDialect: Dialect = {
  id: "mysql",

  quoteIdent(name: string): string {
    return "`" + name.replace(/`/g, "``") + "`";
  },

  // MySQL uses positional `?` placeholders.
  placeholder(): string {
    return "?";
  },

  temporalBucket(unit: TemporalUnit, colSql: string): string {
    switch (unit) {
      // MySQL has no date_trunc; emulate with DATE_FORMAT truncation.
      case "minute":
        return `DATE_FORMAT(${colSql}, '%Y-%m-%d %H:%i:00')`;
      case "hour":
        return `DATE_FORMAT(${colSql}, '%Y-%m-%d %H:00:00')`;
      case "day":
        return `DATE(${colSql})`;
      case "week":
        // Monday-based week start.
        return `DATE_SUB(DATE(${colSql}), INTERVAL WEEKDAY(${colSql}) DAY)`;
      case "month":
        return `DATE_FORMAT(${colSql}, '%Y-%m-01')`;
      case "quarter":
        return `MAKEDATE(YEAR(${colSql}), 1) + INTERVAL (QUARTER(${colSql}) - 1) QUARTER`;
      case "year":
        return `DATE_FORMAT(${colSql}, '%Y-01-01')`;
      case "day_of_week":
        return `DAYOFWEEK(${colSql})`;
      case "month_of_year":
        return `MONTH(${colSql})`;
    }
  },

  aggregate(fn: AggFn, argSql: string | null, distinct: boolean): string {
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
      case "stddev":
        return `stddev_samp(${argSql})`;
      case "median":
        // MySQL has no percentile/median aggregate.
        throw new CompileError("MEDIAN is not supported on MySQL sources.");
    }
  },

  relativeDate(rel: RelativeDate, colSql: string): string {
    const unit = INTERVAL_UNIT[rel.unit];
    const n = Math.max(0, Math.floor(rel.count ?? 1));
    if (rel.direction === "current") {
      // Compare truncated periods via formatted keys.
      const fmt =
        rel.unit === "year"
          ? "%Y"
          : rel.unit === "month"
            ? "%Y-%m"
            : "%Y-%m-%d";
      if (rel.unit === "week") {
        return `YEARWEEK(${colSql}, 3) = YEARWEEK(CURDATE(), 3)`;
      }
      if (rel.unit === "quarter") {
        return `YEAR(${colSql}) = YEAR(CURDATE()) AND QUARTER(${colSql}) = QUARTER(CURDATE())`;
      }
      return `DATE_FORMAT(${colSql}, '${fmt}') = DATE_FORMAT(CURDATE(), '${fmt}')`;
    }
    if (rel.direction === "last") {
      return `${colSql} >= CURDATE() - INTERVAL ${n} ${unit} AND ${colSql} <= CURDATE()`;
    }
    return `${colSql} > CURDATE() AND ${colSql} <= CURDATE() + INTERVAL ${n} ${unit}`;
  },

  // MySQL LIKE defaults to backslash escaping, matching the compiler.
  likeEscapeClause(): string {
    return "";
  },
};
