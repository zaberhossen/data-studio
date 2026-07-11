"use client";

/**
 * LogsView — the /logs page: a Supabase-logs-style layout for query-run history.
 * Left: a filter rail (Log Type by query kind, Level by status) with live counts.
 * Right: dense, monospace log rows (timestamp · status · summary · source ·
 * elapsed · rows). A row re-runs its entry through the workspace and routes to
 * the matching editor.
 *
 * Filtering is client-side over the hoisted `historyList` (metadata only).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSources, useWorkspace } from "@/app/(app)/WorkspaceProvider";
import type { HistoryEntry } from "@/lib/history/store";
import type { QueryKind } from "@/lib/types/query";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";

const KIND_LABEL: Record<QueryKind, string> = {
  builder: "Builder",
  ir: "Advanced",
  sql: "SQL",
};

function formatRanAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function summarize(entry: HistoryEntry): string {
  if (entry.queryKind === "builder" && entry.query) {
    const { aggregation, group_by } = entry.query;
    const metric =
      aggregation.func === "count"
        ? "COUNT(*)"
        : `${aggregation.func.toUpperCase()}(${aggregation.column})`;
    return `${metric} by ${group_by}`;
  }
  if (entry.queryKind === "ir" && entry.ir) {
    const m = entry.ir.aggregations?.length ?? 0;
    const d = entry.ir.dimensions?.length ?? 0;
    return `Advanced · ${m} metric${m === 1 ? "" : "s"}${d > 0 ? ` by ${d} dimension${d === 1 ? "" : "s"}` : ""}`;
  }
  return (entry.sql ?? "").replace(/\s+/g, " ").trim() || "(empty query)";
}

export function LogsView() {
  const router = useRouter();
  const sources = useSources();
  const { historyList, historyLoading, openHistoryEntry, removeHistoryEntry, clearHistory, refreshHistory } =
    useWorkspace();

  const [kinds, setKinds] = React.useState<Set<QueryKind>>(new Set());
  const [levels, setLevels] = React.useState<Set<"ok" | "error">>(new Set());
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<HistoryEntry | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);

  const sourceName = React.useCallback(
    (id: string) => sources.sources.find((s) => s.id === id)?.name ?? id,
    [sources.sources],
  );

  const kindCounts = React.useMemo(() => {
    const c: Record<QueryKind, number> = { builder: 0, ir: 0, sql: 0 };
    for (const e of historyList) c[e.queryKind]++;
    return c;
  }, [historyList]);

  const levelCounts = React.useMemo(() => {
    let ok = 0;
    let error = 0;
    for (const e of historyList) {
      if (e.status === "error") error++;
      else if (e.status === "ok") ok++;
    }
    return { ok, error };
  }, [historyList]);

  const filtered = React.useMemo(() => {
    return historyList.filter((e) => {
      if (kinds.size > 0 && !kinds.has(e.queryKind)) return false;
      if (levels.size > 0) {
        if (e.status === "error" && !levels.has("error")) return false;
        if (e.status === "ok" && !levels.has("ok")) return false;
        if (e.status === "running") return false;
      }
      return true;
    });
  }, [historyList, kinds, levels]);

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const hasFilters = kinds.size > 0 || levels.size > 0;

  const handleOpen = async (entry: HistoryEntry) => {
    setBusyId(entry.id);
    try {
      await openHistoryEntry(entry);
      router.push(entry.queryKind === "sql" ? "/sql" : "/editor");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left: filters ─────────────────────────────────────────────── */}
      <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-sm font-semibold">Logs</span>
          {hasFilters && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setKinds(new Set());
                setLevels(new Set());
              }}
            >
              <X className="h-3.5 w-3.5" />
              Reset
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <FilterGroup label="Log type">
            {(["builder", "ir", "sql"] as QueryKind[]).map((k) => (
              <FilterRow
                key={k}
                label={KIND_LABEL[k]}
                count={kindCounts[k]}
                checked={kinds.has(k)}
                onToggle={() => setKinds((s) => toggle(s, k))}
              />
            ))}
          </FilterGroup>

          <FilterGroup label="Level">
            <FilterRow
              label="Success"
              count={levelCounts.ok}
              dot="bg-emerald-500"
              checked={levels.has("ok")}
              onToggle={() => setLevels((s) => toggle(s, "ok"))}
            />
            <FilterRow
              label="Error"
              count={levelCounts.error}
              dot="bg-destructive"
              checked={levels.has("error")}
              onToggle={() => setLevels((s) => toggle(s, "error"))}
            />
          </FilterGroup>
        </div>
      </div>

      {/* ── Right: log rows ───────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          <span className="text-xs text-muted-foreground">
            {filtered.length} {filtered.length === 1 ? "event" : "events"}
            {hasFilters ? ` of ${historyList.length}` : ""}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="xs" onClick={() => void refreshHistory()}>
              <RefreshCw className={cn("h-3.5 w-3.5", historyLoading && "animate-spin")} />
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={historyList.length === 0}
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {historyLoading && historyList.length === 0 ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading logs…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {historyList.length === 0 ? "No query runs yet." : "No events match these filters."}
            </div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <tbody>
                {filtered.map((entry) => (
                  <tr
                    key={entry.id}
                    onClick={() => void handleOpen(entry)}
                    className="group cursor-pointer border-b border-border/60 hover:bg-accent/50"
                  >
                    <td className="w-40 whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">
                      {formatRanAt(entry.ranAt)}
                    </td>
                    <td className="w-6 py-2">
                      <StatusIcon status={entry.status} />
                    </td>
                    <td className="px-2 py-2">
                      <span className="font-mono text-foreground">{summarize(entry)}</span>
                      {entry.status === "error" && entry.errorMessage && (
                        <span className="ml-2 text-destructive">· {entry.errorMessage}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">
                      {sourceName(entry.sourceId)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-muted-foreground">
                      {typeof entry.elapsedMs === "number" ? `${Math.round(entry.elapsedMs)}ms` : ""}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-muted-foreground">
                      {typeof entry.rowCount === "number" ? `${entry.rowCount.toLocaleString()} rows` : ""}
                    </td>
                    <td className="w-8 px-2 py-2">
                      <button
                        type="button"
                        aria-label="Remove from history"
                        title="Remove"
                        disabled={busyId === entry.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(entry);
                        }}
                        className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      >
                        {busyId === entry.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
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
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  if (status === "error") return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function FilterRow({
  label,
  count,
  checked,
  dot,
  onToggle,
}: {
  label: string;
  count: number;
  checked: boolean;
  dot?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
    >
      <span
        className={cn(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
      >
        {checked && <CheckCircle2 className="h-2.5 w-2.5" />}
      </span>
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />}
      <span className="flex-1 truncate">{label}</span>
      <span className="font-mono text-xs text-muted-foreground">{count}</span>
    </button>
  );
}
