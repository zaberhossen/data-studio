/**
 * CSV helpers for the FULL builder result (the SQL path serializes inside the
 * worker via `exportSqlCsv`). The builder payload is tiny and fully in hand, so
 * serializing it on the main thread is fine.
 */

import type { ResultColumn } from "@/lib/types/results";

/** RFC 4180 field: quote iff it contains a comma, quote, or newline. */
function field(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize columns + the COMPLETE row set to a CSV string (header included). */
export function tableToCsv(columns: ResultColumn[], rows: unknown[][]): string {
  const header = columns.map((c) => field(c.name)).join(",");
  const body = rows.map((r) => r.map(field).join(",")).join("\n");
  return body ? `${header}\n${body}` : header;
}

/** Trigger a browser download of a CSV string. Client-only (touches the DOM). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
