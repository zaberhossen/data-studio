/**
 * Stable query hashing for the result cache.
 *
 * The scheduler caches results keyed by (sourceId + stable-hash(query|sql)) so
 * identical queries — duplicate widgets, re-renders, a rebuilt dashboard — reuse
 * a cached result instead of re-executing on the single-threaded worker.
 *
 * "Stable" is the whole point: two structurally-equal queries MUST hash the
 * same regardless of object key order or how they were constructed. We achieve
 * that by canonicalizing to JSON with recursively-sorted keys, then hashing the
 * string. `JSON.stringify` alone is NOT stable ({a,b} vs {b,a}), so we can't use
 * it directly as a cache key.
 */

import type { Query } from "@/lib/types/analytics";
import type { Widget } from "@/lib/types/dashboard";

/** Serialize any JSON-ish value with object keys sorted recursively. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys
    // Drop `undefined` fields so an absent key and an explicit `undefined` match.
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * A fast, dependency-free 53-bit string hash (cyrb53). Not cryptographic — it
 * only needs low collision probability for cache keys, which this comfortably
 * provides. Returns a positive base-36 string for compact keys.
 */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hashed = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return hashed.toString(36);
}

/** Stable hash of a builder `Query` (key-order independent). */
export function hashQuery(query: Query): string {
  return cyrb53(canonicalize(query));
}

/** Stable hash of a SQL string (whitespace-insensitive at the edges). */
export function hashSql(sql: string): string {
  return cyrb53(sql.trim());
}

/**
 * The cache key for a widget's result: `sourceId::kind::hash`. Two widgets that
 * run the same query against the same source share a key (and thus a cached
 * result); changing the source, kind, or the query invalidates it naturally.
 */
export function widgetCacheKey(widget: Widget): string {
  if (widget.queryKind === "sql") {
    return `${widget.sourceId}::sql::${hashSql(widget.sql ?? "")}`;
  }
  if (widget.queryKind === "ir") {
    return `${widget.sourceId}::ir::${widget.ir ? cyrb53(canonicalize(widget.ir)) : "∅"}`;
  }
  return `${widget.sourceId}::builder::${widget.query ? hashQuery(widget.query) : "∅"}`;
}
