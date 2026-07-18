/**
 * URL sync for dashboard filter values — makes a filtered dashboard shareable
 * and bookmarkable. Active values are encoded as `f.<id>=<json>` query params
 * (JSON so every FilterValue shape round-trips exactly), and read back on load.
 *
 * Pure functions over a query string / ActiveFilters so they're unit-testable
 * without a DOM; the provider wires them to `window.location`.
 */

import type { ActiveFilters, FilterValue } from "@/lib/types/dashboard";

const PREFIX = "f.";

/** Read filter values out of a URL query string (`?f.region=…`). */
export function filtersFromSearch(search: string): ActiveFilters {
  const out: ActiveFilters = {};
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [key, raw] of params) {
    if (!key.startsWith(PREFIX)) continue;
    const id = key.slice(PREFIX.length);
    if (!id) continue;
    const value = decodeValue(raw);
    if (value !== undefined) out[id] = value;
  }
  return out;
}

/**
 * Merge active filter values INTO an existing query string, preserving any
 * non-filter params. Filter params absent from `active` are dropped; ids in
 * `skip` (e.g. locked filters) are never written. Returns the query string
 * WITHOUT a leading "?"; empty when nothing remains.
 */
export function searchWithFilters(
  search: string,
  active: ActiveFilters,
  skip: ReadonlySet<string> = new Set(),
): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  // Drop every existing filter param — we re-add the current ones below.
  for (const key of [...params.keys()]) {
    if (key.startsWith(PREFIX)) params.delete(key);
  }
  for (const [id, value] of Object.entries(active)) {
    if (skip.has(id) || !isMeaningful(value)) continue;
    params.set(`${PREFIX}${id}`, JSON.stringify(value));
  }
  return params.toString();
}

/** A value worth putting in the URL (not empty string / empty array). */
function isMeaningful(value: FilterValue | undefined): value is FilterValue {
  if (value === undefined || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function decodeValue(raw: string): FilterValue | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "string" ||
      typeof parsed === "number" ||
      typeof parsed === "boolean"
    ) {
      return parsed;
    }
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string" || typeof v === "number")) {
      return parsed as string[] | number[];
    }
    return undefined;
  } catch {
    // Tolerate a bare string that wasn't JSON-encoded (hand-edited URLs).
    return raw || undefined;
  }
}
