"use client";

/**
 * QuerySidebar — the contextual secondary nav for the SQL Editor section
 * (Supabase-style snippet tree). A collapsible ~240px column listing saved
 * queries and recent runs, with a "New query" action on top. Clicking an item
 * loads it into the workspace; a dirty open query is confirmed before discard.
 *
 * This is a lightweight browser that reuses the workspace's existing open flows
 * (`openSavedQuery` / `openHistoryEntry`) — the full-featured management UI still
 * lives in the Saved / History sections.
 *
 * shadcn primitives / tokens: Input (search), Button, ConfirmDialog.
 */

import * as React from "react";
import {
  ChevronsLeft,
  ChevronsRight,
  FilePlus2,
  History,
  Loader2,
  Save,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DataSourcesApi } from "@/hooks/useDataSources";
import type { QueryWorkspace } from "@/hooks/useQueryWorkspace";
import type { SavedQuerySummary } from "@/lib/saved-queries/store";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";

interface QuerySidebarProps {
  workspace: QueryWorkspace;
  sources: DataSourcesApi;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function QuerySidebar({
  workspace,
  collapsed,
  onToggleCollapsed,
}: QuerySidebarProps) {
  const {
    list,
    listLoading,
    openSavedQuery,
    openingId,
    newQuery,
    historyList,
    openHistoryEntry,
    dirty,
    open,
  } = workspace;

  const [search, setSearch] = React.useState("");
  const [pendingOpen, setPendingOpen] = React.useState<SavedQuerySummary | null>(
    null,
  );
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      [s.name, s.description ?? ""].join(" ").toLowerCase().includes(q),
    );
  }, [list, search]);

  const doOpen = async (s: SavedQuerySummary) => {
    await openSavedQuery(s);
  };
  const requestOpen = (s: SavedQuerySummary) => {
    if (dirty && open && open.id !== s.id) setPendingOpen(s);
    else void doOpen(s);
  };

  if (collapsed) {
    return (
      <div className="flex h-full w-10 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onToggleCollapsed}
          title="Expand panel"
          aria-label="Expand panel"
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={newQuery}
          title="New query"
          aria-label="New query"
        >
          <FilePlus2 className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between gap-1 border-b border-border px-2 py-2">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 flex-1 justify-start gap-1.5"
          onClick={newQuery}
        >
          <FilePlus2 className="h-3.5 w-3.5" />
          New query
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onToggleCollapsed}
          title="Collapse panel"
          aria-label="Collapse panel"
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
      </div>

      {/* Search */}
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search queries"
            className="h-8 pl-8"
            aria-label="Search saved queries"
          />
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        <Section icon={Save} label={`Saved${list.length ? ` (${list.length})` : ""}`}>
          {listLoading ? (
            <RowMuted>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </RowMuted>
          ) : filtered.length === 0 ? (
            <RowMuted>{search ? "No matches" : "No saved queries"}</RowMuted>
          ) : (
            filtered.map((s) => {
              const isOpening = openingId === s.id;
              const isCurrent = open?.id === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => requestOpen(s)}
                  title={s.name}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                    isCurrent
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {isOpening ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  )}
                  <span className="truncate">{s.name}</span>
                </button>
              );
            })
          )}
        </Section>

        <Section
          icon={History}
          label={`Recent${historyList.length ? ` (${historyList.length})` : ""}`}
        >
          {historyList.length === 0 ? (
            <RowMuted>No recent runs</RowMuted>
          ) : (
            historyList.slice(0, 10).map((entry) => {
              const isBusy = busyId === entry.id;
              const label =
                (entry.sql ?? "").replace(/\s+/g, " ").trim() ||
                (entry.query
                  ? `${entry.query.aggregation.func} by ${entry.query.group_by}`
                  : "query");
              return (
                <button
                  key={entry.id}
                  type="button"
                  title={label}
                  onClick={async () => {
                    setBusyId(entry.id);
                    try {
                      await openHistoryEntry(entry);
                    } finally {
                      setBusyId(null);
                    }
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {isBusy ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <History className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  )}
                  <span className="truncate">{label}</span>
                </button>
              );
            })
          )}
        </Section>
      </div>

      <ConfirmDialog
        open={!!pendingOpen}
        onOpenChange={(o) => !o && setPendingOpen(null)}
        title="Discard unsaved changes?"
        description={
          <>
            “{open?.name}” has unsaved edits. Opening another query will discard
            them.
          </>
        }
        confirmLabel="Discard & open"
        onConfirm={() => {
          const target = pendingOpen;
          setPendingOpen(null);
          if (target) void doOpen(target);
        }}
      />
    </div>
  );
}

function Section({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1">
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      {children}
    </div>
  );
}

function RowMuted({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}
