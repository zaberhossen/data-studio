/**
 * Authed app shell layout. Middleware already gates these routes, but we resolve
 * the session here too so it seeds the client `SessionProvider` (no auth flash)
 * and so server components under `(app)` can rely on a user being present.
 */

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Providers } from "./providers";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  return <Providers session={session}>{children}</Providers>;
}
