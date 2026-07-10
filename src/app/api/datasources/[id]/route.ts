/**
 * /api/datasources/[id]
 *   PATCH  → rotate the connection secret (re-seal new credentials) → meta | 404
 *   DELETE → remove the source (+ its credentials) and dispose the pool.
 */

import { NextResponse } from "next/server";
import { getStore } from "@/lib/server/datasource-store";
import { disposeConnector } from "@/lib/server/connectors";
import { resolveAuth } from "@/lib/auth/api";
import { assertCanWrite } from "@/lib/db/scope";
import type { CreateDataSourceInput } from "@/lib/types/datasource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  try {
    assertCanWrite(auth.ctx);
  } catch {
    return NextResponse.json(
      { error: "You don't have permission to edit data sources." },
      { status: 403 },
    );
  }

  let input: CreateDataSourceInput;
  try {
    input = (await request.json()) as CreateDataSourceInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!input || typeof input.kind !== "string") {
    return NextResponse.json({ error: "A server source payload is required." }, { status: 400 });
  }

  const meta = await getStore().rotateSecret(auth.ctx, id, input);
  if (!meta) return NextResponse.json({ error: "Source not found." }, { status: 404 });
  // Drop the cached connector so the next request builds one with the new creds.
  await disposeConnector(id);
  return NextResponse.json(meta);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;

  try {
    assertCanWrite(auth.ctx);
  } catch {
    return NextResponse.json(
      { error: "You don't have permission to remove data sources." },
      { status: 403 },
    );
  }

  const removed = await getStore().remove(auth.ctx, id);
  if (!removed) {
    return NextResponse.json({ error: "Source not found." }, { status: 404 });
  }
  await disposeConnector(id);
  return new NextResponse(null, { status: 204 });
}
