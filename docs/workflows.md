# Workflows

End-to-end walkthroughs of the main user journeys, with the code path each one
exercises. "Rows stay off the main thread" is called out where it matters.

---

## App boot

1. `page.tsx` mounts; `useAnalyticsEngine` spawns both workers and links them via
   the private `MessageChannel`. The Rust module boots (`init`); DuckDB stays
   lazy.
2. `useDataSources` fetches `GET /api/datasources` (server sources) and prepends
   the built-in **Demo** source.
3. When the engine reports `ready`, the page **auto-activates the Demo source**
   so the builder works immediately.
4. The top bar reflects engine status (booting → ready → error).

---

## Add a server source (Postgres)

1. **Data sources** panel → **Add source** → choose *PostgreSQL* → fill
   host/port/database/user/password/table → **Save**.
2. `POST /api/datasources` validates the payload, the store persists
   `{ meta, secret }` server-side, and responds with **meta only** (the password
   never comes back).
3. (Optional) **Test connection** → `POST /…/test` opens a pooled connection and
   round-trips `SELECT 1`; status becomes ready/error.

## Add a file source (client-side)

1. **Add source** → *File* → drop a CSV/Parquet/JSON file.
2. `useDataSources.addFileSource` stores the `File` handle, then `activate`s it.
3. `engine.loadFile(file)` reads bytes on the main thread, **transfers** them to
   the DuckDB worker, which parses (`read_csv_auto`/`read_parquet`/
   `read_json_auto`) into the `dataset` table and forwards the rows to the Rust
   worker. The file is **never uploaded**.

---

## Activate a source

1. Click a source in the panel → `useDataSources.activate(id)` sets status
   `connecting`.
2. Rows are loaded into **both** engines by class (demo=`load`, file=`loadFile`,
   server=`loadFromSource`) — see [data-sources.md](data-sources.md#loading-a-source-into-both-engines).
3. On success: status → `ready · N rows`; `activeFields` is derived from the
   returned columns and flows into the builder + SQL editor. On failure: status →
   `error` with the message.

Throughout, React holds only `{ rowCount, columns }` — never the rows.

---

## Run a builder query

1. In **Query builder**, pick filters / group-by / metric+aggregation /
   sort+limit. `QueryBuilder` compiles the draft to a strict `Query` live,
   surfacing validation errors and disabling **Run** until valid.
2. **Run** → `page` sets `request = { kind: "builder", query }`.
3. `ResultsRegion` calls `engine.runQuery(query)` → Rust returns a `ChartPayload`.
4. Adapters produce a `ResultTable`; the **Table** tab shows it (paged
   client-side) and the **Chart** tab renders the payload with Recharts.

## Run a SQL query

1. Switch the query panel to **SQL** (the current builder query can be translated
   in via the bridge). Edit SQL; click **Run SQL**.
2. `page` sets `request = { kind: "sql", sql }`.
3. `ResultsRegion` calls `engine.runSql(sql, { limit: pageSize, offset: 0 })`.
   The DuckDB worker enforces the **read-only guard**, executes once, materializes
   + caches the Arrow result, and returns the first page.
4. The **Table** tab shows the page; the status bar shows total rows + elapsed ms.

---

## Paginate & change page size

- **SQL:** next/prev/first/last or a new page size → `ResultsRegion` re-runs
  `runSql` with a new `offset`/`limit`. The worker slices the **cached** result
  (no re-execution).
- **Builder:** the full payload is in hand → the region re-slices client-side; no
  engine call.

## Sort a column

- **SQL:** the region wraps the statement — `SELECT * FROM (<sql>) ORDER BY "col"
  DIR` — resets to page 0, and re-runs (ordering happens in DuckDB).
- **Builder:** the region re-runs `runQuery` with the updated `Query.sort`.

The table itself never reorders rows in place.

---

## Export CSV (full result)

- **SQL:** **Export CSV** → `engine.exportSqlCsv(effectiveSql)` → the worker
  serializes the **entire** materialized result to a CSV string → browser
  download. (Uses the sorted SQL if a sort is active, so the file matches what's
  shown.)
- **Builder:** the full payload is serialized in-hand and downloaded.

---

## Switch Chart ⇄ Table

Both views read the same active result. Table works for both paths; Chart renders
builder aggregations (SQL results show a hint to use the Table).

---

## Remove a source

- **File / demo:** demo is permanent; a file source is dropped from client state
  and its handle released.
- **Server:** `DELETE /api/datasources/[id]` removes the record and disposes the
  connector's pool. If the removed source was active, the active selection clears.
