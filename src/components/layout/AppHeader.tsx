"use client";

/**
 * AppHeader — the global top bar (Supabase Studio style), persistent in the
 * (app) layout so it never unmounts across route changes.
 *
 * Left cluster:  brand → org/workspace switcher (+ plan badge) → datasource
 *                switcher → connection indicator (engine status).
 * Right cluster: Feedback → Search (⌘K) → Help → Notifications → user menu.
 *
 * Data: the org switcher reads `/api/orgs` and switches via
 * `useSession().update({ orgId })` (validated by the JWT callback in auth.ts).
 * The datasource switcher reuses the hoisted `useSources()` context.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  BarChart3,
  Bell,
  Check,
  ChevronsUpDown,
  Database,
  FileSpreadsheet,
  Globe,
  HelpCircle,
  Loader2,
  LogOut,
  Plus,
  Search,
  Slash,
  Sparkles,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { DataSourceKind } from "@/lib/types/datasource";
import { useSources, useEngineStatus, type EngineStatus } from "@/app/(app)/WorkspaceProvider";

const KIND_ICON: Record<DataSourceKind, React.ComponentType<{ className?: string }>> = {
  file: FileSpreadsheet,
  postgres: Database,
  mysql: Database,
  "http-file": Globe,
  "rest-api": Globe,
};

const STATUS_META: Record<EngineStatus, { label: string; dot: string }> = {
  booting: { label: "Connecting", dot: "bg-amber-500" },
  ready: { label: "Connected", dot: "bg-emerald-500" },
  error: { label: "Engine error", dot: "bg-destructive" },
};

interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  active: boolean;
}

export function AppHeader({ onOpenCommand }: { onOpenCommand?: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-3">
      {/* Brand */}
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand text-brand-foreground">
        <BarChart3 className="h-4 w-4" />
      </div>

      <OrgSwitcher />
      <Divider />
      <DatasourceSwitcher />
      <ConnectionIndicator />

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onOpenCommand}
          className="hidden items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:flex"
          title="Command menu"
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search…</span>
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
            ⌘K
          </kbd>
        </button>
        <HeaderIcon label="Help">
          <HelpCircle className="h-4 w-4" />
        </HeaderIcon>
        <HeaderIcon label="Notifications">
          <Bell className="h-4 w-4" />
        </HeaderIcon>
        <UserMenu />
      </div>
    </header>
  );
}

function Divider() {
  return <Slash className="h-4 w-4 shrink-0 -rotate-12 text-border" aria-hidden />;
}

function HeaderIcon({
  label,
  children,
  ...props
}: { label: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      {...props}
    >
      {children}
    </button>
  );
}

function TriggerButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm transition-colors hover:bg-accent"
    >
      {children}
      <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * Org/workspace switcher — functional: lists the caller's workspaces with a
 * live search filter, switches the active org via the session, and creates a
 * brand-new workspace inline (POST /api/orgs → switch to it).
 */
