/**
 * Cell formatting for the results table, by column type. Pure + presentational:
 * numbers get locale grouping, dates are humanized, booleans become true/false.
 * Null/undefined are reported via {@link isNullish} so the table can render the
 * muted "null" token instead of an empty cell.
 */

import type { ResultColumnType } from "@/lib/types/results";

export const NULL_TOKEN = "null";

export function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

const numberFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

export function formatCell(value: unknown, type: ResultColumnType): string {
  if (isNullish(value)) return NULL_TOKEN;

  switch (type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? numberFmt.format(n) : String(value);
    }
    case "bool":
      return value === true || value === "true" || value === 1
        ? "true"
        : "false";
    case "date":
      return formatDate(value);
    case "string":
    default:
      return String(value);
  }
}

/** Right-align numeric columns; left-align everything else. */
export function alignFor(type: ResultColumnType): "right" | "left" {
  return type === "number" ? "right" : "left";
}

function formatDate(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  // Date-only inputs (no time component) format without a time.
  const raw = String(value);
  const hasTime = raw.includes("T") || raw.includes(":");
  return hasTime ? d.toLocaleString() : d.toLocaleDateString();
}
