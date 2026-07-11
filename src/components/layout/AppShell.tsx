"use client";

/**
 * AppShell — the persistent workspace frame, mounted once in the (app) layout so
 * it survives route navigation: a fixed-height viewport split into the always-
 * visible IconRail (primary nav) and a right column of AppHeader + the routed
 * page. Only the page area scrolls; each routed page manages its own internal
 * scroll/split so the rail and header stay pinned.
 *
 * Owns the ⌘K command-menu open state (the menu is global chrome).
 */

import * as React from "react";
import { IconRail } from "./IconRail";
import { AppHeader } from "./AppHeader";
import { CommandMenu } from "@/components/CommandMenu";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [commandOpen, setCommandOpen] = React.useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <IconRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader onOpenCommand={() => setCommandOpen(true)} />
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
      </div>
      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}
