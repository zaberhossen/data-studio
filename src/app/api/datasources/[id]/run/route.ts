/**
 * POST /api/datasources/[id]/run — execute a pushed-down IR query.
 *
 * The browser sends a `QueryIR` (NEVER SQL). The server:
 *   1. Resolves the source (org-scoped) and requires a live SQL kind.
 *   2. RE-INTROSPECTS the schema server-side to build the column allowlist — the
 *      client is never trusted for it.
 *   3. Forces the query's table to the source's configured table (the client's
 *      `source.table` is ignored) and compiles the IR with the source dialect;
 *      a tampered IR (out-of-allowlist column) throws and 400s here.
 *   4. Runs the parameterized SQL under a hard LIMIT envelope + statement timeout
 *      via `connector.runCompiled`, and returns Arrow IPC + X-Ds-Columns — the
 *      same wire shape as the bounded /data endpoint.
 *
 * There is deliberately NO endpoint that accepts client SQL for a live DB.
 */

import { NextResponse } from "next/server";
import { tableFromJSON, tableToIPC } from "apache-arrow";
import { getStore } from "@/lib/server/datasource-store";
import { ConnectorError, connectorFor } from "@/lib/server/connectors";
import { QUERY_TIMEOUT_MS, clampLimit } from "@/lib/server/config";
import { resolveAuth } from "@/lib/auth/api";
import { mutationRateLimit } from "@/lib/server/api-helpers";
import { CompileError, compileIR, dialectFor } from "@/lib/query/compile";
import { isQuerySource, type QueryIR } from "@/lib/query/ir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await resolveAuth();
  if ("error" in auth) return auth.error;
  // Query execution can burst during interactive building — a higher ceiling.
  const limited = mutationRateLimit(auth.ctx, 600);
  if (limited) return limited;
  const { ctx } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const ir = (body as { ir?: unknown })?.ir as QueryIR | undefined;
  if (!ir || typeof ir !== "object" || (ir as QueryIR).version !== 2) {
    return NextResponse.json({ error: "Body must be { ir: QueryIR }." }, { status: 400 });
  }
  // Multi-stage (nested-query source) is a LOCAL-only capability: pushdown
  // rewrites `source` to the physical base table, which would flatten the
  // nesting. Reject rather than silently mis-compile.
  if (isQuerySource(ir.source)) {
    return NextResponse.json(
      { error: "Multi-stage queries run locally and can't be pushed down." },
      { status: 400 },
    );
  }

  const record = await getStore().get(ctx, id);
  if (!record) {
    return NextResponse.json({ error: "Source not found." }, { status: 404 });
  }
  if (record.meta.kind !== "postgres" && record.meta.kind !== "mysql") {
    return NextResponse.json(
      { error: `Pushdown is not supported for "${record.meta.kind}" sources.` },
      { status: 400 },
    );
  }

  try {
    const connector = connectorFor(record.meta.id, record.secret);
    const schema = await connector.introspectSchema();

    // The server decides the base table; the client's source.table is ignored.
    const targetTable =
      record.meta.tableName ??
      ("table" in record.secret ? record.secret.table : undefined) ??
      schema.tables?.[0];
    if (!targetTable) {
      return NextResponse.json(
        { error: "The source has no table to query." },
        { status: 400 },
      );
    }

    // A join reaches other tables in the same DB → widen the column allowlist to
    // every table's columns and pass the table allowlist so the compiler rejects
    // a join to any table not introspected here.
    const hasJoins = (ir.joins?.length ?? 0) > 0;
    const allowed =
      hasJoins && connector.columnAllowlist
        ? await connector.columnAllowlist()
        : new Set(schema.columns.map((c) => c.name));
    const allowedTables = hasJoins ? new Set(schema.tables ?? []) : undefined;

    const safeIr: QueryIR = { ...ir, source: { table: targetTable } };
    const dialect = dialectFor(record.meta.kind);
    const compiled = compileIR(safeIr, dialect, allowed, { allowedTables });

    const slice = await connector.runCompiled({
      sql: compiled.sql,
      params: compiled.params,
      limit: clampLimit(undefined),
      timeoutMs: QUERY_TIMEOUT_MS,
    });

    const normalizedRows = JSON.parse(JSON.stringify(slice.rows)) as Record<
      string,
      unknown
    >[];
    const arrowTable = tableFromJSON(
      normalizedRows.length > 0 ? normalizedRows : [{}],
    );
    const ipcBytes = tableToIPC(arrowTable, "stream");
    const columnMeta = JSON.stringify(
      slice.columns.map((c) => ({ name: c.name, type: c.type })),
    );
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
    if (err instanceof CompileError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof ConnectorError ? err.message : "Failed to run the query.";
    const status = err instanceof ConnectorError ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
