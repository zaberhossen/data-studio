"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";

/** Client wrapper so `useSession()` works throughout the authed app shell. */
export function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return <SessionProvider session={session}>{children}</SessionProvider>;
}
