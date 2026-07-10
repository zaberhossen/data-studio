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

/** Map a thrown error to a JSON response (403 for permission, else 500). */
export function errorResponse(err: unknown): NextResponse {
  const status = (err as { status?: number })?.status === 403 ? 403 : 500;
  const message = err instanceof Error ? err.message : "Request failed.";
  return NextResponse.json({ error: message }, { status });
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