function OrgSwitcher() {
  const { data, update } = useSession();
  const router = useRouter();
  const [orgs, setOrgs] = React.useState<OrgSummary[]>([]);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [switching, setSwitching] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const activeOrgId = data?.user?.orgId ?? null;

  const loadOrgs = React.useCallback(async (): Promise<OrgSummary[]> => {
    const rows: OrgSummary[] = await fetch("/api/orgs")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    setOrgs(rows);
    return rows;
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load on mount/org switch; not derivable during render
    void loadOrgs();
  }, [loadOrgs, activeOrgId]);

  // Reset the transient UI whenever the menu closes.
  React.useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset transient menu state on close; keying by `open` would remount Radix's portal
      setQuery("");
      setCreating(false);
      setNewName("");
    }
  }, [open]);

  // Pull focus into the search box on open (Radix's focus scope grabs the first
  // menu item first; reclaim it on the next frame so typing filters).
  React.useEffect(() => {
    if (!open || creating) return;
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, creating]);

  const active = orgs.find((o) => o.active) ?? orgs.find((o) => o.id === activeOrgId) ?? null;
  const label = active?.name ?? "Workspace";

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? orgs.filter((o) => o.name.toLowerCase().includes(q)) : orgs;
  }, [orgs, query]);

  const switchOrg = async (id: string) => {
    setOpen(false);
    if (id === activeOrgId) return;
    setSwitching(true);
    try {
      await update({ orgId: id });
      router.refresh();
    } finally {
      setSwitching(false);
    }
  };

  const createOrg = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return;
      const created = (await res.json()) as OrgSummary;
      await loadOrgs();
      await switchOrg(created.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={switching}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm transition-colors hover:bg-accent disabled:opacity-60"
        >
          <span className="max-w-[160px] truncate font-medium">{label}</span>
          <Badge variant="plan">Free</Badge>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[16rem] p-0">
        {creating ? (
          <div className="p-2">
            <DropdownMenuLabel className="px-1 pb-1.5">New workspace</DropdownMenuLabel>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") void createOrg();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="Workspace name"
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="h-7 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void createOrg()}
                disabled={!newName.trim() || busy}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-brand-500/75 bg-brand-400 px-2.5 text-xs text-foreground transition-colors hover:bg-brand/80 hover:border-brand-600 disabled:opacity-50 dark:border-brand/30 dark:bg-brand-500 dark:hover:bg-brand/50"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Create
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Find workspace…"
                className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {orgs.length === 0 ? "No workspaces" : "No matches"}
                </div>
              ) : (
                filtered.map((o) => (
                  <DropdownMenuItem key={o.id} onSelect={() => void switchOrg(o.id)}>
                    <span className="flex h-5 w-5 items-center justify-center rounded bg-secondary text-[10px] font-semibold uppercase">
                      {o.name.slice(0, 1)}
                    </span>
                    <span className="flex-1 truncate">{o.name}</span>
                    {o.active && <Check className="h-3.5 w-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))
              )}
            </div>
            <DropdownMenuSeparator className="mx-0 my-0" />
            <div className="p-1">
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setCreating(true);
                }}
              >
                <Plus className="text-muted-foreground" />
                <span className="flex-1">New workspace</span>
              </DropdownMenuItem>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Datasource switcher — the header-level active-source picker. */
function DatasourceSwitcher() {
  const { sources, activeSource, activate } = useSources();
  const Icon = activeSource
    ? activeSource.builtin
      ? Sparkles
      : KIND_ICON[activeSource.kind]
    : Database;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TriggerButton>
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="max-w-[160px] truncate">
            {activeSource?.name ?? "Select source"}
          </span>
        </TriggerButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[15rem]">
        <DropdownMenuLabel>Data sources</DropdownMenuLabel>
        {sources.map((s) => {
          const RowIcon = s.builtin ? Sparkles : KIND_ICON[s.kind];
          const isActive = s.id === activeSource?.id;
          return (
            <DropdownMenuItem key={s.id} onSelect={() => void activate(s.id)}>
              <RowIcon className="text-muted-foreground" />
              <span className="flex-1 truncate">{s.name}</span>
              {isActive && <Check className="h-3.5 w-3.5 text-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConnectionIndicator() {
  const status = useEngineStatus();
  const meta = STATUS_META[status];
  return (
    <span
      className="ml-1 hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground lg:flex"
      title={meta.label}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}

function UserMenu() {
  const { data } = useSession();
  const email = data?.user?.email ?? null;
  const initial = (email ?? "?").slice(0, 1).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ml-1 rounded-full outline-none ring-offset-background focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Account menu"
        >
          <Avatar fallback={initial} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-xs text-muted-foreground">Signed in as</span>
          <span className="block truncate text-sm text-foreground">{email ?? "—"}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut({ callbackUrl: "/login" })}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
