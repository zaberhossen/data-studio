/**
 * Shared helpers for the CRUD API routes (saved queries, dashboards, …).
 *
 * Kept OUT of the route files themselves because Next.js only permits specific
 * exports (`GET`/`POST`/`runtime`/…) from a `route.ts` — any other export fails
 * the build.
 *
 * SERVER-ONLY.
 */

import { NextResponse } from "next/server";
import type { QueryDefinition } from "@/lib/types/query";
import type { AuthContext } from "@/lib/db/scope";
import { rateLimit } from "@/lib/server/rate-limit";

/**
 * Map a thrown error to a JSON response. An error carrying a 4xx `.status`
 * (ForbiddenError → 403, ConflictError → 409, …) passes through; anything else
 * is an unexpected 500.
 */
export function errorResponse(err: unknown): NextResponse {
  const s = (err as { status?: number })?.status;
  const status = typeof s === "number" && s >= 400 && s < 500 ? s : 500;
  const message = err instanceof Error ? err.message : "Request failed.";
  return NextResponse.json({ error: message }, { status });
}

/**
 * Per-user abuse backstop for authenticated MUTATION routes (create/update/
 * delete, query execution). The ceiling is deliberately generous — legit heavy
 * editing (debounced dashboard saves, interactive builder runs) must never trip
 * it; it only bounds runaway/abusive callers. Like `rateLimit`, state is
 * per-process (a first line of defense, not a global quota — see rate-limit.ts).
 *
 * Returns a 429 `NextResponse` when the caller is over the limit, else `null`.
 * `now` is injectable for tests.
 */
export function mutationRateLimit(
  ctx: AuthContext,
  max = 240,
  now: number = Date.now(),
): NextResponse | null {
  if (!rateLimit(`mut:${ctx.userId}`, now, max)) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429 },
    );
  }
  return null;
}

/** Minimal shape check — a definition must at least name a source + kind + viz. */
export function validateDefinition(v: unknown): QueryDefinition | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  if (typeof d.sourceId !== "string") return null;
  if (d.queryKind !== "builder" && d.queryKind !== "ir" && d.queryKind !== "sql") return null;
  if (!d.viz || typeof d.viz !== "object") return null;
  return v as QueryDefinition;
}
