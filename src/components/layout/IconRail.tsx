"use client";

/**
 * IconRail — the primary navigation rail (Supabase-style): a thin, always-visible
 * icon-only strip on the far left. Brand mark on top, section icons in the
 * middle, theme toggle + settings pinned to the bottom.
 *
 * Selection stays local (no router); the active section is purely visual and
 * drives which surface the shell renders. Each item carries a tooltip label via
 * the native `title` attribute.
 *
 * shadcn primitives / tokens: composes ThemeToggle; buttons styled with tokens.
 */

import * as React from "react";
import {
  BarChart3,
  Database,
  History,
  LayoutDashboard,
  ListFilter,
  Save,
  Settings,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./ThemeToggle";

export type PanelKey =
  | "sources"
  | "fields"
  | "query"
  | "results"
  | "saved"
  | "dashboards";

interface NavItem {
  key: PanelKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV: NavItem[] = [
  { key: "query", label: "SQL Editor", icon: Terminal },
  { key: "sources", label: "Data sources", icon: Database },
  { key: "fields", label: "Fields", icon: ListFilter },
  { key: "saved", label: "Saved queries", icon: Save },
  { key: "results", label: "History", icon: History },
  { key: "dashboards", label: "Dashboards", icon: LayoutDashboard },
];

interface IconRailProps {
  active: PanelKey;
  onSelect: (key: PanelKey) => void;
}

export function IconRail({ active, onSelect }: IconRailProps) {
  return (
    <nav
      aria-label="Primary navigation"
      className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2"
    >
      {/* Brand mark */}
      <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-md bg-brand text-brand-foreground">
        <BarChart3 className="h-5 w-5" />
      </div>

      <ul className="flex flex-1 flex-col items-center gap-1">
        {NAV.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.key;
          return (
            <li key={item.key} className="relative">
              {isActive && (
                <span
                  aria-hidden
                  className="absolute left-[-8px] top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-brand"
                />
              )}
              <button
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => onSelect(item.key)}
                title={item.label}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
                  isActive
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
                <span className="sr-only">{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col items-center gap-1">
        <ThemeToggle />
        <button
          type="button"
          title="Settings"
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Settings className="h-[18px] w-[18px]" />
          <span className="sr-only">Settings</span>
        </button>
      </div>
    </nav>
  );
}
