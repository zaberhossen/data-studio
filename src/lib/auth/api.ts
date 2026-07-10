/**
 * Auth resolution for API route handlers. Returns either the `AuthContext` or a
 * ready-to-return JSON error response (401/403) — so handlers stay flat:
 *
 *   const auth = await resolveAuth();
 *   if ("error" in auth) return auth.error;
 *   const { ctx } = auth;
 *
 * Middleware gates PAGES; API routes self-authenticate here so an unauthenticated
 * fetch gets a clean JSON 401 instead of an HTML login redirect.
 *
 * SERVER-ONLY.
 */

import { NextResponse } from "next/server";
import { requireAuthContext } from "@/lib/auth/context";
import { ForbiddenError, type AuthContext } from "@/lib/db/scope";

export async function resolveAuth(): Promise<
  { ctx: AuthContext } | { error: NextResponse }
> {
  try {
    const ctx = await requireAuthContext();
    return { ctx };
  } catch (err) {
    const status = err instanceof ForbiddenError ? 403 : 401;
    const message = err instanceof Error ? err.message : "Unauthorized";
    return { error: NextResponse.json({ error: message }, { status }) };
  }
}
