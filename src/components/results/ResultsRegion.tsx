"use client";

/**
 * ResultsRegion — the SMART container that turns the "active query" into a
 * normalized `ResultTable` and renders it as a Chart | Table.
 *
 * It owns page / page-size / sort state and is the single place that re-queries:
 *   • SQL path     → re-run `runSql` with new { limit, offset }; sort wraps the
 *                    statement in `SELECT * FROM (…) ORDER BY …` (worker-side).
 *   • Builder path → `ChartPayload` is tiny, so paging re-slices it client-side
 *                    (no re-query); sort re-runs `runQuery` with an updated sort.
 *
 * The presentational `ResultsTable` never sees the engine or the raw rows — it
 * gets one `ResultTable` page + callbacks. CSV export pulls the FULL result
 * (worker-serialized for SQL; serialized in-hand for the builder).
 */

import * as React from "react";
import { BarChart3, Table2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AnalyticsEngine } from "@/hooks/useAnalyticsEngine";
import type { Query } from "@/lib/types/analytics";
import type { QueryIR } from "@/lib/query/ir";
import type { SqlError } from "@/lib/types/sql";
import {
  chartPayloadToResultTable,
  pageResultTable,
  sqlResultToResultTable,
  type ResultTable,
  type SortSpec,
} from "@/lib/types/results";
import { downloadCsv, tableToCsv } from "@/lib/results/csv";
import type { WidgetViz } from "@/lib/types/query";
import { ResultsTable, type ResultsStatus } from "./ResultsTable";
import { VizChart } from "./VizChart";

/** The active query to materialize — builder Query, raw SQL, or a pushdown IR. */
export type ResultRequest =
  | { kind: "builder"; query: Query }
  | { kind: "sql"; sql: string }
  | {
      // PUSHDOWN: the IR runs on the live DB server-side; the small aggregated
      // result is ingested (once) into the worker under `datasetId`, then paged
      // through the ordinary SQL path against that dataset's table.
      kind: "pushdown";
      sourceId: string;
      ir: QueryIR;
      datasetId: string;
    };

const DEFAULT_PAGE_SIZE = 50;

interface ResultsRegionProps {
  engine: AnalyticsEngine;
  /** The query to show; null before the user runs anything. */
  request: ResultRequest | null;
  /**
   * Which view to show first — derived from a saved query's viz on open.
   * Applied on mount and re-applied whenever it changes (e.g. opening another
   * saved query), while still letting the user switch tabs manually afterward.
   */
  defaultView?: "table" | "chart";
  /**
   * The active query's viz config — supplies xKey/yKey when charting a SQL/IR
   * result table. Optional; sensible column defaults apply when omitted.
   */
  viz?: WidgetViz;
  /**
   * Fires once per NEW `request` (not on pagination/sort-only re-queries) once
   * it settles — lets a caller log run stats (e.g. the query-history panel)
   * without this component knowing anything about history.
   */
  onResult?: (info: {
    status: "data" | "empty" | "error";
    rowCount?: number;
    elapsedMs?: number;
    error?: string;
  }) => void;
}

