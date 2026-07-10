/**
 * GET /api/datasources/[id]/data?table=&limit=&offset=
 *
 * The bounded slice endpoint — the ONLY way remote rows reach the browser.
 * Hard rules enforced here:
 *   • `table` is validated against the introspected allowlist (in the
 *     connector); a forged value is rejected, never interpolated.
 *   • `limit` is clamped to the server row cap; `offset` to a non-negative int.
 *   • A per-request timeout bounds the query. There is no unbounded path.
 *
 * Returns Arrow IPC stream bytes (Content-Type: application/vnd.apache.arrow.stream).
 * Column name/type metadata from the connector is encoded in X-Ds-Columns so
 * the worker can derive SourceSchema types without re-inferring from values.
 * Error responses remain JSON with a 4xx/5xx status code.
 *
 * The worker fetches this directly so raw rows never pass through React state.
 */

import { NextResponse } from "next/server";
import { tableFromJSON, tableToIPC } from "apache-arrow";
import { getStore } from "@/lib/server/datasource-store";
import { ConnectorError, connectorFor } from "@/lib/server/connectors";
import { QUERY_TIMEOUT_MS, clampLimit, clampOffset } from "@/lib/server/config";
import { resolveAuth } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  const { ctx } = auth;

  const record = await getStore().get(ctx, id);
  if (!record) {
    return NextResponse.json({ error: "Source not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  // Default to the source's configured table when the client omits one.
  const storedTable =
    "table" in record.secret ? record.secret.table : undefined;
  const table = url.searchParams.get("table") ?? storedTable;
  if (!table) {
    return NextResponse.json(
      { error: "No table specified and the source has no default table." },
      { status: 400 },
    );
  }

  const limit = clampLimit(numParam(url, "limit"));
  const offset = clampOffset(numParam(url, "offset"));

  try {
    const connector = connectorFor(record.meta.id, record.secret);
    const slice = await connector.fetchRows({
      table,
      limit,
      offset,
      timeoutMs: QUERY_TIMEOUT_MS,
    });

    // Reflect the latest known state in the store (metadata only).
    await getStore().update(ctx, record.meta.id, {
      status: "ready",
      tableName: table,
      rowCount: slice.rowCount,
      error: undefined,
    });

    // Normalize rows through JSON round-trip so Date objects become ISO strings
    // and BigInt values are handled — same as what NextResponse.json would do.
    const normalizedRows = JSON.parse(
      JSON.stringify(slice.rows),
    ) as Record<string, unknown>[];

    const arrowTable = tableFromJSON(normalizedRows);
    const ipcBytes = tableToIPC(arrowTable, "stream");

    // Encode authoritative column metadata in a header so the worker can derive
    // SourceSchema types without re-inferring from Arrow physical types (which
    // may not preserve the distinction between, e.g., date and string columns).
    const columnMeta = JSON.stringify(
      slice.columns.map((c) => ({ name: c.name, type: c.type })),
    );

    // Extract a clean ArrayBuffer from the Uint8Array view for Response body.
    const bodyBuf = ipcBytes.buffer.slice(
      ipcBytes.byteOffset,
      ipcBytes.byteOffset + ipcBytes.byteLength,
    ) as ArrayBuffer;

    return new Response(bodyBuf, {
      headers: {
        "Content-Type": "application/vnd.apache.arrow.stream",
        "X-Ds-Columns": columnMeta,
        "X-Ds-Capped": slice.capped ? "1" : "0",
      },
    });
  } catch (err) {
    const message =
      err instanceof ConnectorError ? err.message : "Failed to read rows.";
    const status = err instanceof ConnectorError ? 400 : 502;
    await getStore().update(ctx, record.meta.id, { status: "error", error: message });
    return NextResponse.json({ error: message }, { status });
  }
}

function numParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
