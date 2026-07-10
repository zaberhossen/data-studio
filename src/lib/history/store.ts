/**
 * Query run history — a bounded, most-recent-first log of executions from the
 * query panel (builder runs, SQL runs, and opening a saved query).
 *
 * Mirrors `@/lib/saved-queries/store`'s pluggable shape (an async interface so
 * the localStorage MVP can be swapped for an API-backed store without
 * touching callers) but is deliberately simpler: one JSON array under a
 * single key, capped at `MAX_ENTRIES`. History is inherently bounded — unlike
 * saved queries there's no need for an index/record split for cheap listing.
 *
 * INVARIANT: an entry holds a `QueryDefinition`-shaped snapshot + run stats —
 * never rows or a materialized result.
 */

import type { Query } from "@/lib/types/analytics";
import type { QueryIR } from "@/lib/query/ir";
import type { QueryKind, WidgetViz } from "@/lib/types/query";

export type HistoryStatus = "running" | "ok" | "error";

export interface HistoryEntry {
  id: string;
  sourceId: string;
  queryKind: QueryKind;
  /** Present when `queryKind === "builder"`. */
  query?: Query;
  /** Present when `queryKind === "ir"` (the advanced builder). */
  ir?: QueryIR;
  /** Present when `queryKind === "sql"`. */
  sql?: string;
  viz: WidgetViz;
  ranAt: string;
  status: HistoryStatus;
  rowCount?: number;
  elapsedMs?: number;
  errorMessage?: string;
}

export type NewHistoryEntry = Omit<HistoryEntry, "id" | "ranAt" | "status">;
export type HistoryPatch = Partial<
  Pick<HistoryEntry, "status" | "rowCount" | "elapsedMs" | "errorMessage">
>;

export interface HistoryStore {
  /** Most-recent-first. */
  list(): Promise<HistoryEntry[]>;
  /** Record a new run (status starts "running"); returns it with its id. */
  record(entry: NewHistoryEntry): Promise<HistoryEntry>;
  /** Patch stats onto an entry once its result settles. */
  patch(id: string, patch: HistoryPatch): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

const STORAGE_KEY = "data-studio:query-history";
const MAX_ENTRIES = 50;

function nextId(): string {
  const uuid =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(performance.now() * 1000) % 1_000_000}`;
  return `hist_${uuid}`;
}

/** SSR-safe: `storage()` returns null off the browser (inert reads/writes). */
export class LocalHistoryStore implements HistoryStore {
  private storage(): Storage | null {
    return typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : null;
  }

  private read(): HistoryEntry[] {
    const s = this.storage();
    if (!s) return [];
    try {
      const raw = s.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  private write(entries: HistoryEntry[]): void {
    this.storage()?.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  }

  async list(): Promise<HistoryEntry[]> {
    return this.read();
  }

  async record(entry: NewHistoryEntry): Promise<HistoryEntry> {
    const full: HistoryEntry = { ...entry, id: nextId(), ranAt: new Date().toISOString(), status: "running" };
    this.write([full, ...this.read()]);
    return full;
  }

  async patch(id: string, patch: HistoryPatch): Promise<void> {
    const entries = this.read();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return;
    entries[idx] = { ...entries[idx], ...patch };
    this.write(entries);
  }

  async remove(id: string): Promise<void> {
    this.write(this.read().filter((e) => e.id !== id));
  }

  async clear(): Promise<void> {
    this.storage()?.removeItem(STORAGE_KEY);
  }
}

let store: HistoryStore | null = null;
export function getHistoryStore(): HistoryStore {
  if (!store) store = new LocalHistoryStore();
  return store;
}
