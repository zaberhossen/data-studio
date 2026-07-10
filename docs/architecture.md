# Architecture

## The one hard rule

> **React must never hold raw rows.**

Raw datasets (up to hundreds of thousands of rows) live exclusively inside the
Web Workers or in a `useRef`. React state only ever contains:

- **metadata** (source list, status, schema/columns, row counts),
- **declarative queries** (the small builder `Query`, or a SQL string),
- **bounded result pages** (≤ one page of the current result).

Every design decision below exists to preserve this invariant.

---

## The two boundaries

Data Studio has two important boundaries. Understanding them explains almost
everything else.

### 1. The main-thread / worker boundary

Heavy compute never runs on the main thread. Two workers sit behind one hook:

| Worker | Engine | Path | Key exports |
|---|---|---|---|
| [`chart.worker.ts`](../src/workers/chart.worker.ts) | Rust → WASM | Visual **builder** | `load_dataset`, `query`, `query_to_sql`, `sql_to_query` |
| [`sql.worker.ts`](../src/workers/sql.worker.ts) | DuckDB-WASM | Raw **SQL** | `runSql` (paged), `export_csv`, file/server ingestion |

A dataset crosses into a worker **once**. After that, the builder sends only a
small `Query` and gets back ~50 aggregated points; SQL sends a statement and
gets back one bounded page.

### 2. The browser / server boundary

This is where the app stops being frontend-only. The browser cannot open a TCP
socket to a database — Next.js **API route handlers** can. So there are two
classes of source:

- **Client-side sources** (file upload: CSV / Parquet / JSON) — read in the
  browser, handed straight to the workers. They **never touch the server**.
- **Server-side sources** (Postgres, and later MySQL / REST) — reached **only**
  through `/api/datasources/*`. Credentials live server-side; the browser
  receives only metadata and bounded row slices.

See [security.md](security.md) for the full credential model.

---

## The engine hook: `useAnalyticsEngine`

[`src/hooks/useAnalyticsEngine.ts`](../src/hooks/useAnalyticsEngine.ts) owns the
lifecycle of **both** workers and presents a single Promise-based API so
components never touch `postMessage`.

```ts
interface AnalyticsEngine {
  ready: boolean;          // Rust module loaded
  loading: boolean;        // any request in flight
  error: string | null;

  load(rows): Promise<number>;                     // fan an in-memory dataset to BOTH engines
  loadFromSource(id, opts?): Promise<SourceLoadResult>; // server source → worker fetch
  loadFile(file): Promise<SourceLoadResult>;       // file bytes → worker parse

  runQuery(query): Promise<QueryResult>;           // builder path (Rust)
  runSql(sql, opts?): Promise<SqlResult>;          // raw SQL path (DuckDB), one page
  exportSqlCsv(sql): Promise<string>;              // full-result CSV (worker-serialized)

  queryToSql(query): Promise<string>;              // bridge: builder → SQL
  sqlToQuery(sql): Promise<SqlToQueryResult>;      // bridge: SQL → builder
  tableName: string;                               // "dataset"
}
```

**Request routing.** `runQuery` / bridges → the Rust worker; `runSql` /
`exportSqlCsv` → the DuckDB worker; `load*` → the DuckDB worker (which fans out —
see below). Both workers share one request-id counter and one pending-request
map; responses are matched back to their caller by `requestId`.

**Stability contract.** The returned object is memoized and every method is
`useCallback`-stable *in identity* — but note the object's identity **does**
change when `loading`/`error`/`ready` change. Effects that call engine methods
must depend on the **destructured methods** (`runQuery`, `runSql`, …), never on
the whole `engine` object, or they will re-fire on every `loading` toggle and
loop. (`ResultsRegion` destructures deliberately; the dashboard's
`useQueryScheduler` instead keeps the engine in a ref for the same reason.)

---

## The private worker↔worker channel

The trickiest requirement: load a source into **both** engines without rows ever
touching the main thread. The Rust engine has **no file parser** (its only
ingestion entry point is `load_dataset(rows)`), so it cannot read a CSV/Parquet
buffer itself.

Solution: a private `MessageChannel` established once at hook init. The DuckDB
worker is the **data-loading worker** — it fetches or parses a source, then
forwards the parsed `Row[]` to the Rust worker over the channel. Rows never
reach the main thread.

```
hook init:
  const link = new MessageChannel()
  chart.postMessage({type:"link"}, [link.port1])   // Rust worker keeps port1
  sql.postMessage({type:"link"},   [link.port2])   // DuckDB worker keeps port2

server source (loadFromSource):
  React → sql.worker  { type:"load_source", sourceId, table, limit, offset }
  sql.worker:  fetch /api/datasources/[id]/data?…   → rows (bounded slice)
               stash rows for DuckDB (lazy ingest)
               port2.postMessage({kind:"ingest", token, rows})   ─────┐
  chart.worker (port1): wasm.load_dataset(rows)                        │  (off main thread)
               port1.postMessage({kind:"ingested", token, rowCount}) ◄┘
  sql.worker → React  { type:"source_loaded", rowCount, columns }

file source (loadFile):
  React reads File → ArrayBuffer, transfers bytes to sql.worker
  sql.worker: DuckDB registerFileBuffer + read_csv_auto/read_parquet/read_json_auto
              → CREATE TABLE dataset → SELECT * → Row[]
              → forward to Rust worker over the channel (same as above)
```

The demo/in-memory path (`load(rows)`) is simpler: the hook fans the same `Row[]`
to both workers directly (it already has the rows in hand from the generator).

Protocol types live in [`analytics.ts`](../src/lib/types/analytics.ts)
(`PeerToChart` / `PeerFromChart`) and [`sql.ts`](../src/lib/types/sql.ts)
(`SqlWorkerRequest` / `SqlWorkerResponse`).

