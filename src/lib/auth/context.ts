/**
 * Bridge from an Auth.js session to the `AuthContext` every store method and API
 * route needs. `requireAuthContext()` is the single choke point: it throws a
 * typed 401/403 when there's no session or no active org, so route handlers can
 * translate those into HTTP responses uniformly.
 *
 * SERVER-ONLY.
 */

import { auth } from "@/auth";
import { UnauthorizedError, type AuthContext } from "@/lib/db/scope";

/** The current caller + active org, or throw `UnauthorizedError`. */
export async function requireAuthContext(): Promise<AuthContext> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id) {
    throw new UnauthorizedError("Not signed in.");
  }
  if (!user.orgId || !user.role) {
    throw new UnauthorizedError("No active organization for this user.");
  }
  return { userId: user.id, orgId: user.orgId, role: user.role };
}

/** Non-throwing variant for optional/soft-auth paths. */
export async function optionalAuthContext(): Promise<AuthContext | null> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.orgId || !user.role) return null;
  return { userId: user.id, orgId: user.orgId, role: user.role };
}
