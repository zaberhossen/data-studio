/**
 * Definition equality for dirty tracking.
 *
 * The save flow shows a "modified" indicator when the live editor state drifts
 * from the stored query, and confirms before discarding those edits. That
 * hinges on comparing two `QueryDefinition`s structurally — key-order- and
 * `undefined`-insensitive — which is exactly what the scheduler's stable
 * canonicalizer already does. We reuse it so the comparison matches the cache's
 * notion of "the same query".
 */

import { canonicalize } from "@/lib/dashboard/hash";
import type { QueryDefinition, SavedQuery } from "@/lib/types/query";

/**
 * Strip identity + metadata off a saved query, leaving its definition core. Only
 * the payload canonical for the `queryKind` is kept — a builder record carries a
 * DERIVED `ir` (added by the store's `migrateOnRead`) that must NOT count toward
 * equality, or a plain read would look "modified".
 */
export function toDefinition(q: QueryDefinition): QueryDefinition {
  return {
    sourceId: q.sourceId,
    queryKind: q.queryKind,
    query: q.queryKind === "builder" ? q.query : undefined,
    ir: q.queryKind === "ir" ? q.ir : undefined,
    sql: q.queryKind === "sql" ? q.sql : undefined,
    viz: q.viz,
  };
}

/**
 * True when two definitions are structurally equal. Only the fields relevant to
 * the definition's active mode matter — the canonicalizer drops `undefined`, so
 * a builder query with `sql: undefined` matches one that never set `sql`.
 */
export function sameDefinition(
  a: QueryDefinition,
  b: QueryDefinition,
): boolean {
  return canonicalize(toDefinition(a)) === canonicalize(toDefinition(b));
}

/** Whether the live definition has unsaved edits relative to the stored one. */
export function isDirty(
  live: QueryDefinition,
  saved: SavedQuery | null,
): boolean {
  if (!saved) return false;
  return !sameDefinition(live, saved);
}
