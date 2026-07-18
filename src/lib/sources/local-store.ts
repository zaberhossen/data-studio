/**
 * Client-side persistence for file-upload data sources.
 *
 * File sources never touch the server (CLAUDE.md boundary) — the raw `File`
 * handle stays in the browser and is re-fed to the DuckDB worker on activate.
 * IndexedDB structured-clones `File`/`Blob` natively, so `{ id, name, file }`
 * rows persist verbatim and rehydrate on boot; without this store the handles
 * lived only in a `useRef` and every refresh silently dropped them.
 *
 * Mirrors the pluggable-store shape of `@/lib/fields/overrides-store` (the
 * IndexedDB impl can be swapped without touching `useDataSources`).
 */

export interface LocalFileSourceRecord {
  id: string;
  name: string;
  file: File;
  addedAt: number;
}

export interface LocalSourcesStore {
  list(): Promise<LocalFileSourceRecord[]>;
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

  async list(): Promise<LocalFileSourceRecord[]> {
    const rows = await this.tx<LocalFileSourceRecord[]>("readonly", (s) => s.getAll());
    return rows.sort((a, b) => a.addedAt - b.addedAt);
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
 * Last-active source id — restored on boot so a refresh lands the user back on
 * the source they were querying (falls back to the demo when unknown).
 */
const ACTIVE_KEY = "data-studio:active-source";

export function readActiveSourceId(): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_KEY) : null;
  } catch {
    return null;
  }
}

export function writeActiveSourceId(id: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Quota / private mode — continuity is best-effort.
  }
}
