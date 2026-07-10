# Data Sources

How Data Studio connects to data, introspects it, and loads a bounded slice into
both engines. This layer replaced the old hard-coded mock generator; the
downstream `Row[]` shape is unchanged, so the engines and query surfaces did not
need to change.

---

## Source classes

| Class | Kinds | Where it's read | Server involved? |
|---|---|---|---|
| **Client-side** | `file` (CSV / Parquet / JSON) | In the browser (DuckDB) | No — never uploaded |
| **Server-side** | `postgres` (✅), `mysql` / `http-file` / `rest-api` (deferred) | Next.js API routes | Yes — credentials server-side |
| **Built-in** | Demo (200k mock rows) | Generated client-side | No |

---

## Server layer (SERVER-ONLY)

Everything under [`src/lib/server/`](../src/lib/server/) runs only in Node route
handlers. It is never imported by a client component or worker.

### The `Connector` interface

[`connectors/types.ts`](../src/lib/server/connectors/types.ts) is the seam that
lets Postgres ship now and MySQL/REST slot in later unchanged:

```ts
interface Connector {
  test(): Promise<void>;                       // liveness round-trip
  introspectSchema(): Promise<SourceSchema>;   // tables (allowlist) + columns
  fetchRows(opts): Promise<DataSlice>;         // bounded, validated slice
  dispose(): Promise<void>;                    // release the pool
}
```

### `PostgresConnector` (reference implementation)

[`connectors/postgres.ts`](../src/lib/server/connectors/postgres.ts):

- One `pg.Pool` per source (pooled, `statement_timeout` set on every connection).
- `introspectSchema()` reads `information_schema` and **builds the allowlist** of
  selectable `schema.table` names, plus the columns of the default/first table.
- `fetchRows()` **validates the requested table against the allowlist**, quotes
  the validated identifier with `escapeIdentifier`, and binds `LIMIT`/`OFFSET` as
  parameters. It pulls `limit + 1` rows to detect whether the cap truncated the
  table (`capped`). There is no code path that omits the limit.

### Factory + instance cache

[`connectors/index.ts`](../src/lib/server/connectors/index.ts) maps a source's
secret to a `Connector` and caches one instance per source id on `globalThis`
(so Next.js dev HMR doesn't leak pools). MySQL/HTTP/REST throw a clear
"not implemented yet" here — the single place they'll be added.

### Source store

[`datasource-store.ts`](../src/lib/server/datasource-store.ts) is a swappable
`SourceStore`. The MVP implementation keeps records in memory, mirrored to a JSON
file (`.data/datasources.json`, gitignored). Each record is
`{ meta, secret }` — endpoints only ever return `meta`.

### Limits

[`config.ts`](../src/lib/server/config.ts) — `DEFAULT_ROW_CAP` (100k),
`QUERY_TIMEOUT_MS` (30s), both env-overridable, with `clampLimit`/`clampOffset`
so a client-supplied `?limit=` can never exceed the cap.

---

## API routes (App Router route handlers)

All under [`src/app/api/datasources/`](../src/app/api/datasources/), Node runtime,
`force-dynamic`. Every response is secret-free.

| Method + path | Purpose |
|---|---|
| `GET /api/datasources` | List `DataSourceMeta[]` |
| `POST /api/datasources` | Create a source; accepts a password **once**, stores it server-side, responds with meta only |
| `DELETE /api/datasources/[id]` | Remove a source + dispose its pool |
| `POST /api/datasources/[id]/test` | Connection test → `{ ok, error? }` |
| `GET /api/datasources/[id]/schema` | Introspect → `SourceSchema` (tables allowlist + columns) |
| `GET /api/datasources/[id]/data?table=&limit=&offset=` | Bounded, validated row slice → `DataSlice` |

---

## Client layer

### `useDataSources` orchestration hook

[`useDataSources.ts`](../src/hooks/useDataSources.ts) unifies the three source
classes behind one list + `activate`. It holds **metadata only** — never rows.

- `sources` — demo + client file sources + server sources, each merged with live
  status (`connecting → ready · N rows / error`).
- `activeFields` — the active source's schema as `Field[]` (feeds the builder /
  SQL editor).
- `activate(id)` — the crux:
  - **demo** → `engine.load(generateSalesData())`, fields from the sales schema;
  - **file** → `engine.loadFile(handle)` (bytes → worker), fields from columns;
  - **server** → `engine.loadFromSource(id, { table })` (worker fetches the
    slice), fields from columns.
- `addServerSource`, `addFileSource`, `removeSource`, `testSource`,
  `refreshActive`, `refreshList`.
- File `File` handles are kept in a `useRef` map (handles, not rows).

### Panel + dialog

- [`DataSourcePanel.tsx`](../src/components/sources/DataSourcePanel.tsx) — the
  list, status badges, active highlight, per-source actions, and all list states.
- [`AddSourceDialog.tsx`](../src/components/sources/AddSourceDialog.tsx) — kind
  selector → conditional form; file drop-zone (client-side) vs. connection fields
  (submitted to `POST /api/datasources`).

---

## Loading a source into both engines

The key property: **rows reach both engines without touching the main thread.**
The DuckDB worker is the data-loading worker; it forwards parsed rows to the Rust
worker over a private `MessageChannel`. Full sequence in
[architecture.md](architecture.md#the-private-workerworker-channel).

```
Activate a source
  ├─ demo   → hook generates rows → engine.load(rows) → fans to BOTH workers
  ├─ file   → read File bytes → sql.worker parses (DuckDB) → forwards rows to Rust worker
  └─ server → sql.worker fetches /api/datasources/[id]/data → forwards rows to Rust worker
                                   │
                                   ▼
        both engines hold the dataset;   activeFields ← columns   →   builder + SQL editor
```

---

## Extending: adding a new connector

1. Implement `Connector` (e.g. `MySqlConnector` with `mysql2`) in
   `src/lib/server/connectors/`.
2. Add the branch in `build()` in [`connectors/index.ts`](../src/lib/server/connectors/index.ts).
3. If the create payload needs new fields, extend `CreateDataSourceInput` and
   `DataSourceSecret` in [`types/datasource.ts`](../src/lib/types/datasource.ts)
   and the validation in the `POST` route.
4. Remove the kind from `PREVIEW_KINDS` in the Add-source dialog.

Nothing in the worker/UI load path changes — it already speaks `Row[]`.
