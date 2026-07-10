# Features

A complete inventory of what the product does today, grouped by area. Each
feature links to its primary source and, where relevant, its deep-dive doc.

---

## 1. Compute engines (off the main thread)

- **Rust → WASM builder engine** ([`chart.worker.ts`](../src/workers/chart.worker.ts))
  — deserializes a dataset once into per-worker memory, then runs
  `filter → group_by → aggregate → sort → limit` in a single pass and returns a
  chart-ready `ChartPayload` (~50 points).
  - Filters: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in_list`
  - Aggregations: `SUM`, `AVG`, `COUNT`, `MIN`, `MAX`
  - Grouping by any dimension; ascending/descending sort by metric; top-N limit.
- **DuckDB-WASM SQL engine** ([`sql.worker.ts`](../src/workers/sql.worker.ts))
  — arbitrary **read-only** SQL over the loaded dataset. The full result is
  materialized once (Arrow) and cached; paging is a cheap slice, not a
  re-execution. Lazy-loaded on first use so it never blocks initial page load.
- **Single hook API** ([`useAnalyticsEngine.ts`](../src/hooks/useAnalyticsEngine.ts))
  — one Promise-based surface over both workers; components never touch
  `postMessage`.

See [architecture.md](architecture.md).

---

## 2. Data sources

Deep dive: [data-sources.md](data-sources.md).

- **Built-in Demo source** — a deterministic 200k-row sales dataset
  ([`mock-source.ts`](../src/lib/data/mock-source.ts)), auto-activated on load so
  the app is usable immediately.
- **File upload (client-side)** — drag-drop or browse **CSV / Parquet / JSON**;
  parsed entirely in the browser by DuckDB and never uploaded to the server.
- **PostgreSQL & MySQL (server-side)** — host/port/database/user/password/table,
  tested and introspected server-side; a bounded slice is pulled into the browser.
  MySQL uses the same allowlist + bound-parameter + timeout model as Postgres
  ([`connectors/mysql.ts`](../src/lib/server/connectors/mysql.ts)).
- **Encrypted, multi-tenant store** — sources live in Postgres, secrets sealed
  with AES-256-GCM, every row scoped to an `org_id` (M2).
- **Additional kinds in the UI** — HTTP-file and REST-API are selectable and
  storable, marked **"preview"** (their connectors are deferred to M10).
- **Source panel** ([`DataSourcePanel.tsx`](../src/components/sources/DataSourcePanel.tsx))
  — lists sources with a **status badge + row count**, highlights the **active**
  source, and offers per-source **set-active / test / refresh / remove** actions.
- **Add-source dialog** ([`AddSourceDialog.tsx`](../src/components/sources/AddSourceDialog.tsx))
  — kind selector → conditional form (file drop-zone vs. connection fields).
- **All states designed:** empty, idle, connecting, file-parsing, ready, error,
  list-loading, list-error.

---

## 3. Query surfaces

- **Visual query builder** ([`QueryBuilder.tsx`](../src/components/query/QueryBuilder.tsx))
  — filters (add/edit/remove), group-by dimension, metric + aggregation, sort +
  top-N. Compiles a loose draft into the strict engine `Query`, validating live.
- **Advanced (IR) builder** ([`AdvancedQueryBuilder.tsx`](../src/components/query/AdvancedQueryBuilder.tsx))
  — the Metabase-class surface (M4): **multiple metrics** (incl. count-distinct /
  median / stddev), **multiple dimensions** with **date bucketing** (day…year,
  day-of-week, month-of-year), and a richer filter set (between, is-empty, starts/
  ends-with, **relative dates**). Edits a loose `IrDraft`, compiled to a `QueryIR`
  ([`ir-draft.ts`](../src/lib/query/ir-draft.ts)) → SQL. Runs LOCAL today (compiles
  to inlined DuckDB SQL over the resident dataset and rides the SQL results path);
  pushdown + save/open for IR queries follow in M5/M6.
- **Raw SQL editor** ([`SqlEditor.tsx`](../src/components/query/SqlEditor.tsx))
  — token-styled editor with a **column reference** fed by the active source's
  schema (click a column to insert it — the autocomplete stand-in).
- **Builder ⇄ SQL bridge** ([`QueryPanel.tsx`](../src/components/query/QueryPanel.tsx))
  — switching tabs translates: builder→SQL compiles + `queryToSql`; SQL→builder
  `sqlToQuery` (representable → fills the builder; SQL-only → stays in SQL with a
  note; malformed → inline parse error). The user's SQL is never discarded.
- **Schema-aware field browser** — the active source's schema flows into the
  builder and SQL editor via `fieldsFromColumns`; nothing downstream is rebuilt
  per source.

---

## 4. Results

Deep dive: [results-table.md](results-table.md).

- **Chart | Table tabs** ([`ResultsRegion.tsx`](../src/components/results/ResultsRegion.tsx))
  — the same active result viewed as a Recharts chart or a data table.
- **Recharts chart** ([`ResultsChart.tsx`](../src/components/results/ResultsChart.tsx))
  — bar/line view of builder aggregations.
- **Paginated results table** ([`ResultsTable.tsx`](../src/components/results/ResultsTable.tsx))
  — headless column modeling via `@tanstack/react-table`, shadcn Table rendering,
  keyboard-accessible.
  - **Type-aware formatting:** numbers right-aligned + locale grouping; dates
    humanized; booleans as `true/false`; nulls as a muted `null`.
  - **Pagination + page-size + sort as re-query** (never client-side across
    pages): SQL re-runs with new `limit/offset` and `ORDER BY`; the tiny builder
    payload is paged client-side and re-run for sort.
  - **States:** loading (skeleton rows), empty, error, data, capped note.
  - **Status bar:** row range, total rows, elapsed ms, source badge.
- **CSV export of the FULL result** — SQL serializes the entire materialized
  Arrow result inside the worker (`exportSqlCsv`); the builder serializes its
  full payload in-hand ([`csv.ts`](../src/lib/results/csv.ts)).

---

## 5. Application shell & theming

- **Workspace shell** ([`AppShell.tsx`](../src/components/layout/AppShell.tsx))
  — fixed viewport, left nav rail, top bar, scrollable canvas; auto-collapsing
  sidebar on narrow viewports.
- **Navigation rail** ([`Sidebar.tsx`](../src/components/layout/Sidebar.tsx))
  — Data sources + Query builder are live; other panels are marked "soon".
- **Top bar** ([`Topbar.tsx`](../src/components/layout/Topbar.tsx))
  — honest engine status pill (booting → ready → error) + active-source subtitle.
- **Light / dark theme** ([`ThemeToggle.tsx`](../src/components/layout/ThemeToggle.tsx),
  [`globals.css`](../src/app/globals.css)) — HSL design tokens; no FOUC (theme
  applied before first paint).
- **Design-token-only styling** — every component uses shadcn/Tailwind tokens,
  so light/dark and future re-theming are free.

---

## 6. Security features

Deep dive: [security.md](security.md).

- Credentials stored **server-side only**, never returned by any endpoint.
- **Parameterized queries**; client-selected tables validated against a
  server-introspected **allowlist** (never string-interpolated).
- **Row cap + per-request timeout** on every server pull; no unbounded tables.
- **Connection pooling** (one `pg.Pool` per source).
- **Read-only SQL guard** in the DuckDB worker (only `SELECT` / `WITH`).

---

## 7. Testing

- **Adapter unit tests** ([`results.test.ts`](../src/lib/types/results.test.ts))
  via Vitest — the pure `ResultTable` adapters (10 cases). Run with `pnpm test`.
