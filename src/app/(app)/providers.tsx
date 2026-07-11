"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { WorkspaceProvider } from "./WorkspaceProvider";
import { AppShell } from "@/components/layout/AppShell";

/**
 * Client shell for the authed app: SessionProvider (so `useSession()` works),
 * then WorkspaceProvider (boots the engine + workers ONCE, above the router
 * outlet, so they survive navigation), then the persistent AppShell chrome
 * wrapping the routed page.
 */
export function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return (
    <SessionProvider session={session}>
      <WorkspaceProvider>
        <AppShell>{children}</AppShell>
      </WorkspaceProvider>
    </SessionProvider>
  );
}
