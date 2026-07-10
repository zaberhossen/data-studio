/**
 * Fetch-based connectors — HTTP-file (a CSV/JSON file at a URL) and REST-API
 * (a JSON endpoint, optionally bearer-authed).
 *
 * These have no server-side SQL engine, so they only pull a bounded slice
 * (`fetchRows`); `runCompiled` throws and `chooseExecution` keeps them LOCAL (the
 * browser's DuckDB does any aggregation over the fetched rows). The body is
 * fetched once and cached on the instance. Parsing helpers are pure + exported
 * for tests.
 *
 * SERVER-ONLY.
 */

import type {
  DataSlice,
  SourceColumn,
  SourceColumnType,
  SourceSchema,
} from "@/lib/types/datasource";
import {
  ConnectorError,
  type Connector,
  type FetchRowsOptions,
} from "./types";

const FETCH_TIMEOUT_MS = 15_000;
/** Hard cap on downloaded bytes — a file source shouldn't stream unbounded. */
const MAX_BYTES = 25 * 1024 * 1024;

type Row = Record<string, unknown>;

// ── Pure parsing helpers (exported for tests) ────────────────────────────────

/** Coerce a raw CSV cell into a number / boolean / null / string. */
export function coerceCell(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  // A bare number (not e.g. a zip code with leading zero).
  if (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

/** Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseDelimited(text: string): Row[] {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      rows.push(record);
      field = "";
      record = [];
    } else field += ch;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    rows.push(record);
  }
  const nonEmpty = rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h, i) => h.trim() || `col_${i + 1}`);
  return nonEmpty.slice(1).map((r) => {
    const obj: Row = {};
    header.forEach((h, i) => {
      obj[h] = coerceCell(r[i] ?? "");
    });
    return obj;
  });
}

/** Pull the row array out of a parsed JSON payload (array, or object wrapping one). */
export function extractJsonRows(data: unknown): Row[] {
  if (Array.isArray(data)) return data.filter((r) => r && typeof r === "object") as Row[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["data", "results", "rows", "items", "records"]) {
      if (Array.isArray(obj[key])) return obj[key] as Row[];
    }
    // A single object → one row.
    return [obj];
  }
  return [];
}

/** Choose JSON vs CSV from the content-type + a peek at the body. */
export function parseBody(text: string, contentType: string): Row[] {
  const looksJson =
    contentType.includes("json") || /^\s*[[{]/.test(text.slice(0, 64));
  if (looksJson) {
    try {
      return extractJsonRows(JSON.parse(text));
    } catch {
      throw new ConnectorError("The endpoint did not return valid JSON.");
    }
  }
  return parseDelimited(text);
}

/** Infer a column type from a sample of values. */
function inferType(values: unknown[]): SourceColumnType {
  let sawNumber = false;
  let sawBool = false;
  let sawDate = false;
  let any = false;
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    any = true;
    if (typeof v === "number") sawNumber = true;
    else if (typeof v === "boolean") sawBool = true;
    else if (typeof v === "string" && !Number.isNaN(Date.parse(v)) && /[-/:]/.test(v)) sawDate = true;
    else return "string";
  }
  if (!any) return "string";
  if (sawBool && !sawNumber && !sawDate) return "bool";
  if (sawNumber && !sawDate) return "number";
  if (sawDate && !sawNumber) return "date";
  return "string";
}

export function inferColumns(rows: Row[]): SourceColumn[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(0, 200)) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const sample = rows.slice(0, 200);
  return keys.map((name) => ({ name, type: inferType(sample.map((r) => r[name])) }));
}

// ── Connectors ────────────────────────────────────────────────────────────────

abstract class FetchConnector implements Connector {
  abstract readonly kind: "http-file" | "rest-api";
  private rows: Row[] | null = null;
  private columns: SourceColumn[] = [];

  protected abstract request(): Promise<Response>;

  private async ensureLoaded(): Promise<void> {
    if (this.rows) return;
    let res: Response;
    try {
      res = await this.request();
    } catch (err) {
      throw new ConnectorError(`Could not fetch the source: ${describe(err)}`);
    }
    if (!res.ok) {
      throw new ConnectorError(`The source responded ${res.status} ${res.statusText}.`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      throw new ConnectorError("The source is larger than the 25 MB limit.");
    }
    const text = new TextDecoder().decode(buf);
    const rows = parseBody(text, res.headers.get("content-type") ?? "");
    this.rows = rows;
    this.columns = inferColumns(rows);
  }

  protected timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(FETCH_TIMEOUT_MS);
  }

  async test(): Promise<void> {
    await this.ensureLoaded();
  }

  async introspectSchema(): Promise<SourceSchema> {
    await this.ensureLoaded();
    return { columns: this.columns, tables: ["data"] };
  }

  async fetchRows(opts: FetchRowsOptions): Promise<DataSlice> {
    await this.ensureLoaded();
    const all = this.rows ?? [];
    const slice = all.slice(opts.offset, opts.offset + opts.limit);
    return {
      columns: this.columns,
      rows: slice,
      rowCount: slice.length,
      capped: opts.offset + opts.limit < all.length,
    };
  }

  async runCompiled(): Promise<DataSlice> {
    throw new ConnectorError(
      "This source runs locally — it has no server-side SQL engine to push down to.",
    );
  }

  async dispose(): Promise<void> {
    this.rows = null;
  }
}

export class HttpFileConnector extends FetchConnector {
  readonly kind = "http-file" as const;
  constructor(private readonly secret: { url: string }) {
    super();
  }
  protected request(): Promise<Response> {
    return fetch(this.secret.url, { signal: this.timeoutSignal(), redirect: "follow" });
  }
}

export class RestApiConnector extends FetchConnector {
  readonly kind = "rest-api" as const;
  constructor(private readonly secret: { url: string; authToken?: string }) {
    super();
  }
  protected request(): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.secret.authToken) headers.Authorization = `Bearer ${this.secret.authToken}`;
    return fetch(this.secret.url, { headers, signal: this.timeoutSignal(), redirect: "follow" });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