export function ResultsRegion({ engine, request, defaultView, viz, onResult }: ResultsRegionProps) {
  // Destructure the STABLE (useCallback) methods. Depending on the whole
  // `engine` object would re-fire the effect whenever `loading` toggles — an
  // infinite query loop. These references never change across renders.
  const { runQuery, runSql, runSqlOn, runPushdown, exportSqlCsv, exportSqlCsvOn, tableNameForId } =
    engine;

  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE);
  const [sort, setSort] = React.useState<SortSpec | null>(null);

  // Controlled table/chart tab so a saved query's viz selects the initial view;
  // re-applied when `defaultView` changes, but the user can still switch tabs.
  const [view, setView] = React.useState<"table" | "chart">(defaultView ?? "table");
  const prevDefaultView = React.useRef(defaultView);
  // eslint-disable-next-line react-hooks/refs -- prev-prop tracker for the documented set-state-during-render pattern; ref intentionally read during render
  if (defaultView !== prevDefaultView.current) {
    // eslint-disable-next-line react-hooks/refs -- resetting the prev-prop tracker as part of the same render-time comparison
    prevDefaultView.current = defaultView;
    if (defaultView) setView(defaultView);
  }

  const [status, setStatus] = React.useState<ResultsStatus>("loading");
  const [table, setTable] = React.useState<ResultTable | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);

  // The full builder result (all points), kept for client-side paging + CSV.
  const builderFull = React.useRef<ResultTable | null>(null);
  // The SQL actually executed (incl. any ORDER BY wrap) — used for CSV export.
  const effectiveSql = React.useRef<string | null>(null);
  const builderKey = React.useRef<string>("");

  // Reset view state when a NEW request arrives (set-state-during-render: React
  // restarts the render before commit, so the execute effect runs only once).
  const prevRequest = React.useRef<ResultRequest | null>(request);
  // True only for the execution of a just-arrived request — NOT for a
  // page/sort-only re-query of the same request. Lets `onResult` fire once per
  // actual "run" (for history logging) without this component knowing why.
  const freshRequestRef = React.useRef(true);
  /* eslint-disable react-hooks/refs -- prev-request tracker for the documented set-state-during-render pattern; refs intentionally read and reset during render */
  if (request !== prevRequest.current) {
    prevRequest.current = request;
    freshRequestRef.current = true;
    setPage(0);
    setSort(null);
    builderFull.current = null;
    builderKey.current = "";
  }
  /* eslint-enable react-hooks/refs */

  React.useEffect(() => {
    if (!request) return;
    let cancelled = false;
    const isFreshRun = freshRequestRef.current;
    freshRequestRef.current = false;

    if (request.kind === "builder") {
      // Re-query only when the request or sort changed; otherwise just re-slice
      // the in-hand payload (paging the tiny builder result is client-side).
      const key = JSON.stringify({ q: request.query, sort });
      if (key === builderKey.current && builderFull.current) {
        setTable(pageResultTable(builderFull.current, page, pageSize));
        return;
      }
      builderKey.current = key;
      setStatus("loading");
      setError(null);
      const q: Query = { ...request.query, sort: sort?.dir ?? request.query.sort };
      runQuery(q)
        .then(({ payload, elapsedMs }) => {
          if (cancelled) return;
          const full = chartPayloadToResultTable(payload, elapsedMs);
          builderFull.current = full;
          setTable(pageResultTable(full, page, pageSize));
          const dataStatus = full.totalRows === 0 ? "empty" : "data";
          setStatus(dataStatus);
          if (isFreshRun) onResult?.({ status: dataStatus, rowCount: full.totalRows, elapsedMs });
        })
        .catch((err) => {
          if (cancelled) return;
          const message = toMessage(err);
          setError(message);
          setStatus("error");
          if (isFreshRun) onResult?.({ status: "error", error: message });
        });
    } else if (request.kind === "sql") {
      // SQL: always re-run (the worker slices the materialized result cheaply).
      setStatus("loading");
      setError(null);
      const sql = sort ? applySqlSort(request.sql, sort) : request.sql;
      effectiveSql.current = sql;
      runSql(sql, { limit: pageSize, offset: page * pageSize })
        .then((r) => {
          if (cancelled) return;
          setTable(sqlResultToResultTable(r, page, pageSize));
          const dataStatus = r.rowCount === 0 ? "empty" : "data";
          setStatus(dataStatus);
          if (isFreshRun) onResult?.({ status: dataStatus, rowCount: r.rowCount, elapsedMs: r.elapsedMs });
        })
        .catch((err) => {
          if (cancelled) return;
          const message = toMessage(err);
          setError(message);
          if (isFreshRun) onResult?.({ status: "error", error: message });
          setStatus("error");
        });
    } else {
      // PUSHDOWN: on a FRESH run, execute the IR on the live DB and ingest the
      // result into the worker; later page/sort re-queries just re-slice the
      // ingested table (no second server round-trip). Then it's the SQL path.
      setStatus("loading");
      setError(null);
      const { datasetId, sourceId, ir } = request;
      const table = tableNameForId(datasetId);
      const base = `SELECT * FROM "${table}"`;
      const sql = sort ? applySqlSort(base, sort) : base;
      effectiveSql.current = sql;
      const slice = () =>
        runSqlOn(datasetId, sql, { limit: pageSize, offset: page * pageSize });
      const started = isFreshRun
        ? runPushdown(datasetId, sourceId, ir).then(slice)
        : slice();
      started
        .then((r) => {
          if (cancelled) return;
          setTable(sqlResultToResultTable(r, page, pageSize));
          const dataStatus = r.rowCount === 0 ? "empty" : "data";
          setStatus(dataStatus);
          if (isFreshRun) onResult?.({ status: dataStatus, rowCount: r.rowCount, elapsedMs: r.elapsedMs });
        })
        .catch((err) => {
          if (cancelled) return;
          const message = toMessage(err);
          setError(message);
          if (isFreshRun) onResult?.({ status: "error", error: message });
          setStatus("error");
        });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onResult intentionally excluded: an unmemoized parent callback would re-fire the query effect (infinite re-query); freshRequestRef already gates it to once per run
  }, [request, page, pageSize, sort, runQuery, runSql, runSqlOn, runPushdown, tableNameForId]);

  const handleSort = (next: SortSpec | null) => {
    setSort(next);
    setPage(0);
  };
  const handlePageSize = (size: number) => {
    setPageSize(size);
    setPage(0);
  };

  const handleExportCsv = async () => {
    if (!request || !table) return;
    setExporting(true);
    try {
      if (request.kind === "builder" && builderFull.current) {
        const full = builderFull.current;
        downloadCsv("results.csv", tableToCsv(full.columns, full.rows));
      } else if (request.kind === "sql") {
        const csv = await exportSqlCsv(effectiveSql.current ?? request.sql);
        downloadCsv("results.csv", csv);
      } else if (request.kind === "pushdown") {
        const table = tableNameForId(request.datasetId);
        const csv = await exportSqlCsvOn(
          request.datasetId,
          effectiveSql.current ?? `SELECT * FROM "${table}"`,
        );
        downloadCsv("results.csv", csv);
      }
    } catch (err) {
      setError(toMessage(err));
      setStatus("error");
    } finally {
      setExporting(false);
    }
  };

  if (!request) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border p-6 text-center">
        <div>
          <p className="text-sm font-medium">No results yet</p>
          <p className="text-xs text-muted-foreground">
            Run a builder query or a SQL statement to see results here.
          </p>
        </div>
      </div>
    );
  }

  // Builder charts render the full in-hand result captured in the execute
  // effect; SQL/pushdown charts render the current page.
  // eslint-disable-next-line react-hooks/refs -- reads the effect-captured full builder result; re-render is driven by the setStatus/setTable updates in that effect
  const chartTable = request.kind === "builder" ? builderFull.current : table;

  return (
    <Tabs
      value={view}
      onValueChange={(v) => setView(v as "table" | "chart")}
      className="flex h-full min-h-0 flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <TabsList>
          <TabsTrigger value="table">
            <Table2 className="h-3.5 w-3.5" />
            Table
          </TabsTrigger>
          <TabsTrigger value="chart">
            <BarChart3 className="h-3.5 w-3.5" />
            Chart
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="table" className="min-h-0 flex-1">
        <ResultsTable
          status={status}
          table={table}
          error={error}
          sort={sort}
          exporting={exporting}
          onPageChange={setPage}
          onPageSizeChange={handlePageSize}
          onSort={handleSort}
          onExportCsv={handleExportCsv}
        />
      </TabsContent>

      <TabsContent value="chart" className="min-h-0 flex-1">
        <div className="h-full rounded-xl border border-border bg-card p-3">
          {/* Aggregated builder results are single-page under their LIMIT. */}
          <VizChart
            table={chartTable}
            viz={viz ?? { type: "bar" }}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}

/**
 * Wrap a statement so DuckDB applies ORDER BY worker-side (the table never sorts
 * across pages itself). The original statement becomes a subquery; we strip a
 * trailing `;` so the wrap stays a single valid statement.
 */
function applySqlSort(baseSql: string, sort: SortSpec): string {
  const inner = baseSql.trim().replace(/;\s*$/, "");
  const col = `"${sort.column.replace(/"/g, '""')}"`;
  return `SELECT * FROM (\n${inner}\n) AS _q ORDER BY ${col} ${
    sort.dir === "asc" ? "ASC" : "DESC"
  }`;
}

function toMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const e = err as SqlError;
    const where = e.line != null ? ` (line ${e.line})` : "";
    return `${e.message}${where}`;
  }
  return err instanceof Error ? err.message : String(err);
}
