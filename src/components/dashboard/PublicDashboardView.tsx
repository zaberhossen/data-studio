"use client";

/**
 * PublicDashboardView — the read-only shared/embedded dashboard.
 *
 * Fetches a token's frozen snapshot from `/api/public/[token]`, wraps it in a
 * `SnapshotScheduler` (no compute engine), and renders the SAME `DashboardView`
 * the authed app uses — in view mode, with no editing callbacks. Nothing here
 * knows a `sourceId`, table, or query; it only paints pre-computed rows.
 */

import * as React from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import type { Dashboard, Widget } from "@/lib/types/dashboard";
import type { PublicDashboard } from "@/lib/types/share";
import type { ResultTable } from "@/lib/types/results";
import { createSnapshotScheduler } from "@/lib/dashboard/snapshot-scheduler";
import { resolveActiveTab } from "@/lib/dashboard/tabs";
import { DashboardFilterProvider } from "./DashboardFilterContext";
import { DashboardView } from "./DashboardView";
import { DashboardTabs } from "./DashboardTabs";

interface Payload {
  dashboard: PublicDashboard;
  results: Record<string, ResultTable>;
  capturedAt: string;
}

/** Rehydrate a public widget into the full `Widget` shape (inert source/query). */
function toWidget(pw: PublicDashboard["widgets"][number]): Widget {
  return {
    id: pw.id,
    title: pw.title,
    viz: pw.viz,
    queryKind: pw.queryKind,
    sourceId: "",
    layout: pw.layout,
    canvasLayout: pw.canvasLayout,
    kind: "query",
    tabId: pw.tabId,
  };
}

export function PublicDashboardView({ token, embed = false }: { token: string; embed?: boolean }) {
  const [state, setState] = React.useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "ready"; payload: Payload }
  >({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/public/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "This link is unavailable.");
        }
        return (await res.json()) as Payload;
      })
      .then((payload) => !cancelled && setState({ status: "ready", payload }))
      .catch((e) => !cancelled && setState({ status: "error", message: e instanceof Error ? e.message : String(e) }))
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <div className="max-w-sm rounded-md border border-dashed border-border p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <LockKeyhole className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="mt-4 text-sm font-medium">Link unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">{state.message}</p>
        </div>
      </div>
    );
  }

  return <SnapshotDashboard payload={state.payload} embed={embed} />;
}

/**
 * Renders one frozen payload. Split out so its hooks run unconditionally, and so
 * the dashboard + scheduler are memoized on the payload — a fresh scheduler each
 * render would hand `useSyncExternalStore` new result references every time.
 */
function SnapshotDashboard({ payload, embed }: { payload: Payload; embed: boolean }) {
  const dashboard = React.useMemo<Dashboard>(
    () => ({
      id: "public",
      name: payload.dashboard.name,
      widgets: payload.dashboard.widgets.map(toWidget),
      elements: payload.dashboard.elements ?? [],
      layoutMode: payload.dashboard.layoutMode ?? "grid",
      canvas: payload.dashboard.canvas,
      tabs: payload.dashboard.tabs,
      filters: [],
    }),
    [payload],
  );
  const scheduler = React.useMemo(() => createSnapshotScheduler(payload.results), [payload]);

  // View-only tab selection (grid mode). Defaults to the first tab.
  const [activeTabChoice, setActiveTabChoice] = React.useState<string | null>(null);
  const activeTabId = resolveActiveTab(dashboard.tabs, activeTabChoice);
  const showTabs = (dashboard.layoutMode ?? "grid") === "grid" && !!dashboard.tabs?.length;

  return (
    <DashboardFilterProvider filterDefs={[]}>
      <div className="flex h-screen min-h-0 flex-col bg-background">
        {!embed && (
          <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">{dashboard.name}</h1>
              <p className="text-[11px] text-muted-foreground">
                Shared snapshot · captured {formatWhen(payload.capturedAt)}
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              Read-only
            </span>
          </header>
        )}
        {showTabs && (
          <DashboardTabs
            tabs={dashboard.tabs}
            activeTabId={activeTabId}
            editable={false}
            onSelect={setActiveTabChoice}
            onAdd={() => {}}
            onRename={() => {}}
            onRemove={() => {}}
          />
        )}
        <DashboardView
          dashboard={dashboard}
          scheduler={scheduler}
          mode="view"
          activeTabId={activeTabId}
        />
      </div>
    </DashboardFilterProvider>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "recently";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
