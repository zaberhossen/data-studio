"use client";

/**
 * One-time localStorage → server import.
 *
 * Before M6 saved queries + dashboards lived in `localStorage`. Now the DB is
 * the source of truth, so on first load after the upgrade we copy any local
 * records up to the org-scoped API, then set a guard key so it never runs again.
 *
 * It's intentionally best-effort + idempotent-guarded (not idempotent per row):
 * we import once. Individual failures are swallowed so one bad record can't wedge
 * the whole app; the guard is set afterward regardless (clear it to retry).
 *
 * Runs BEFORE the workspace mounts (see the bootstrap gate in the app page), so
 * the store lists it triggers afterward already reflect the imported records.
 */

import { LocalSavedQueryStore, getSavedQueryStore } from "@/lib/saved-queries/store";
import { LocalDashboardStore, getDashboardStore } from "@/lib/dashboard/store";
import { toDefinition } from "@/lib/saved-queries/dirty";

const GUARD_KEY = "data-studio:imported-to-server-v1";

export async function importLocalDataOnce(): Promise<void> {
  if (typeof window === "undefined" || !window.localStorage) return;
  if (window.localStorage.getItem(GUARD_KEY)) return;

  try {
    await importSavedQueries();
    await importDashboards();
  } catch {
    // Best-effort: never let a migration hiccup block the app.
  } finally {
    window.localStorage.setItem(GUARD_KEY, new Date().toISOString());
  }
}

async function importSavedQueries(): Promise<void> {
  const local = new LocalSavedQueryStore();
  const api = getSavedQueryStore();
  const summaries = await local.list();
  for (const s of summaries) {
    try {
      const full = await local.get(s.id);
      if (!full) continue;
      await api.create(toDefinition(full), full.name, full.description);
    } catch {
      // skip this record
    }
  }
}

async function importDashboards(): Promise<void> {
  const local = new LocalDashboardStore();
  const api = getDashboardStore();
  const summaries = await local.list();
  for (const s of summaries) {
    try {
      const full = await local.get(s.id);
      if (!full || full.widgets.length === 0) continue; // skip empty scratch dashboards
      const created = await api.create(full.name);
      await api.save({ ...full, id: created.id });
    } catch {
      // skip this dashboard
    }
  }
}
