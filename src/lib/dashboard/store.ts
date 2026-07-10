/**
 * Pluggable dashboard persistence.
 *
 * `DashboardStore` is the seam: the UI depends only on this async interface, so
 * the MVP `localStorage` backing can be swapped for a `/api/dashboards` route
 * (or SQLite, or Postgres) without touching a single component. The methods are
 * async precisely so a network-backed store drops in unchanged.
 *
 * INVARIANT: a stored `Dashboard` holds only queries + layout + viz — never rows
 * or results (see `@/lib/types/dashboard`). This store persists that plain data
 * verbatim; it neither knows nor touches the engines.
 */

import type { Dashboard } from "@/lib/types/dashboard";
import { emptyDashboard } from "@/lib/types/dashboard";

/**
 * The single default dashboard id for this step (saved-dashboards CRUD lands
 * later). Shared so the panel and the "add to dashboard" quick-action target
 * the same record.
 */
export const DEFAULT_DASHBOARD_ID = "default";

export interface DashboardStore {
  /** Summaries for a picker (id + name only — cheap to list). */
  list(): Promise<Array<Pick<Dashboard, "id" | "name" | "updatedAt">>>;
  get(id: string): Promise<Dashboard | null>;
  /** Create a new (empty) dashboard; returns it with a store-assigned id. */
  create(name?: string): Promise<Dashboard>;
  /** Overwrite an existing dashboard; returns it (with `updatedAt` set). */
  save(dashboard: Dashboard): Promise<Dashboard>;
  remove(id: string): Promise<void>;
}

/** Client-only collision-free dashboard id (matches the other store layers). */
function nextDashboardId(): string {
  const uuid =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(performance.now() * 1000) % 1_000_000}`;
  return `dash_${uuid}`;
}

const STORAGE_PREFIX = "data-studio:dashboard:";
const INDEX_KEY = "data-studio:dashboards";

type IndexEntry = { id: string; name: string; updatedAt?: number };

/**
 * Browser `localStorage` implementation. Each dashboard is one key
 * (`data-studio:dashboard:<id>`); a small index key tracks the list so `list()`
 * doesn't scan every key. All methods are async to match the interface even
 * though the underlying calls are synchronous.
 *
 * SSR-safe: guards `window` so importing this on the server is inert (returns
 * empties / no-ops) — the dashboard UI is client-only anyway.
 */
export class LocalDashboardStore implements DashboardStore {
  private hasStorage(): boolean {
    return typeof window !== "undefined" && !!window.localStorage;
  }

  private readIndex(): IndexEntry[] {
    if (!this.hasStorage()) return [];
    try {
      const raw = window.localStorage.getItem(INDEX_KEY);
      return raw ? (JSON.parse(raw) as IndexEntry[]) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(entries: IndexEntry[]): void {
    if (!this.hasStorage()) return;
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
  }

  async list(): Promise<IndexEntry[]> {
    return this.readIndex();
  }

  async get(id: string): Promise<Dashboard | null> {
    if (!this.hasStorage()) return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_PREFIX + id);
      return raw ? (JSON.parse(raw) as Dashboard) : null;
    } catch {
      return null;
    }
  }

  async create(name = "Untitled dashboard"): Promise<Dashboard> {
    return this.save(emptyDashboard(nextDashboardId(), name));
  }

  async save(dashboard: Dashboard): Promise<Dashboard> {
    const saved: Dashboard = { ...dashboard, updatedAt: Date.now() };
    if (this.hasStorage()) {
      window.localStorage.setItem(
        STORAGE_PREFIX + saved.id,
        JSON.stringify(saved),
      );
      const index = this.readIndex().filter((e) => e.id !== saved.id);
      index.push({ id: saved.id, name: saved.name, updatedAt: saved.updatedAt });
      this.writeIndex(index);
    }
    return saved;
  }

  async remove(id: string): Promise<void> {
    if (!this.hasStorage()) return;
    window.localStorage.removeItem(STORAGE_PREFIX + id);
    this.writeIndex(this.readIndex().filter((e) => e.id !== id));
  }
}

/**
 * API-backed store (the DB is the source of truth from M6). A `Dashboard` is
 * decomposed into `dashboards` + `widgets` rows server-side and reassembled on
 * read; the browser holds no dashboards. Org-scoped + auth'd server-side.
 */
export class ApiDashboardStore implements DashboardStore {
  async list(): Promise<Array<Pick<Dashboard, "id" | "name" | "updatedAt">>> {
    const res = await fetch("/api/dashboards");
    if (!res.ok) throw new Error(await errText(res, "Failed to load dashboards."));
    return (await res.json()) as Array<Pick<Dashboard, "id" | "name" | "updatedAt">>;
  }

  async get(id: string): Promise<Dashboard | null> {
    const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await errText(res, "Failed to load the dashboard."));
    return (await res.json()) as Dashboard;
  }

  async create(name = "Untitled dashboard"): Promise<Dashboard> {
    const res = await fetch("/api/dashboards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(await errText(res, "Failed to create the dashboard."));
    return (await res.json()) as Dashboard;
  }

  async save(dashboard: Dashboard): Promise<Dashboard> {
    const res = await fetch(`/api/dashboards/${encodeURIComponent(dashboard.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dashboard),
    });
    if (!res.ok) throw new Error(await errText(res, "Failed to save the dashboard."));
    return (await res.json()) as Dashboard;
  }

  async remove(id: string): Promise<void> {
    const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(await errText(res, "Failed to delete the dashboard."));
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
 * The process-wide store singleton. API-backed by default now that dashboards
 * live in the multi-tenant DB. `LocalDashboardStore` is retained for the
 * one-time localStorage→server import (M6d).
 */
let store: DashboardStore | null = null;
export function getDashboardStore(): DashboardStore {
  if (!store) store = new ApiDashboardStore();
  return store;
}
