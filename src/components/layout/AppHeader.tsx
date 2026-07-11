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
  LogOut,
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
          className="hidden items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:flex"
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

/** Org/workspace switcher — functional: switches the active org via the session. */
function OrgSwitcher() {
  const { data, update } = useSession();
  const router = useRouter();
  const [orgs, setOrgs] = React.useState<OrgSummary[]>([]);
  const [switching, setSwitching] = React.useState(false);
  const activeOrgId = data?.user?.orgId ?? null;

  React.useEffect(() => {
    let alive = true;
    void fetch("/api/orgs")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: OrgSummary[]) => {
        if (alive) setOrgs(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeOrgId]);

  const active = orgs.find((o) => o.active) ?? orgs.find((o) => o.id === activeOrgId) ?? null;
  const label = active?.name ?? "Workspace";

  const switchOrg = async (id: string) => {
    if (id === activeOrgId) return;
    setSwitching(true);
    try {
      await update({ orgId: id });
      router.refresh();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <DropdownMenu>
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
      <DropdownMenuContent align="start" className="min-w-[15rem]">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {orgs.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No workspaces</div>
        ) : (
          orgs.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => void switchOrg(o.id)}>
              <span className="flex h-5 w-5 items-center justify-center rounded bg-secondary text-[10px] font-semibold uppercase">
                {o.name.slice(0, 1)}
              </span>
              <span className="flex-1 truncate">{o.name}</span>
              {o.active && <Check className="h-3.5 w-3.5 text-primary" />}
            </DropdownMenuItem>
          ))
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
      className="ml-1 hidden items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground lg:flex"
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
