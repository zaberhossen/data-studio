"use client";

/**
 * SqlSidebar — the SQL editor's left snippet browser (Supabase SQL-editor style).
 *
 * Sections (all real):
 *   FAVORITES — starred saved queries (a client-side localStorage flag).
 *   SAVED     — the org's saved queries (the store list is org-scoped).
 *   REFERENCE — canned starter templates, including {{variable}} +
 *               [[optional clause]] examples; loading one replaces the editor.
 *
 * Opening a saved query restores it via the workspace, then routes to /sql or
 * /editor depending on the query kind (a dirty open query is confirmed first).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Loader2,
  Plus,
  Search,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/app/(app)/WorkspaceProvider";
import type { SavedQuerySummary } from "@/lib/saved-queries/store";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";

const FAVORITES_KEY = "data-studio:favorite-queries";

function readFavorites(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Starter statements; `dataset` is substituted with the live table name. */
const SQL_TEMPLATES: { name: string; sql: (table: string) => string }[] = [
  {
    name: "Filter with a variable",
    sql: (t) => `SELECT *\nFROM ${t}\nWHERE column_name = {{value}}\nLIMIT 100`,
  },
  {
    name: "Optional date range",
    sql: (t) =>
      `SELECT *\nFROM ${t}\nWHERE 1 = 1\n  [[AND date_column >= {{start_date}}]]\n  [[AND date_column < {{end_date}}]]\nLIMIT 100`,
  },
  {
    name: "Top 10 by count",
    sql: (t) =>
      `SELECT column_name, count(*) AS count\nFROM ${t}\nGROUP BY column_name\nORDER BY count DESC\nLIMIT 10`,
  },
  {
    name: "Monthly trend",
    sql: (t) =>
      `SELECT date_trunc('month', date_column) AS month, count(*) AS count\nFROM ${t}\nGROUP BY month\nORDER BY month`,
  },
];

/** A discard-confirmable action (open another query / load a template). */
interface PendingAction {
  run: () => void;
}

export function SqlSidebar() {
  const router = useRouter();
  const ws = useWorkspace();
  const { list, listLoading, openSavedQuery, openingId, newQuery, dirty, open } = ws;

  const [search, setSearch] = React.useState("");
  const [pending, setPending] = React.useState<PendingAction | null>(null);
  const [favorites, setFavorites] = React.useState<Set<string>>(readFavorites);

  const toggleFavorite = (id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      } catch {
        // Quota/private-mode failure — the star still works for this session.
      }
      return next;
    });
  };

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      [s.name, s.description ?? ""].join(" ").toLowerCase().includes(q),
    );
  }, [list, search]);
  const favoriteRows = React.useMemo(
    () => filtered.filter((s) => favorites.has(s.id)),
    [filtered, favorites],
  );

  /** Run now, or confirm first when it would discard unsaved edits. */
  const guarded = (run: () => void, skipIfCurrent?: string) => {
    if (dirty && open && open.id !== skipIfCurrent) setPending({ run });
    else run();
  };

  const doOpen = (s: SavedQuerySummary) => {
    void openSavedQuery(s).then(() => {
      router.push(s.queryKind === "sql" ? "/sql" : "/editor");
    });
  };

  const loadTemplate = (tpl: (typeof SQL_TEMPLATES)[number]) => {
    newQuery();
    ws.setMode("sql");
    ws.setSql(tpl.sql(ws.tableName));
    router.push("/sql");
  };

  const startNew = () => {
    newQuery();
    router.push("/sql");
  };

  const queryRow = (s: SavedQuerySummary) => {
    const isOpening = openingId === s.id;
    const isCurrent = open?.id === s.id;
    const isFavorite = favorites.has(s.id);
    return (
      <div
        key={s.id}
        className={cn(
          "group flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors",
          isCurrent
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <button
          type="button"
          onClick={() => guarded(() => doOpen(s), s.id)}
          title={s.name}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {isOpening ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-60" />
          )}
          <span className="truncate">{s.name}</span>
        </button>
        <button
          type="button"
          onClick={() => toggleFavorite(s.id)}
          aria-label={isFavorite ? `Unfavorite ${s.name}` : `Favorite ${s.name}`}
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          className={cn(
            "shrink-0 rounded p-0.5 transition-opacity hover:text-foreground",
            isFavorite
              ? "text-warning opacity-100"
              : "opacity-0 group-hover:opacity-100",
          )}
        >
          <Star className={cn("h-3.5 w-3.5", isFavorite && "fill-current")} />
        </button>
      </div>
    );
  };

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="text-sm font-semibold">SQL Editor</span>
      </div>

      {/* Search + new */}
      <div className="flex items-center gap-1.5 border-b border-border p-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search queries…"
            className="h-8 pl-8"
            aria-label="Search saved queries"
          />
        </div>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={startNew} title="New query">
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        <Section label={`Favorites${favoriteRows.length ? ` (${favoriteRows.length})` : ""}`} defaultOpen>
          {favoriteRows.length === 0 ? (
            <RowMuted>{search ? "No matches" : "Star a query to pin it here."}</RowMuted>
          ) : (
            favoriteRows.map(queryRow)
          )}
        </Section>

        <Section label={`Saved${list.length ? ` (${list.length})` : ""}`} defaultOpen>
          {listLoading ? (
            <RowMuted>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </RowMuted>
          ) : filtered.length === 0 ? (
            <RowMuted>{search ? "No matches" : "No saved queries"}</RowMuted>
          ) : (
            filtered.map(queryRow)
          )}
        </Section>

        <Section label="Reference" defaultOpen>
          {SQL_TEMPLATES.map((tpl) => (
            <button
              key={tpl.name}
              type="button"
              onClick={() => guarded(() => loadTemplate(tpl))}
              title="Load this template into the editor"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 opacity-60" />
              <span className="truncate">{tpl.name}</span>
            </button>
          ))}
        </Section>
      </div>

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title="Discard unsaved changes?"
        description={
          <>
            “{open?.name}” has unsaved edits. Continuing will discard them.
          </>
        }
        confirmLabel="Discard & continue"
        onConfirm={() => {
          const action = pending;
          setPending(null);
          action?.run();
        }}
      />
    </div>
  );
}

function Section({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {open && children}
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
