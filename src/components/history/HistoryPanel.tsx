"use client";

/**
 * HistoryPanel — a most-recent-first log of query runs (builder, SQL, and
 * opening a saved query), each with source · kind · elapsed ms · row count ·
 * status. Clicking a row re-runs it through the query panel (activate source →
 * restore mode + query/sql + viz → run), mirroring `openSavedQuery`'s flow but
 * without the saved-query identity/dirty tracking.
 *
 * shadcn primitives / tokens: Badge, Button, ConfirmDialog. All states: loading,
 * empty, populated, per-row busy (re-running), "running" entries whose stats
 * haven't landed yet.
 */

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FolderOpen,
  History,
  Loader2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { DataSourcesApi } from "@/hooks/useDataSources";
import type { QueryWorkspace } from "@/hooks/useQueryWorkspace";
import type { HistoryEntry } from "@/lib/history/store";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";

interface HistoryPanelProps {
  workspace: QueryWorkspace;
  sources: DataSourcesApi;
  /** Called after re-running an entry, so the shell can switch to the query panel. */
  onOpened: () => void;
}

function formatRanAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function summarize(entry: HistoryEntry): string {
  if (entry.queryKind === "builder" && entry.query) {
    const { aggregation, group_by } = entry.query;
    const metric = aggregation.func === "count" ? "COUNT(*)" : `${aggregation.func.toUpperCase()}(${aggregation.column})`;
    return `${metric} by ${group_by}`;
  }
  if (entry.queryKind === "ir" && entry.ir) {
    const m = entry.ir.aggregations?.length ?? 0;
    const d = entry.ir.dimensions?.length ?? 0;
    const metrics = `${m} metric${m === 1 ? "" : "s"}`;
    const dims = d > 0 ? ` by ${d} dimension${d === 1 ? "" : "s"}` : "";
    return `Advanced · ${metrics}${dims}`;
  }
  return (entry.sql ?? "").replace(/\s+/g, " ").trim() || "(empty query)";
}

export function HistoryPanel({ workspace, sources, onOpened }: HistoryPanelProps) {
  const { historyList, historyLoading, openHistoryEntry, removeHistoryEntry, clearHistory } =
    workspace;

  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<HistoryEntry | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);

  const sourceName = React.useCallback(
    (id: string) => sources.sources.find((s) => s.id === id)?.name ?? id,
    [sources.sources],
  );

  const handleOpen = async (entry: HistoryEntry) => {
    setBusyId(entry.id);
    try {
      await openHistoryEntry(entry);
      onOpened();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <span className="text-xs text-muted-foreground">
          {historyList.length} recent {historyList.length === 1 ? "run" : "runs"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          disabled={historyList.length === 0}
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Clear history
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {historyLoading && historyList.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
          </div>
        ) : historyList.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-2">
            {historyList.map((entry) => {
              const isBusy = busyId === entry.id;
              return (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <StatusIcon status={entry.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm">{summarize(entry)}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Database className="h-3 w-3" />
                        {sourceName(entry.sourceId)}
                      </span>
                      <Badge variant="muted" className="uppercase">
                        {entry.queryKind}
                      </Badge>
                      <span title={entry.ranAt}>{formatRanAt(entry.ranAt)}</span>
                      {typeof entry.elapsedMs === "number" && (
                        <span>{Math.round(entry.elapsedMs)} ms</span>
                      )}
                      {typeof entry.rowCount === "number" && (
                        <span>{entry.rowCount.toLocaleString()} rows</span>
                      )}
                      {entry.status === "error" && entry.errorMessage && (
                        <span className="truncate text-destructive">
                          · {entry.errorMessage}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" className="h-8" disabled={isBusy} onClick={() => void handleOpen(entry)}>
                      {isBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FolderOpen className="h-3.5 w-3.5" />
                      )}
                      Run again
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:bg-destructive/10"
                      aria-label="Remove from history"
                      title="Remove from history"
                      disabled={isBusy}
                      onClick={() => setDeleting(entry)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Remove from history?"
        description="This entry will be removed from your run history. It doesn't affect any saved query."
        confirmLabel="Remove"
        onConfirm={() => {
          if (deleting) void removeHistoryEntry(deleting.id);
          setDeleting(null);
        }}
      />

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all history?"
        description="Every run in this list will be removed. This can't be undone."
        confirmLabel="Clear history"
        onConfirm={() => {
          void clearHistory();
          setConfirmClear(false);
        }}
      />
    </div>
  );
}

function StatusIcon({ status }: { status: HistoryEntry["status"] }) {
  if (status === "running") return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />;
  if (status === "error") return <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />;
  return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />;
}

function EmptyState() {
  return (
    <div className="mx-auto max-w-sm rounded-xl border border-dashed border-border p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <History className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="mt-4 text-sm font-medium">No runs yet</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Run a query in the Query builder — every run shows up here so you can
        jump back to it.
      </p>
    </div>
  );
}
