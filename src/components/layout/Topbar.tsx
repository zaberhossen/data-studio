"use client";

/**
 * Topbar — slim global header: breadcrumb/title on the left; engine status,
 * panel actions, and the ⌘K command trigger on the right.
 *
 * The primary nav lives in the always-visible IconRail, so the Topbar no longer
 * owns a sidebar-collapse toggle or the theme switch.
 *
 * shadcn primitives: Button (ghost/icon), Badge (engine status pill).
 * States handled: engine booting / ready / error (via `engineStatus`).
 */

import * as React from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type EngineStatus = "booting" | "ready" | "error";

interface TopbarProps {
  title: string;
  subtitle?: string;
  engineStatus?: EngineStatus;
  /** Panel-specific actions rendered on the right, before the command trigger. */
  actions?: React.ReactNode;
  /** Opens the ⌘K command menu. */
  onOpenCommand?: () => void;
}

const STATUS_META: Record<
  EngineStatus,
  { label: string; dot: string; variant: "secondary" | "muted" }
> = {
  booting: { label: "Engine booting…", dot: "bg-amber-500", variant: "muted" },
  ready: { label: "Engine ready", dot: "bg-emerald-500", variant: "secondary" },
  error: { label: "Engine error", dot: "bg-destructive", variant: "muted" },
};

export function Topbar({
  title,
  subtitle,
  engineStatus,
  actions,
  onOpenCommand,
}: TopbarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="truncate text-sm font-semibold leading-tight">{title}</h1>
        {subtitle && (
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {engineStatus && (
          <Badge
            variant={STATUS_META[engineStatus].variant}
            className="hidden sm:inline-flex"
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                STATUS_META[engineStatus].dot,
              )}
            />
            {STATUS_META[engineStatus].label}
          </Badge>
        )}
        {actions}
        {onOpenCommand && (
          <button
            type="button"
            onClick={onOpenCommand}
            className="hidden items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:flex"
            title="Command menu"
          >
            <Search className="h-3.5 w-3.5" />
            <span>Search…</span>
            <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
              ⌘K
            </kbd>
          </button>
        )}
      </div>
    </header>
  );
}
