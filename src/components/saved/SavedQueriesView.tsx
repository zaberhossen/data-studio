"use client";

/**
 * SavedQueriesView — the /saved page: a two-column browser (Supabase
 * "start with a template" style). Left: a templates block + the saved-query
 * list (searchable). Right: the selected query's preview + actions, shown in
 * place (no navigation until you Open it).
 *
 * Reuses the hoisted workspace handlers (open/rename/duplicate/remove/
 * addToDashboard). The right-pane preview lazily fetches the full record from
 * the saved-query store to render a read-only snippet.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Copy,
  Database,
  FileCode2,
  FolderOpen,
  LayoutDashboard,
  Loader2,
  Pencil,
  Save,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useSources, useWorkspace } from "@/app/(app)/WorkspaceProvider";
import type { SavedQuerySummary } from "@/lib/saved-queries/store";
import { getSavedQueryStore } from "@/lib/saved-queries/store";
import type { SavedQuery } from "@/lib/types/query";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";

interface Template {
  id: string;
  name: string;
  description: string;
  sql: string;
}

const TEMPLATES: Template[] = [
  {
    id: "select-all",
    name: "Select all rows",
    description: "Preview the first rows of the active dataset.",
    sql: "SELECT *\nFROM dataset\nLIMIT 100;",
  },
  {
    id: "row-count",
    name: "Count rows",
    description: "How many rows are in the dataset?",
    sql: "SELECT COUNT(*) AS total_rows\nFROM dataset;",
  },
  {
    id: "group-by",
    name: "Group & aggregate",
    description: "A starting point for a grouped aggregation.",
    sql: "SELECT\n  column_a,\n  COUNT(*) AS n\nFROM dataset\nGROUP BY column_a\nORDER BY n DESC;",
  },
];

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

export function SavedQueriesView() {
  const router = useRouter();
  const sources = useSources();
  const ws = useWorkspace();

  const [search, setSearch] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
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
    if (!q) return ws.list;
    return ws.list.filter((s) =>
      [s.name, s.description ?? "", sourceName(s.sourceId), s.queryKind]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [ws.list, search, sourceName]);

  const selected = ws.list.find((s) => s.id === selectedId) ?? null;

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((cur) => (cur === msg ? null : cur)), 3000);
  };

  const doOpen = async (s: SavedQuerySummary) => {
    await ws.openSavedQuery(s);
    router.push(s.queryKind === "sql" ? "/sql" : "/editor");
  };
  const requestOpen = (s: SavedQuerySummary) => {
    if (ws.dirty && ws.open && ws.open.id !== s.id) setPendingOpen(s);
    else void doOpen(s);
  };

  const startTemplate = (t: Template) => {
    ws.newQuery();
    ws.setMode("sql");
    ws.setSql(t.sql);
    router.push("/sql");
  };

  const commitRename = async (id: string) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name) return;
    setBusyId(id);
    try {
      await ws.renameSaved(id, name);
    } finally {
      setBusyId(null);
    }
  };

  const handleDuplicate = async (id: string) => {
    setBusyId(id);
    try {
      const copy = await ws.duplicateSaved(id);
      if (copy) flash(`Duplicated as “${copy.name}”.`);
    } finally {
      setBusyId(null);
    }
  };

  const handleAddToDashboard = async (s: SavedQuerySummary) => {
    setBusyId(s.id);
    try {
      const count = await ws.addToDashboard(s.id);
      flash(
        count == null
          ? "Couldn't add to the dashboard."
          : `Added “${s.name}” to the dashboard.`,
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left: templates + list ────────────────────────────────────── */}
      <div className="flex h-full w-80 shrink-0 flex-col border-r border-border bg-card">
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search saved queries"
              className="h-8 pl-8"
              aria-label="Search saved queries"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {/* Templates */}
          <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Start with a template
          </div>
          <div className="space-y-1 px-2 pb-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => startTemplate(t)}
                className="flex w-full items-start gap-2.5 rounded-md border border-border p-2 text-left transition-colors hover:bg-accent"
              >
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{t.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t.description}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {/* Saved list */}
          <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Your queries{ws.list.length ? ` (${ws.list.length})` : ""}</span>
          </div>
          <div className="space-y-0.5 px-2 pb-2">
            {ws.listLoading ? (
              <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {ws.list.length === 0 ? "No saved queries yet." : `No matches for “${search}”.`}
              </p>
            ) : (
              filtered.map((s) => {
                const isSelected = s.id === selectedId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      isSelected
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    <span className="truncate">{s.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ── Right: preview ────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {notice && (
          <div className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground">
            {notice}
          </div>
        )}
        {ws.listError && (
          <div className="flex items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-xs text-destructive">
            <span>{ws.listError}</span>
            <Button variant="outline" size="xs" onClick={() => void ws.refreshList()}>
              Retry
            </Button>
          </div>
        )}

        {!selected ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-sm text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Save className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="mt-4 text-sm font-medium">Select a saved query</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Pick one on the left to preview it, or start from a template.
              </p>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-6">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                {renamingId === selected.id ? (
                  <Input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void commitRename(selected.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(selected.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="h-8 max-w-sm"
                    aria-label="Rename query"
                  />
                ) : (
                  <h1 className="truncate text-lg font-semibold">{selected.name}</h1>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Database className="h-3 w-3" />
                    {sourceName(selected.sourceId)}
                  </span>
                  <Badge variant="muted" className="uppercase">
                    {selected.queryKind}
                  </Badge>
                  <span title={new Date(selected.updatedAt).toISOString()}>
                    Updated {formatUpdated(selected.updatedAt)}
                  </span>
                </div>
                {selected.description && (
                  <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                    {selected.description}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  className="h-8"
                  disabled={ws.openingId === selected.id}
                  onClick={() => requestOpen(selected)}
                >
                  {ws.openingId === selected.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FolderOpen className="h-3.5 w-3.5" />
                  )}
                  Open
                </Button>
                <IconAction
                  label="Rename"
                  disabled={busyId === selected.id}
                  onClick={() => {
                    setRenameValue(selected.name);
                    setRenamingId(selected.id);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </IconAction>
                <IconAction
                  label="Duplicate"
                  disabled={busyId === selected.id}
                  onClick={() => void handleDuplicate(selected.id)}
                >
                  <Copy className="h-3.5 w-3.5" />
                </IconAction>
                <IconAction
                  label="Add to dashboard"
                  disabled={busyId === selected.id}
                  onClick={() => void handleAddToDashboard(selected)}
                >
                  <LayoutDashboard className="h-3.5 w-3.5" />
                </IconAction>
                <IconAction
                  label="Delete"
                  destructive
                  disabled={busyId === selected.id}
                  onClick={() => setDeleting(selected)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconAction>
              </div>
            </div>

            <QueryPreview id={selected.id} />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete saved query?"
        description={
          deleting ? <>“{deleting.name}” will be permanently removed. This can’t be undone.</> : null
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting) {
            void ws.removeSaved(deleting.id);
            if (deleting.id === selectedId) setSelectedId(null);
          }
          setDeleting(null);
        }}
      />

      <ConfirmDialog
        open={!!pendingOpen}
        onOpenChange={(o) => !o && setPendingOpen(null)}
        title="Discard unsaved changes?"
        description={
          <>“{ws.open?.name}” has unsaved edits. Opening another query will discard them.</>
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

/** Lazily fetches the full record and renders a read-only snippet. */
function QueryPreview({ id }: { id: string }) {
  const [record, setRecord] = React.useState<SavedQuery | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    void getSavedQueryStore()
      .get(id)
      .then((r) => {
        if (alive) setRecord(r);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading query…
      </div>
    );
  }
  if (!record) {
    return <p className="text-sm text-muted-foreground">Couldn't load this query.</p>;
  }

  const snippet =
    record.queryKind === "sql"
      ? (record.sql ?? "").trim() || "(empty SQL)"
      : record.queryKind === "ir"
        ? summarizeIr(record)
        : summarizeBuilder(record);

  return (
    <pre className="overflow-auto rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
      {snippet}
    </pre>
  );
}

function summarizeIr(q: SavedQuery): string {
  const m = q.ir?.aggregations?.length ?? 0;
  const d = q.ir?.dimensions?.length ?? 0;
  return `Advanced (IR) query\n${m} aggregation${m === 1 ? "" : "s"}, ${d} dimension${d === 1 ? "" : "s"}`;
}

function summarizeBuilder(q: SavedQuery): string {
  if (!q.query) return "Builder query";
  const { aggregation, group_by } = q.query;
  const metric =
    aggregation.func === "count"
      ? "COUNT(*)"
      : `${aggregation.func.toUpperCase()}(${aggregation.column})`;
  return `Builder query\n${metric} by ${group_by}`;
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
