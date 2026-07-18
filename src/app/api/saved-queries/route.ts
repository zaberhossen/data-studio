/**
 * /api/saved-queries — collection endpoint (org-scoped).
 *
 *   GET  → SavedQuerySummary[]  (cheap list, most-recent first)
 *   POST → create from { name, description?, definition } → SavedQuery (201)
 *
 * Self-authenticates via `resolveAuth` (JSON 401/403, never an HTML redirect);
 * writes require an editor+ role.
 */

import { NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth/api";
import { getSavedQueryDbStore } from "@/lib/server/saved-query-store";
import { errorResponse, mutationRateLimit, validateDefinition } from "@/lib/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const list = await getSavedQueryDbStore().list(auth.ctx);
  return NextResponse.json(list);
}

export async function POST(request: Request) {
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const limited = mutationRateLimit(auth.ctx);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const b = body as { name?: unknown; description?: unknown; definition?: unknown };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return NextResponse.json({ error: "A query name is required." }, { status: 400 });
  const def = validateDefinition(b.definition);
  if (!def) return NextResponse.json({ error: "A valid query definition is required." }, { status: 400 });

  try {
    const saved = await getSavedQueryDbStore().create(
      auth.ctx,
      def,
      name,
      typeof b.description === "string" ? b.description : undefined,
    );
    return NextResponse.json(saved, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
