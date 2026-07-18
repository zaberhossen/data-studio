"use client";

/**
 * WorkspaceProvider — hoists the analytics engine + its two Web Workers, the
 * data-source layer, and the query-workspace session into a single React context
 * mounted in the `(app)` layout.
 *
 * WHY THIS EXISTS: the app moved from one SPA page to real Next.js routes. The
 * App Router keeps a *layout* mounted across navigations within its segment, so
 * calling `useAnalyticsEngine()` here (once, above the router outlet) means the
 * workers boot ONCE and survive route changes — navigating /sql ⇄ /editor never
 * reboots the engine or drops the resident dataset / editor state.
 *
 * Invariants (CLAUDE.md): React still never holds raw rows — the hooks below
 * only surface `{ rowCount, columns }` summaries + bounded result pages. The
 * one-time localStorage→server import gate lives here so every routed page
 * fetches already-migrated records against a ready engine. Source
 * auto-activation (saved-source restore with demo fallback) is owned by
 * `useDataSources` itself.
 */

import * as React from "react";
import { Loader2 } from "lucide-react";
import { useAnalyticsEngine, type AnalyticsEngine } from "@/hooks/useAnalyticsEngine";
import { useDataSources, type DataSourcesApi } from "@/hooks/useDataSources";
import { useQueryWorkspace, type QueryWorkspace } from "@/hooks/useQueryWorkspace";
import { importLocalDataOnce } from "@/lib/migration/import-local";

export type EngineStatus = "booting" | "ready" | "error";

interface WorkspaceContextValue {
  engine: AnalyticsEngine;
  sources: DataSourcesApi;
  workspace: QueryWorkspace;
  engineStatus: EngineStatus;
}

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  // Bootstrap gate: run the one-time localStorage→server import BEFORE mounting
  // the hooks, so the data hooks fetch already-migrated records. The guard key
  // makes this instant on every load after the first.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    void importLocalDataOnce().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <Mounted>{children}</Mounted>;
}

function Mounted({ children }: { children: React.ReactNode }) {
  const engine = useAnalyticsEngine();
  const sources = useDataSources(engine);
  const workspace = useQueryWorkspace(engine, sources);

  const engineStatus: EngineStatus = engine.error
    ? "error"
    : engine.ready
      ? "ready"
      : "booting";

  const value = React.useMemo<WorkspaceContextValue>(
    () => ({ engine, sources, workspace, engineStatus }),
    [engine, sources, workspace, engineStatus],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

function useWorkspaceContext(): WorkspaceContextValue {
  const ctx = React.useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspaceContext must be used within a WorkspaceProvider");
  }
  return ctx;
}

export const useEngine = (): AnalyticsEngine => useWorkspaceContext().engine;
export const useSources = (): DataSourcesApi => useWorkspaceContext().sources;
export const useWorkspace = (): QueryWorkspace => useWorkspaceContext().workspace;
export const useEngineStatus = (): EngineStatus => useWorkspaceContext().engineStatus;
