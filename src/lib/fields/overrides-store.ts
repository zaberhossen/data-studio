/**
 * Per-source field overrides (role + display label) — the persistence layer
 * behind the Fields panel's curation UI.
 *
 * Keyed by source id; each source's overrides are one JSON object of
 * `{ [columnName]: FieldOverride }`. Layered onto the heuristic-derived
 * `Field[]` by `applyFieldOverrides` (`@/lib/query/schema`) inside
 * `useDataSources`, so QueryBuilder/SqlEditor see overrides without any
 * changes of their own — mirrors `@/lib/saved-queries/store`'s pluggable
 * shape (swap the localStorage impl for an API-backed one without touching
 * callers).
 */

import type { FieldOverride } from "@/lib/query/schema";

export type { FieldOverride };

export interface FieldOverridesStore {
  get(sourceId: string): Promise<Record<string, FieldOverride>>;
  set(
    sourceId: string,
    column: string,
    patch: FieldOverride,
  ): Promise<Record<string, FieldOverride>>;
  reset(sourceId: string, column: string): Promise<Record<string, FieldOverride>>;
  clear(sourceId: string): Promise<void>;
}

const KEY_PREFIX = "data-studio:field-overrides:";

/** SSR-safe: `storage()` returns null off the browser (inert reads/writes). */
export class LocalFieldOverridesStore implements FieldOverridesStore {
  private storage(): Storage | null {
    return typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : null;
  }

  private read(sourceId: string): Record<string, FieldOverride> {
    const s = this.storage();
    if (!s) return {};
    try {
      const raw = s.getItem(KEY_PREFIX + sourceId);
      return raw ? (JSON.parse(raw) as Record<string, FieldOverride>) : {};
    } catch {
      return {};
    }
  }

  private write(sourceId: string, overrides: Record<string, FieldOverride>): void {
    const s = this.storage();
    if (!s) return;
    if (Object.keys(overrides).length === 0) s.removeItem(KEY_PREFIX + sourceId);
    else s.setItem(KEY_PREFIX + sourceId, JSON.stringify(overrides));
  }

  async get(sourceId: string): Promise<Record<string, FieldOverride>> {
    return this.read(sourceId);
  }

  async set(
    sourceId: string,
    column: string,
    patch: FieldOverride,
  ): Promise<Record<string, FieldOverride>> {
    const current = this.read(sourceId);
    const next = { ...current, [column]: { ...current[column], ...patch } };
    this.write(sourceId, next);
    return next;
  }

  async reset(sourceId: string, column: string): Promise<Record<string, FieldOverride>> {
    const next = { ...this.read(sourceId) };
    delete next[column];
    this.write(sourceId, next);
    return next;
  }

  async clear(sourceId: string): Promise<void> {
    this.write(sourceId, {});
  }
}

let store: FieldOverridesStore | null = null;
export function getFieldOverridesStore(): FieldOverridesStore {
  if (!store) store = new LocalFieldOverridesStore();
  return store;
}
