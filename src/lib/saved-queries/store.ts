/**
 * Pluggable saved-query persistence.
 *
 * `SavedQueryStore` is the seam — mirroring `@/lib/dashboard/store`: the UI
 * depends only on this async interface, so the MVP `localStorage` backing can be
 * swapped for a `/api/saved-queries` route (or SQLite, or Postgres) without
 * touching a single component. The methods are async precisely so a
 * network-backed store drops in unchanged.
 *
 * INVARIANT: a stored `SavedQuery` holds only a `QueryDefinition` + identity +
 * metadata — never rows or results, and never credentials (a `sourceId`
 * reference only; see `@/lib/types/query`). Every write stamps the current
 * `schemaVersion` so a future migration can detect + upgrade older records.
 */

import type { QueryDefinition, SavedQuery } from "@/lib/types/query";
import { SAVED_QUERY_SCHEMA_VERSION } from "@/lib/types/query";
import { queryV1ToIR } from "@/lib/query/compile";

/** Cheap-to-list row for the browser (no `query`/`sql` payload). */
export interface SavedQuerySummary {
  id: string;
  name: string;
  description?: string;
  sourceId: string;
  queryKind: SavedQuery["queryKind"];
  createdAt: string;
  updatedAt: string;
}

/** Fields a caller may change on an existing record (identity/timestamps are managed). */
export type SavedQueryPatch = Partial<
  QueryDefinition & Pick<SavedQuery, "name" | "description">
>;

export interface SavedQueryStore {
  /** Summaries only (cheap to list), sorted by `updatedAt` desc. */
  list(): Promise<SavedQuerySummary[]>;
  get(id: string): Promise<SavedQuery | null>;
  /** Create a brand-new saved query from a definition + name. */
  create(
    def: QueryDefinition,
    name: string,
    description?: string,
  ): Promise<SavedQuery>;
  /** Patch an existing record (definition and/or name/description). */
  update(id: string, patch: SavedQueryPatch): Promise<SavedQuery>;
  /** Convenience: rename only. */
  rename(id: string, name: string): Promise<SavedQuery>;
  remove(id: string): Promise<void>;
}

const STORAGE_PREFIX = "data-studio:saved-query:";
const INDEX_KEY = "data-studio:saved-queries";

