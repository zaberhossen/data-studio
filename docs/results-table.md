# Results Table

The results feature renders query **results** (never raw rows), works for both
the builder and raw-SQL paths, and stays presentational and decoupled.

---

## The normalized view-model

Two engines produce two different shapes:

- Builder → `ChartPayload` (a handful of aggregated points),
- SQL → `SqlResult` (one materialized page of arbitrary columns).

Both normalize into one `ResultTable` ([`types/results.ts`](../src/lib/types/results.ts)):

```ts
type ResultColumn = { name: string; type: "number"|"string"|"date"|"bool" };
type ResultTable = {
  columns: ResultColumn[];
  rows: unknown[][];     // CURRENT page only
  page: number;          // 0-based
  pageSize: number;
  totalRows: number;     // full result size (pagination + truncation note)
  source: "builder" | "sql";
  elapsedMs?: number;
  capped?: boolean;      // true if totalRows hit the server/worker row cap
};
```

### Pure adapters (unit-tested)

- `chartPayloadToResultTable(p, elapsedMs?)` — the payload is tiny and fully in
  hand, so this returns the **whole** result as a 2-column table (dimension +
  metric). The caller pages it client-side.
- `sqlResultToResultTable(r, page, pageSize, capped?)` — `SqlResult.rows` is
  already one page (the worker materialized once and sliced), so this is a
  near-identity map that records the page coordinates.
- `pageResultTable(full, page, pageSize)` — slices a fully-in-hand table to one
  page (used for the builder path).

Tests: [`results.test.ts`](../src/lib/types/results.test.ts) (10 cases). The
table component is fed one `ResultTable` and **never learns which engine produced
it**.

---

## The presentational table

[`ResultsTable.tsx`](../src/components/results/ResultsTable.tsx):

- **Column modeling** via `@tanstack/react-table` (headless), with
  `manualPagination` + `manualSorting` — it never sorts or paginates across pages
  itself. Rendering uses shadcn [`Table`](../src/components/ui/table.tsx).
- **Props:** a `ResultTable` + `status` + `sort` + callbacks
  `onPageChange`, `onPageSizeChange`, `onSort`, `onExportCsv`.
- **Cell formatting** ([`format.ts`](../src/lib/results/format.ts)): numbers
  right-aligned + `Intl.NumberFormat`; dates humanized; booleans `true/false`;
  nulls a muted italic `null`.
- **States:** `loading` (skeleton rows), `empty`, `error` (message), `data`, plus
  a non-blocking **capped** note when `capped === true`.
- **Status bar:** always shows the row range, `totalRows`, `elapsedMs`, and a
  source badge; hosts the page-size select, pager, and Export CSV button.
- **Accessibility:** header sort buttons set `aria-sort`; pager buttons and the
  page-size select are labeled; everything is keyboard-reachable.

---

## Pagination + sort = re-query, never client-side

Only one page is ever in memory, so the table emits intent and the **smart
container** [`ResultsRegion.tsx`](../src/components/results/ResultsRegion.tsx)
re-queries:

| Change | SQL path | Builder path |
|---|---|---|
| **Page / page-size** | re-run `runSql` with new `{ limit, offset }` (worker slices the cached result — no re-execution) | re-slice the in-hand payload client-side (no re-query) |
| **Sort** | wrap the statement: `SELECT * FROM (<sql>) ORDER BY "col" DIR` and re-run (worker-side ordering) | re-run `runQuery` with the updated `Query.sort` |

`ResultsRegion` owns `page` / `pageSize` / `sort`, resets them when a new request
arrives, keeps the full builder payload in a ref for client paging, and remembers
the effective (possibly ORDER BY-wrapped) SQL for export.

> **Note on the effect deps:** the region depends on the **destructured** engine
> methods (`runQuery`, `runSql`, `exportSqlCsv`), never the whole `engine` object
> — depending on the object would re-fire the effect on every `loading` toggle
> and loop.

---

## CSV export (full result, not the visible page)

[`csv.ts`](../src/lib/results/csv.ts) + the worker:

- **SQL path** → `engine.exportSqlCsv(sql)` sends `export_csv` to the DuckDB
  worker, which serializes the **entire** materialized Arrow result (RFC-4180
  quoting) and returns a string. Only the final string crosses into React.
- **Builder path** → the full payload is already in hand, so `tableToCsv` runs on
  the main thread.
- Both trigger a download via `downloadCsv`.

---

## Chart | Table tabs

[`ResultsRegion.tsx`](../src/components/results/ResultsRegion.tsx) wires a
[`Tabs`](../src/components/ui/tabs.tsx) toggle so the same active result is
viewable as:

- **Table** — the `ResultsTable` above (both paths), or
- **Chart** — [`ResultsChart.tsx`](../src/components/results/ResultsChart.tsx), a
  Recharts bar/line view of the builder `ChartPayload`. SQL results have no
  `ChartPayload`, so the Chart tab shows a hint to use the Table (charting
  arbitrary SQL output is out of scope for now).

---

## Data-flow summary

```
QueryPanel ──onRun(query)──►  page  ──►  ResultsRegion
QueryPanel ──onRunSql(sql)─►         request = {builder|sql}
                                          │
                    ┌─────────────────────┴─────────────────────┐
             builder: runQuery                             sql: runSql(limit,offset)
             → ChartPayload                                → SqlResult (one page)
             → chartPayloadToResultTable (full)            → sqlResultToResultTable(page)
             → pageResultTable(page)                              │
                    └───────────────► ResultTable ◄───────────────┘
                                          │ + callbacks
                                          ▼
                                     ResultsTable (presentational)
```

---

## Deliberate limitations (candidates for next steps)

- **Builder column sort** maps to `Query.sort`, which only orders by the
  aggregated metric — the indicator can appear on the label column while ordering
  is by value.
- **SQL `capped`** is wired through the adapters/UI but not currently set `true`
  (there's no query-time cap signal; the 100k cap applies at data-load time).
- **PNG export** is optional/secondary and not yet implemented (would render the
  table node to an image; the chart's own image export is separate).