---

## Shared contracts (the type layer)

Every boundary is described by a TypeScript contract so payloads cross with zero
transformation:

| File | Contract |
|---|---|
| [`types/analytics.ts`](../src/lib/types/analytics.ts) | `Row`, `Query`, `ChartPayload`, the Rust worker protocol, the SQL⇄builder bridge, and the peer-channel messages. Mirrors the Rust structs (serde snake_case). |
| [`types/sql.ts`](../src/lib/types/sql.ts) | `SqlResult`, `SqlColumn`, `SqlError`, and the DuckDB worker protocol (`load`, `load_source`, `load_file`, `sql`, `export_csv`). |
| [`types/datasource.ts`](../src/lib/types/datasource.ts) | `DataSourceMeta`/`Kind`/`Status`, `SourceSchema`, `CreateDataSourceInput`, `DataSlice`, and — behind a **SERVER-ONLY** banner — the secret-bearing types. |
| [`types/results.ts`](../src/lib/types/results.ts) | `ResultTable` view-model + the two pure adapters. The single shape the results table renders. |
| [`query/schema.ts`](../src/lib/query/schema.ts) | The UI field model (`Field`), operator/aggregation metadata, draft→`Query` compilation, and `fieldsFromColumns` (schema → field browser). |

---

## Component / module layers

```
src/
├── app/
│   ├── page.tsx                 # dashboard: sidebar panels + query panel + results region
│   └── api/datasources/…        # server backend (route handlers)
├── hooks/
│   ├── useAnalyticsEngine.ts    # owns both workers; Promise API
│   └── useDataSources.ts        # source list + active source + load orchestration
├── workers/
│   ├── chart.worker.ts          # Rust/WASM engine
│   └── sql.worker.ts            # DuckDB-WASM engine
├── components/
│   ├── sources/                 # DataSourcePanel, AddSourceDialog
│   ├── query/                   # QueryPanel, QueryBuilder, SqlEditor, FilterRow…
│   ├── results/                 # ResultsRegion, ResultsTable, ResultsChart
│   ├── layout/                  # AppShell, Sidebar, Topbar, ThemeToggle
│   └── ui/                      # shadcn primitives (button, table, tabs, dialog…)
├── lib/
│   ├── server/                  # connectors, store, config (SERVER-ONLY)
│   ├── results/                 # csv + cell-format helpers
│   ├── query/                   # field model + query compilation
│   ├── data/                    # mock-source (demo), sales-schema
│   └── types/                   # the shared contracts above
└── wasm/pkg/                    # wasm-pack output (generated, gitignored)
```

**Data flow direction:** `page.tsx` orchestrates; smart hooks/containers
(`useDataSources`, `ResultsRegion`) own state and talk to the engine; leaf
components (`ResultsTable`, `QueryBuilder`, `DataSourcePanel`) are presentational
and communicate up via callbacks.

---

## Why two engines?

They serve two genuinely different query surfaces:

- The **Rust builder engine** models a constrained, validated query (filter →
  group-by → aggregate → sort → limit) and returns a chart-shaped payload. It is
  fast, deterministic, and safe by construction.
- **DuckDB-WASM** runs arbitrary read-only SQL over the same loaded dataset, with
  a real SQL planner, materialization, and paging.

The **bridge** (`queryToSql` / `sqlToQuery`) translates between the two so a user
can start visually and drop into SQL (or vice-versa) without losing work. Both
engines are fed the **same** dataset via the load path, so a builder query and a
SQL statement run over identical data.

---

## The Query IR & compile layer (M3)

The advanced builder edits a **Query IR** ([`query/ir.ts`](../src/lib/query/ir.ts))
— an MBQL-like, JSON-serializable representation supporting multiple metrics,
multiple dimensions with temporal bucketing, calculated fields (a closed, no-free-
text expression algebra), rich filter trees, joins, and window functions. It
crosses **no** Rust boundary, so it uses natural camelCase.

The IR is turned into SQL by the dialect-aware compiler
([`query/compile/`](../src/lib/query/compile/)):

- **`compileIR(ir, dialect, allowedColumns)` → `{ sql, params, columns }`**. Three
  injection rules: identifiers come only from the IR and are validated against the
  source allowlist then quoted; filter values (and limit/offset) are always bound
  params; expressions are a closed algebra with strictly-escaped inlined literals.
- **`Dialect`** ([`dialect.ts`](../src/lib/query/compile/dialect.ts)) abstracts
  quoting, placeholders, temporal bucketing, aggregate rendering, and relative
  dates. `DuckDbDialect` (LOCAL) ships in M3; Postgres/MySQL/BigQuery (PUSHDOWN)
  land with pushdown (M5+).
- **`rustFastPath(ir)`** ([`capability.ts`](../src/lib/query/compile/capability.ts))
  returns the legacy `Query` when an IR fits the Rust engine's narrow shape (single
  dim, single agg, flat-AND filters) so the hot local path is preserved; otherwise
  the IR compiles to SQL.
- **`queryV1ToIR`** migrates legacy builder `Query` → IR; the saved-query store
  upgrades lazily on read (non-destructive — `query` is kept). `SAVED_QUERY_SCHEMA_VERSION`
  is now `2`.
- **`chooseExecution(kind, ir)`** picks LOCAL (DuckDB over the resident dataset) vs
  PUSHDOWN (connector runs the SQL on the live DB). Execution wiring + the `/run`
  endpoint arrive in M4/M5.

`QueryDefinition` now carries an optional `ir` (and `execution`) alongside the
legacy `query`/`sql`, so widgets and saved queries inherit the IR for free.
