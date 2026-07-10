"use client";

/**
 * DashboardPage — wires the workspace shell to the data-source layer, the query
 * builder, and the saved-queries browser.
 *
 * The page holds only small, safe metadata: which section is active, the source
 * list/active source (via `useDataSources`), and the query-panel session (via
 * `useQueryWorkspace` — editor state + the open saved query + its results
 * request). It NEVER holds raw rows — every source activation hands rows straight
 * into the engine workers; the page only sees `{ rowCount, columns }` summaries.
 *
 * Layout (Supabase-style): IconRail (primary nav) → Topbar → section surface.
 * The SQL Editor section adds a contextual QuerySidebar plus an editor/results
 * split (stacked in SQL mode, side-by-side in Builder mode).
 */

import * as React from "react";
import { Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import type { PanelKey } from "@/components/layout/IconRail";
import type { EngineStatus } from "@/components/layout/Topbar";
import { QuerySidebar } from "@/components/layout/QuerySidebar";
import { ResizableSplit } from "@/components/layout/ResizableSplit";
import { AccountMenu } from "@/components/layout/AccountMenu";
import { CommandMenu } from "@/components/CommandMenu";
import { QueryPanel } from "@/components/query/QueryPanel";
import { DataSourcePanel } from "@/components/sources/DataSourcePanel";
import { DashboardPanel } from "@/components/dashboard/DashboardPanel";
import { SavedQueriesPanel } from "@/components/saved/SavedQueriesPanel";
import { FieldsPanel } from "@/components/fields/FieldsPanel";
import { HistoryPanel } from "@/components/history/HistoryPanel";
import { ResultsRegion } from "@/components/results/ResultsRegion";
import { useAnalyticsEngine } from "@/hooks/useAnalyticsEngine";
import { DEMO_SOURCE_ID, useDataSources } from "@/hooks/useDataSources";
import { useQueryWorkspace } from "@/hooks/useQueryWorkspace";
import { importLocalDataOnce } from "@/lib/migration/import-local";

const SECTION_TITLE: Record<PanelKey, string> = {
  sources: "Data sources",
  fields: "Fields",
  query: "SQL Editor",
  results: "History",
  saved: "Saved queries",
  dashboards: "Dashboards",
};

/**
 * Bootstrap gate: run the one-time localStorage→server import BEFORE mounting the
 * workspace, so the data hooks inside `Workspace` fetch already-migrated records.
 * The guard key makes this instant on every load after the first.
 */
export default function DashboardPage() {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    void importLocalDataOnce().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <Workspace />;
}

function Workspace() {
  const [panel, setPanel] = React.useState<PanelKey>("query");
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [commandOpen, setCommandOpen] = React.useState(false);

  const engine = useAnalyticsEngine();
  const sources = useDataSources(engine);
  const workspace = useQueryWorkspace(engine, sources);

  const engineStatus: EngineStatus = engine.error
    ? "error"
    : engine.ready
      ? "ready"
      : "booting";

  // Activate the built-in demo once the engine is ready and nothing is loaded —
  // gives an immediately working builder without forcing a connection step.
  const autoStarted = React.useRef(false);
  React.useEffect(() => {
    if (engine.ready && !autoStarted.current && sources.activeId === null) {
      autoStarted.current = true;
      void sources.activate(DEMO_SOURCE_ID);
    }
  }, [engine.ready, sources]);

  const active = sources.activeSource;
  const sourceSubtitle = active
    ? active.status === "ready" && typeof active.rowCount === "number"
      ? `${active.name} · ${active.rowCount.toLocaleString()} rows`
      : active.name
    : "No source selected";

  const subtitle =
    panel === "dashboards" || panel === "saved" || panel === "results"
      ? undefined
      : sourceSubtitle;

  return (
    <>
      <AppShell
        active={panel}
        onSelect={setPanel}
        title={SECTION_TITLE[panel]}
        subtitle={subtitle}
        engineStatus={engineStatus}
        actions={<AccountMenu />}
        onOpenCommand={() => setCommandOpen(true)}
      >
        {panel === "sources" ? (
          <div className="h-full">
            <DataSourcePanel api={sources} />
          </div>
        ) : panel === "fields" ? (
          <FieldsPanel sources={sources} />
        ) : panel === "results" ? (
          <HistoryPanel
            workspace={workspace}
            sources={sources}
            onOpened={() => setPanel("query")}
          />
        ) : panel === "dashboards" ? (
          <DashboardPanel engine={engine} sources={sources} />
        ) : panel === "saved" ? (
          <SavedQueriesPanel
            workspace={workspace}
            sources={sources}
            onOpened={() => setPanel("query")}
          />
        ) : panel === "query" ? (
          <div className="flex h-full min-h-0">
            <QuerySidebar
              workspace={workspace}
              sources={sources}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
            />
            <div className="min-w-0 flex-1 p-3">
              {workspace.mode === "sql" ? (
                <ResizableSplit
                  orientation="vertical"
                  className="h-full"
                  defaultSize={55}
                  first={
                    <div className="h-full pb-3">
                      <QueryPanel
                        workspace={workspace}
                        onBrowseSaved={() => setPanel("saved")}
                      />
                    </div>
                  }
                  second={
                    <div className="h-full pt-3">
                      <ResultsRegion
                        engine={engine}
                        request={workspace.request}
                        defaultView={workspace.defaultResultView}
                        viz={workspace.viz}
                        onResult={workspace.recordResult}
                      />
                    </div>
                  }
                />
              ) : (
                <div className="grid h-full grid-cols-1 gap-3 lg:grid-cols-[420px_minmax(0,1fr)]">
                  <QueryPanel
                    workspace={workspace}
                    onBrowseSaved={() => setPanel("saved")}
                  />
                  <ResultsRegion
                    engine={engine}
                    request={workspace.request}
                    defaultView={workspace.defaultResultView}
                    onResult={workspace.recordResult}
                  />
                </div>
              )}
            </div>
          </div>
        ) : (
          <PanelPlaceholder />
        )}
      </AppShell>

      <CommandMenu
        open={commandOpen}
        onOpenChange={setCommandOpen}
        onNavigate={setPanel}
        onNewQuery={() => {
          workspace.newQuery();
          setPanel("query");
        }}
      />
    </>
  );
}

function PanelPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="text-center">
        <p className="text-sm font-medium">Coming soon</p>
        <p className="text-xs text-muted-foreground">
          This panel arrives in a later step.
        </p>
      </div>
    </div>
  );
}