/** Client-only collision-free id (the data-source/dashboard layers use the same). */
function nextId(): string {
  const uuid =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(performance.now() * 1000) % 1_000_000}`;
  return `sq_${uuid}`;
}

function toSummary(q: SavedQuery): SavedQuerySummary {
  return {
    id: q.id,
    name: q.name,
    description: q.description,
    sourceId: q.sourceId,
    queryKind: q.queryKind,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

/** Keep only the definition-shaped fields off an arbitrary patch. */
function definitionPatch(patch: SavedQueryPatch): Partial<QueryDefinition> {
  const out: Partial<QueryDefinition> = {};
  if (patch.sourceId !== undefined) out.sourceId = patch.sourceId;
  if (patch.queryKind !== undefined) out.queryKind = patch.queryKind;
  if (patch.query !== undefined) out.query = patch.query;
  if (patch.ir !== undefined) out.ir = patch.ir;
  if (patch.sql !== undefined) out.sql = patch.sql;
  if (patch.execution !== undefined) out.execution = patch.execution;
  if (patch.viz !== undefined) out.viz = patch.viz;
  return out;
}

/**
 * Lazy v1 → v2 upgrade on read: a legacy builder query gains a derived `ir` so
 * the advanced surfaces can open it. Non-destructive — `query` is kept, so the
 * Rust fast-path still fires; the `ir` persists on the next save.
 */
function migrateOnRead(q: SavedQuery): SavedQuery {
  if (q.queryKind === "builder" && q.query && !q.ir) {
    return { ...q, ir: queryV1ToIR(q.query), schemaVersion: SAVED_QUERY_SCHEMA_VERSION };
  }
  return q;
}

/**
 * Browser `localStorage` implementation. Each saved query is one key
 * (`data-studio:saved-query:<id>`); a small index key tracks summaries so
 * `list()` doesn't scan + parse every record. All methods are async to match
 * the interface even though the underlying calls are synchronous.
 *
 * SSR-safe: `store()` returns null off the browser, so importing this on the
 * server is inert (empties / rejections) — the saved-query UI is client-only.
 */
export class LocalSavedQueryStore implements SavedQueryStore {
  private store(): Storage | null {
    return typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : null;
  }

  private readIndex(): SavedQuerySummary[] {
    const s = this.store();
    if (!s) return [];
    try {
      const raw = s.getItem(INDEX_KEY);
      return raw ? (JSON.parse(raw) as SavedQuerySummary[]) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(entries: SavedQuerySummary[]): void {
    this.store()?.setItem(INDEX_KEY, JSON.stringify(entries));
  }

  private writeRecord(q: SavedQuery): void {
    const s = this.store();
    if (!s) return;
    s.setItem(STORAGE_PREFIX + q.id, JSON.stringify(q));
    const index = this.readIndex().filter((e) => e.id !== q.id);
    index.push(toSummary(q));
    this.writeIndex(index);
  }

  async list(): Promise<SavedQuerySummary[]> {
    return this.readIndex().sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async get(id: string): Promise<SavedQuery | null> {
    const s = this.store();
    if (!s) return null;
    try {
      const raw = s.getItem(STORAGE_PREFIX + id);
      return raw ? migrateOnRead(JSON.parse(raw) as SavedQuery) : null;
    } catch {
      return null;
    }
  }

  async create(
    def: QueryDefinition,
    name: string,
    description?: string,
  ): Promise<SavedQuery> {
    const now = new Date().toISOString();
    const record: SavedQuery = {
      ...def,
      id: nextId(),
      name,
      description: description?.trim() ? description.trim() : undefined,
      schemaVersion: SAVED_QUERY_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    this.writeRecord(record);
    return record;
  }

  async update(id: string, patch: SavedQueryPatch): Promise<SavedQuery> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Saved query "${id}" not found.`);
    const next: SavedQuery = {
      ...existing,
      ...definitionPatch(patch),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description?.trim() ? patch.description.trim() : undefined }
        : {}),
      // Always re-stamp the schema version + updatedAt on a write.
      schemaVersion: SAVED_QUERY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };
    this.writeRecord(next);
    return next;
  }

  async rename(id: string, name: string): Promise<SavedQuery> {
    return this.update(id, { name });
  }

  async remove(id: string): Promise<void> {
    const s = this.store();
    if (!s) return;
    s.removeItem(STORAGE_PREFIX + id);
    this.writeIndex(this.readIndex().filter((e) => e.id !== id));
  }
}

/**
 * API-backed store (the DB is the source of truth from M6). The browser holds no
 * saved queries — it fetches `/api/saved-queries`, which is org-scoped + auth'd
 * server-side. `migrateOnRead` still runs client-side so a legacy builder record
 * opens in the advanced builder.
 */
export class ApiSavedQueryStore implements SavedQueryStore {
  async list(): Promise<SavedQuerySummary[]> {
    const res = await fetch("/api/saved-queries");
    if (!res.ok) throw new Error(await errText(res, "Failed to load saved queries."));
    return (await res.json()) as SavedQuerySummary[];
  }

  async get(id: string): Promise<SavedQuery | null> {
    const res = await fetch(`/api/saved-queries/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await errText(res, "Failed to load the saved query."));
    return migrateOnRead((await res.json()) as SavedQuery);
  }

  async create(
    def: QueryDefinition,
    name: string,
    description?: string,
  ): Promise<SavedQuery> {
    const res = await fetch("/api/saved-queries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, definition: def }),
    });
    if (!res.ok) throw new Error(await errText(res, "Failed to save the query."));
    return (await res.json()) as SavedQuery;
  }

  async update(id: string, patch: SavedQueryPatch): Promise<SavedQuery> {
    const res = await fetch(`/api/saved-queries/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(await errText(res, "Failed to update the query."));
    return (await res.json()) as SavedQuery;
  }

  async rename(id: string, name: string): Promise<SavedQuery> {
    return this.update(id, { name });
  }

  async remove(id: string): Promise<void> {
    const res = await fetch(`/api/saved-queries/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(await errText(res, "Failed to delete the query."));
    }
  }
}

async function errText(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body?.error ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The process-wide store singleton. The API-backed store is the default now that
 * saved queries live in the multi-tenant DB; swap the constructed impl here to
 * change backends — no caller changes. `LocalSavedQueryStore` is retained for
 * the one-time localStorage→server import (M6d).
 */
let store: SavedQueryStore | null = null;
export function getSavedQueryStore(): SavedQueryStore {
  if (!store) store = new ApiSavedQueryStore();
  return store;
}
