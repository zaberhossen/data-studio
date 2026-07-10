"use client";

/**
 * SavedQueriesPanel — the saved-queries browser.
 *
 * A searchable list of every saved query (name · source · kind badge ·
 * updated), sorted by most-recently-updated. Each row opens, inline-renames,
 * duplicates, adds-to-dashboard, or deletes (with confirm). Opening restores the
 * query in the query panel through the workspace's open flow (activate source →
 * restore mode + viz → run); a dirty open query prompts to discard first.
 *
 * shadcn primitives / tokens: Input (search + inline rename), Button, Badge,
 * Dialog (confirm). All states handled: loading, error, empty, populated,
 * opening (per-row spinner), and transient action notices.
 */

import * as React from "react";
import {
  Copy,
  Database,
  FolderOpen,
  LayoutDashboard,
  Loader2,
  Pencil,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DataSourcesApi } from "@/hooks/useDataSources";
import type { QueryWorkspace } from "@/hooks/useQueryWorkspace";
import type { SavedQuerySummary } from "@/lib/saved-queries/store";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";

interface SavedQueriesPanelProps {
  workspace: QueryWorkspace;
  sources: DataSourcesApi;
  /** Called after a query opens, so the shell can switch to the query panel. */
  onOpened: () => void;
}

/** Compact, locale-aware "updated" label with a full timestamp on hover. */
function formatUpdated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SavedQueriesPanel({
  workspace,
  sources,
  onOpened,
}: SavedQueriesPanelProps) {
  const {
    list,
    listLoading,
    listError,
    refreshList,
    openSavedQuery,
    openingId,
    renameSaved,
    duplicateSaved,
    removeSaved,
    addToDashboard,
    dirty,
    open,
  } = workspace;

  const [search, setSearch] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleting, setDeleting] = React.useState<SavedQuerySummary | null>(null);
  const [pendingOpen, setPendingOpen] = React.useState<SavedQuerySummary | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const sourceName = React.useCallback(
    (id: string) => sources.sources.find((s) => s.id === id)?.name ?? id,
    [sources.sources],
  );

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      [s.name, s.description ?? "", sourceName(s.sourceId), s.queryKind]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [list, search, sourceName]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((cur) => (cur === msg ? null : cur)), 3000);
  };

  const doOpen = async (s: SavedQuerySummary) => {
    await openSavedQuery(s);
    onOpened();
  };

  const requestOpen = (s: SavedQuerySummary) => {
    // Confirm before discarding unsaved edits on the currently-open query.
    if (dirty && open && open.id !== s.id) setPendingOpen(s);
    else void doOpen(s);
  };

  const commitRename = async (id: string) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name) return;
    setBusyId(id);
    try {
      await renameSaved(id, name);
    } finally {
      setBusyId(null);
    }
  };

  const handleDuplicate = async (id: string) => {
    setBusyId(id);
    try {
      const copy = await duplicateSaved(id);
      if (copy) flash(`Duplicated as “${copy.name}”.`);
    } finally {
      setBusyId(null);
    }
  };

  const handleAddToDashboard = async (s: SavedQuerySummary) => {
    setBusyId(s.id);
    try {
      const count = await addToDashboard(s.id);
      flash(
        count == null
          ? "Couldn't add to the dashboard."
          : `Added “${s.name}” to the dashboard (${count} widget${count === 1 ? "" : "s"}).`,
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search saved queries"
            className="h-8 w-64 pl-8"
            aria-label="Search saved queries"
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {list.length} saved {list.length === 1 ? "query" : "queries"}
        </span>
      </div>

      {notice && (
        <div className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground">
          {notice}
        </div>
      )}
      {listError && (
        <div className="flex items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          <span>{listError}</span>
          <Button variant="outline" size="sm" className="h-7" onClick={() => void refreshList()}>
            Retry
          </Button>
        </div>
      )}

      {/* ── Body ────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {listLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading saved queries…
          </div>
        ) : list.length === 0 ? (
          <EmptyState />
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No saved queries match “{search}”.
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((s) => {
              const isOpening = openingId === s.id;
              const isBusy = busyId === s.id;
              const isCurrent = open?.id === s.id;
              return (
                <li
                  key={s.id}
                  className={cn(
                    "flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3",
                    isCurrent && "ring-1 ring-primary/40",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    {renamingId === s.id ? (
                      <Input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void commitRename(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(s.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="h-8 max-w-sm"
                        aria-label="Rename query"
                      />
                    ) : (
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{s.name}</span>
                        {isCurrent && <Badge variant="secondary">Open</Badge>}
                      </div>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Database className="h-3 w-3" />
                        {sourceName(s.sourceId)}
                      </span>
                      <Badge variant="muted" className="uppercase">
                        {s.queryKind}
                      </Badge>
                      <span title={new Date(s.updatedAt).toISOString()}>
                        Updated {formatUpdated(s.updatedAt)}
                      </span>
                      {s.description && (
                        <span className="truncate italic">· {s.description}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      className="h-8"
                      disabled={isOpening}
                      onClick={() => requestOpen(s)}
                    >
                      {isOpening ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FolderOpen className="h-3.5 w-3.5" />
                      )}
                      Open
                    </Button>
                    <IconAction
                      label="Rename"
                      disabled={isBusy}
                      onClick={() => {
                        setRenameValue(s.name);
                        setRenamingId(s.id);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </IconAction>
                    <IconAction
                      label="Duplicate"
                      disabled={isBusy}
                      onClick={() => void handleDuplicate(s.id)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </IconAction>
                    <IconAction
                      label="Add to dashboard"
                      disabled={isBusy}
                      onClick={() => void handleAddToDashboard(s)}
                    >
                      <LayoutDashboard className="h-3.5 w-3.5" />
                    </IconAction>
                    <IconAction
                      label="Delete"
                      destructive
                      disabled={isBusy}
                      onClick={() => setDeleting(s)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconAction>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Delete confirm. */}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete saved query?"
        description={
          deleting ? (
            <>
              “{deleting.name}” will be permanently removed. This can’t be undone.
            </>
          ) : null
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting) void removeSaved(deleting.id);
          setDeleting(null);
        }}
      />

      {/* Discard-before-open confirm. */}
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

function EmptyState() {
  return (
    <div className="mx-auto max-w-sm rounded-xl border border-dashed border-border p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Save className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="mt-4 text-sm font-medium">No saved queries yet</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Build a query in the Query builder, then Save it to reuse, duplicate, or
        drop onto a dashboard.
      </p>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8", destructive && "text-destructive hover:bg-destructive/10")}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
