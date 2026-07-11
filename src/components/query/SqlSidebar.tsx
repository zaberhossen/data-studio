"use client";

/**
 * SqlSidebar — the SQL editor's left snippet browser (Supabase SQL-editor style).
 *
 * Sections: SHARED (team queries — empty state for now), FAVORITES, PRIVATE (the
 * user's saved queries), and REFERENCE (Templates / Examples). A search box + a
 * "New query" button sit on top; "View running queries" is pinned to the bottom.
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/app/(app)/WorkspaceProvider";
import type { SavedQuerySummary } from "@/lib/saved-queries/store";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";

export function SqlSidebar() {
  const router = useRouter();
  const { list, listLoading, openSavedQuery, openingId, newQuery, dirty, open } =
    useWorkspace();

  const [search, setSearch] = React.useState("");
  const [pendingOpen, setPendingOpen] = React.useState<SavedQuerySummary | null>(null);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      [s.name, s.description ?? ""].join(" ").toLowerCase().includes(q),
    );
  }, [list, search]);

  const doOpen = async (s: SavedQuerySummary) => {
    await openSavedQuery(s);
    router.push(s.queryKind === "sql" ? "/sql" : "/editor");
  };
  const requestOpen = (s: SavedQuerySummary) => {
    if (dirty && open && open.id !== s.id) setPendingOpen(s);
    else void doOpen(s);
  };

  const startNew = () => {
    newQuery();
    router.push("/sql");
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
        <Section label="Shared" defaultOpen>
          <div className="mx-3 my-1 rounded-md border border-dashed border-border p-3 text-center">
            <p className="text-xs font-medium">No shared queries</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Share queries with your team by right-clicking on the query.
            </p>
          </div>
        </Section>

        <Section label="Favorites" />

        <Section label={`Private${list.length ? ` (${list.length})` : ""}`} defaultOpen>
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
                    <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  )}
                  <span className="truncate">{s.name}</span>
                </button>
              );
            })
          )}
        </Section>

        <Section label="Reference" defaultOpen>
          <RefRow icon={FileText} label="Templates" />
          <RefRow icon={FileText} label="Examples" />
        </Section>
      </div>

      <div className="border-t border-border p-2">
        <Button variant="outline" size="sm" className="w-full justify-center">
          View running queries
        </Button>
      </div>

      <ConfirmDialog
        open={!!pendingOpen}
        onOpenChange={(o) => !o && setPendingOpen(null)}
        title="Discard unsaved changes?"
        description={
          <>
            “{open?.name}” has unsaved edits. Opening another query will discard them.
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

function RefRow({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" />
      {label}
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
