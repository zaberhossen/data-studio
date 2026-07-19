/**
 * Client-side persistence for file-upload data sources.
 *
 * File sources never touch the server (CLAUDE.md boundary) — the raw `File`
 * handle stays in the browser and is re-fed to the DuckDB worker on activate.
 * IndexedDB structured-clones `File`/`Blob` natively, so `{ id, name, file }`
 * rows persist verbatim and rehydrate on boot; without this store the handles
 * lived only in a `useRef` and every refresh silently dropped them.
 *
 * Records are **org-scoped** (`orgId`): file sources are per-workspace like every
 * other source, so `list(orgId)` returns only the active org's uploads and a
 * file added under one org never bleeds into another on the same browser.
 *
 * Mirrors the pluggable-store shape of `@/lib/fields/overrides-store` (the
 * IndexedDB impl can be swapped without touching `useDataSources`).
 */

export interface LocalFileSourceRecord {
  id: string;
  /** Owning org — file sources are per-workspace, like server sources. */
  orgId: string;
  name: string;
  file: File;
  addedAt: number;
}

export interface LocalSourcesStore {
  /** File sources for one org, oldest first. */
  list(orgId: string): Promise<LocalFileSourceRecord[]>;
  put(record: LocalFileSourceRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB_NAME = "data-studio";
const DB_VERSION = 1;
const STORE = "file-sources";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB."));
  });
}

class IdbLocalSourcesStore implements LocalSourcesStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB operation failed."));
    });
  }

  async list(orgId: string): Promise<LocalFileSourceRecord[]> {
    const rows = await this.tx<LocalFileSourceRecord[]>("readonly", (s) => s.getAll());
    return rows.filter((r) => r.orgId === orgId).sort((a, b) => a.addedAt - b.addedAt);
  }

  async put(record: LocalFileSourceRecord): Promise<void> {
    await this.tx("readwrite", (s) => s.put(record));
  }

  async remove(id: string): Promise<void> {
    await this.tx("readwrite", (s) => s.delete(id));
  }
}

/** SSR / private-mode fallback: inert reads and writes. */
class NoopLocalSourcesStore implements LocalSourcesStore {
  async list(): Promise<LocalFileSourceRecord[]> {
    return [];
  }
  async put(): Promise<void> {}
  async remove(): Promise<void> {}
}

let store: LocalSourcesStore | null = null;
export function getLocalSourcesStore(): LocalSourcesStore {
  if (!store) {
    store =
      typeof indexedDB === "undefined"
        ? new NoopLocalSourcesStore()
        : new IdbLocalSourcesStore();
  }
  return store;
}

/**
 * Last-active source id, **per org** — restored on boot so a refresh (or org
 * switch) lands the user back on the source they were querying in THAT org
 * (falls back to the demo when unknown). Keying by org means switching
 * workspaces never carries a foreign source id.
 */
const ACTIVE_KEY_PREFIX = "data-studio:active-source";

function activeKey(orgId: string): string {
  return `${ACTIVE_KEY_PREFIX}:${orgId}`;
}

export function readActiveSourceId(orgId: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(activeKey(orgId)) : null;
  } catch {
    return null;
  }
}

export function writeActiveSourceId(orgId: string, id: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (id) window.localStorage.setItem(activeKey(orgId), id);
    else window.localStorage.removeItem(activeKey(orgId));
  } catch {
    // Quota / private mode — continuity is best-effort.
  }
}
