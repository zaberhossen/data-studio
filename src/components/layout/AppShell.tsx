"use client";

/**
 * AppShell — the workspace frame: a fixed-height viewport split into an always-
 * visible IconRail (primary nav) and a right column of Topbar + scrollable main
 * canvas. The shell owns the active section; per-section chrome (contextual
 * sidebars, splits) is composed by the page inside `children`.
 *
 * Layout: `h-screen` flex row → IconRail (fixed) + flex column (Topbar + main).
 * Only the main canvas scrolls, so the rail and header stay pinned.
 *
 * shadcn primitives: composes IconRail/Topbar (Button, Badge, ThemeToggle).
 */

import * as React from "react";
import { IconRail, type PanelKey } from "./IconRail";
import { Topbar, type EngineStatus } from "./Topbar";

interface AppShellProps {
  active: PanelKey;
  onSelect: (key: PanelKey) => void;
  title: string;
  subtitle?: string;
  engineStatus?: EngineStatus;
  /** Panel-specific header actions (e.g. a Run button). */
  actions?: React.ReactNode;
  /** Opens the ⌘K command menu. */
  onOpenCommand?: () => void;
  children: React.ReactNode;
}

export function AppShell({
  active,
  onSelect,
  title,
  subtitle,
  engineStatus,
  actions,
  onOpenCommand,
  children,
}: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <IconRail active={active} onSelect={onSelect} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          title={title}
          subtitle={subtitle}
          engineStatus={engineStatus}
          actions={actions}
          onOpenCommand={onOpenCommand}
        />
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
