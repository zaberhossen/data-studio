# Roadmap / Future Work

The plan to bring Data Studio to **Metabase / Google Data Studio parity** across
four areas — query builder, shareable canvas dashboards, widget creation, and the
add-data-source UI — while keeping the current shadcn/Tailwind UI/UX and the
architectural invariants in [architecture.md](architecture.md). See
[gap-analysis.md](gap-analysis.md) for the feature-by-feature current-vs-target
comparison this roadmap closes.

## Locked decisions

- **Full multi-user backend** (real DB, auth, organizations/workspaces, share-link
  + public/embed) — not deferred.
- **Compute strategy: an MBQL-like Query IR.** The builder edits a JSON `QueryIR`
  that compiles to **dialect-aware SQL** and runs either **local** (DuckDB-WASM) or
  **pushdown** (the connector runs it on the live DB). The Rust engine is kept only
  as a fast-path for the simple cases it already handles. This unlocks joins,
  multi-metric, calculated fields, bucketing, and window functions using DuckDB
  (already present) without rewriting Rust.
- **Layout: grid + free-form canvas**, toggled per dashboard.
- **Delivery: phased milestones**, each independently shippable and non-breaking.

---

## Milestones

Each milestone is deployable on its own and does not break the running app.

### M0 — DB + crypto foundation (invisible)
Drizzle ORM on the existing `pg` dependency. `src/lib/db/{client,schema,scope}.ts`,
`drizzle.config.ts`, migrations. `src/lib/server/crypto.ts` (AES-256-GCM,
`DATA_STUDIO_ENC_KEY`, `key_version`). App still uses local stores.

### M1 — Auth + orgs
Auth.js (NextAuth v5) + Drizzle adapter, DB sessions. `(app)` (authed shell — the
current [`page.tsx`](../src/app/page.tsx) moves here) and `(public)` route groups,
`src/middleware.ts`, login/signup, org + owner membership on signup, org switcher.

### M2 — Data sources → DB, encrypted, multi-tenant
Swap `FileSourceStore` for `DbSourceStore` (encrypted secrets, `org_id`-scoped).
`/api/datasources/*` becomes org-scoped. Run `scripts/migrate-datasources.ts` for
any existing `.data` file. Implement the **MySQL** connector (`mysql2`).

### M3 — Query IR foundation (invisible)
`src/lib/query/ir.ts` (`QueryIR` v2), `queryV1ToIR`, `rustFastPath`,
`src/lib/query/compile/` with `compileIR` + `DuckDbDialect`, LOCAL routing behind a
flag, unit tests. Bump `SAVED_QUERY_SCHEMA_VERSION` 1→2 (lazy, non-destructive
migrate). Rust fast-path still serves the simple builder query.

### M4 — Advanced builder v1 (first visible jump)
Multi-metric (`MetricList`), multi-dimension (`DimensionList`), date bucketing
(`DateBucketSelect` + a real `date` DataType), rich filters (`between`, null checks,
`starts_with`/`ends_with`, `relative_date` + `RelativeDateInput`).

### M5 — Pushdown ✅
`PostgresDialect` + `MySqlDialect` (`dialectFor`), `POST /api/datasources/[id]/run`
(accepts the **IR**, never client SQL; re-introspects the allowlist server-side),
`connector.runCompiled` (LIMIT envelope + statement timeout). Client wiring:
`chooseExecution` routing + an `ExecutionModeToggle` (auto / force local / force
pushdown) on the advanced builder. A pushdown run is fetched and ingested **inside
the DuckDB worker** (`run_pushdown` message → `/run` → Arrow IPC stashed as its own
dataset), so the small aggregated result rides the ordinary SQL path for
paging/sort/CSV and its rows never touch the main thread. BigQuery dialect follows
its connector (M10).

### M6 — Dashboards & saved queries → API + multiple dashboards ✅
Saved queries + dashboards now persist to the multi-tenant DB (org-scoped) behind
the unchanged store seams:
- `/api/saved-queries[/id]` + `DbSavedQueryStore` + `ApiSavedQueryStore` (factory swapped).
- `/api/dashboards[/id]` + `DbDashboardStore` + `ApiDashboardStore`. `PUT` decomposes a
  `Dashboard` into a `dashboards` row + N `widgets` child rows in a txn and reassembles
  on GET. Widget ids are the app's stable `w_…` strings (schema: `widgets.id` → `text`),
  so persisted filter targets survive save.
- **Multiple dashboards**: `useDashboardList` (list + active-id + create/delete, seeds a
  first dashboard when empty) + a `DashboardList` switcher dropdown in the toolbar; the
  hardcoded `DEFAULT_DASHBOARD_ID` is gone (quick-add targets the most-recent dashboard).
- **One-time localStorage→server import** (`import-local.ts`, guard key) runs behind a
  bootstrap gate before the workspace mounts.
- Verified by a DB smoke (round-trip + cross-org read/write isolation) + typecheck/tests/build.

Deferred to M9 (where it's reused): extracting a shared read-only `DashboardView`.
Folders: schema + FK columns exist; folder CRUD UI deferred (no API surface yet).

### M7 — Widget visualization parity ✅
Built to the **dataviz** method — a validated categorical palette (`src/lib/viz/
palette.ts` + `--viz-*` CSS vars, light/dark, CVD-checked), fixed-order series
colors, a legend for ≥2 series, recessive grid/axes, hover tooltips, ink-token
text. NOTE: **no dual-axis** — that's a charting anti-pattern; `combo` is bar+line
on ONE shared scale.

**Pass A (done):** `WidgetViz` widened to a full config (all fields optional →
back-compat). A single multi-series renderer `VizChart` (bar incl. stacked &
100%-stacked, line, area, pie/donut, scatter/bubble, single-axis combo) fed by
`resultTableToChartData`; a `PivotTable` cross-tab; KPI goal/trend + conditional
value color; table conditional cell formatting (`ResultsTable.cellColor`); shared
`makeNumberFormatter` (plain/compact/currency/percent + decimals/prefix/suffix).
A `VizFormatPanel` (stacking, donut, combo line-series, legend, axis titles, y
scale, number format, conditional rules, KPI goal/trend, pivot column) mounted in
`AddWidgetDialog`; the type picker now offers all Pass-A types. Verified:
typecheck + 99 tests (incl. adapter/formatter/conditional) + build.

**Pass B (done):** the remaining Metabase/Data-Studio chart types, all routed
through `VizChart` so the query-panel preview and dashboard tiles render them
identically:
- **Gauge** (`GaugeChart`) — a 180° radial gauge (Recharts `RadialBarChart` +
  `PolarAngleAxis`) of a single value over `gaugeMin..gaugeMax` (auto: 0 → a
  nice-rounded max, or the goal); one hue for magnitude, a recessive track, an
  optional status color from conditional rules, and an optional goal readout.
- **Funnel** (`FunnelChartView`) — Recharts `Funnel`; fixed-order categorical
  hues per stage, name in ink beside the mark, value on the segment.
- **Waterfall** (`WaterfallChart`) — the invisible-base + visible-delta
  stacked-bar technique with a summing **Total** bar; increases `--viz-good`,
  decreases `--viz-critical` (gain/loss is a state), total a neutral hue, a
  legend + signed on-bar labels, ONE axis.
- **Geo map** (`GeoMap`, lazy via `GeoMapLazy`) — world-countries / US-states
  choropleth (`react-simple-maps` + bundled `world-atlas`/`us-atlas` topojson),
  single-hue sequential ramp keyed by a region-name column, no-data regions a
  neutral surface, hover tooltip + ramp legend. Code-split so its ~200KB of
  topojson + d3-geo never enter the main bundle (First Load JS unchanged).

Data extraction lives in `chart-data.ts` (`singleValue` for gauge, `categoryValues`
for funnel/waterfall/map). Format panel gains gauge range/goal, map basemap +
region column, and conditional formatting for the gauge value. The type picker
in `AddWidgetDialog` now offers all four. Verified: typecheck + 104 tests + build.

### M8 — Canvas mode ✅
Per-dashboard **grid ⇄ free-form canvas** toggle; grid stays the default and
switching is lossless (both layouts persist side-by-side). The M0 schema already
had the columns (`dashboards.layoutMode`/`canvas`, `widgets.kind`/`content`/
`canvasLayout`), so **no migration**.

**Pass A (done):**
- Types (`types/dashboard.ts`): `LayoutMode`, `CanvasLayout` (px + `zIndex`/
  `rotation`), `WidgetKind`, `ElementContent` union (`TextContent` live; image/
  shape/line typed for Pass B), `CanvasElement`; `Widget.canvasLayout?`,
  `Dashboard.layoutMode?`/`canvas?`/`elements?`. All optional → back-compat. The
  DB schema's loose aliases are replaced by these real types.
- `lib/dashboard/canvas.ts`: `gridToCanvas` (grid box → px, first-switch
  derivation), `ensureCanvasReady` (lossless, referentially stable), `nextCanvasY`,
  `defaultElement`.
- `useDashboard`: `setLayoutMode` (derives canvas boxes on first switch),
  `applyCanvasLayout` (widgets + elements, no re-query), `addElement`/
  `updateElement`/`removeElement`; add/duplicate seed a canvas box in canvas mode.
- `components/dashboard/canvas/` (lazy via `DashboardCanvasLazy`, `ssr:false` — it
  never enters SSR or the initial bundle): `CanvasStage` (react-moveable +
  react-selecto: drag/resize/rotate, snap-to-guidelines, marquee + shift multi-
  select, group transforms; geometry written to the DOM during the gesture and
  committed only on end, so moving a widget never re-runs its query — same
  contract as the grid), `TextElement` (inline-edit + typography), `CanvasToolbar`
  (add text, z-order, delete, text styling), `DashboardCanvas` (owns selection +
  keyboard delete). Non-query elements are a separate `CanvasElement` list, so the
  scheduler only ever sees query widgets.
- Persistence: localStorage/API stores JSON round-trip the new fields for free;
  `DbDashboardStore` decomposes query widgets **and** element rows (kind/content/
  canvasLayout) in its txn and reassembles both on read, and persists
  `layoutMode`/`canvas`. Verified: typecheck + 111 tests + build (canvas
  code-split; First Load JS unchanged).

**Pass B (done):**
- Decoration element kinds fleshed out: `ImageElement` (URL-referenced, contain/
  fill), `ShapeElement` (rect/ellipse, fill+stroke, on-palette default fill),
  `LineElement` (horizontal rule, rotate for diagonal/vertical) — routed in the
  `CanvasStage` element switch; per-kind default boxes in `defaultElement`.
- `lib/dashboard/align.ts` (pure, tested): `alignBoxes` (left/hcenter/right/top/
  vmiddle/bottom to the selection bbox) + `distributeBoxes` (equal gaps, extremes
  fixed, order-independent).
- `CanvasToolbar` extended: add text/image/shape/line, per-kind style controls
  (typography · image URL+fit · shape+fill+stroke · line stroke+width), and an
  align + distribute row for multi-selections (distribute needs ≥ 3).
- `DashboardCanvas` feeds the toolbar any single selected element + wires align/
  distribute onto `applyCanvasLayout`. Verified: typecheck + 119 tests + build.

### M9 — Sharing + embed ✅
**Compute decision (locked): snapshot sharing.** A share link freezes the
dashboard's computed results at share time; the public page renders that static
payload with NO client engine. This was chosen over live server-compute because
(a) **best cold-load performance** — `/public/[token]` is 296 kB First Load vs the
authed `/` at 472 kB, since DuckDB-WASM never ships to anonymous viewers;
(b) **universal coverage** — the server can only compute `postgres`/`mysql`
sources, but CSV/`file`/demo sources are client-only, so live server-compute
couldn't share them at all; (c) **tightest security** — public viewers never
touch the customer DB, never receive a `sourceId`/table/`sql`/`ir`. Trade-off:
data is frozen until re-shared (a "create link" re-captures). This is the plan's
listed "server-cached snapshot mode," promoted to primary.

**Pass A (done):**
- Types (`types/share.ts`): `PublicDashboard`/`PublicWidget` (secret-free shell),
  `DashboardSnapshot` (shell + per-widget `ResultTable`), `ShareLinkMeta`.
- Client capture (`lib/dashboard/snapshot.ts`): `projectPublicDashboard` (strips
  sourceId/sql/ir — unit-tested to prove nothing identifying serializes),
  `waitForResults`, `buildSnapshot`. `SnapshotScheduler` implements the
  `QueryScheduler` interface over the frozen result map, so `DashboardView`
  renders unchanged with no engine.
- Persistence: `share_links.snapshot` jsonb column (migration `0002`, generated —
  **apply with `db:migrate`**); `DbShareLinkStore` — `create`/`list`/`revoke`
  (org-scoped, editor role, verifies dashboard ownership) + `getPublicByToken`
  (the ONLY unauthenticated path; opaque 192-bit token = the capability; rejects
  revoked/expired). Routes: `POST|GET /api/dashboards/[id]/share`,
  `DELETE /api/share-links/[id]`, `GET /api/public/[token]` (no-store + per-token
  rate limit via `lib/server/rate-limit.ts`).
- UI: `ShareDialog` (create/copy/revoke, frozen-data note) + a Share button in the
  panel toolbar; **`DashboardView` extracted** (the deferred-from-M6 read-only
  render region, grid+canvas) and reused by both the authed panel and the public
  page; `(public)` route group (auth-free layout) + `/public/[token]` +
  `PublicDashboardView`. Verified: typecheck + 126 tests + build.

**Pass B (done):**
- `(public)/embed/[token]` — same frozen snapshot as `/public`, chrome-less
  (`PublicDashboardView embed`), meant for an `<iframe>`.
- Frame policy in `next.config.mjs` `headers()`: the embed route gets
  `Content-Security-Policy: frame-ancestors *` (override via `EMBED_FRAME_ANCESTORS`)
  so it iframes; **every other route** gets `X-Frame-Options: DENY` +
  `frame-ancestors 'none'` (a negative-lookahead source excludes `/embed` from the
  global rule so DENY never clobbers the embed's frame-ancestors).
- Audit log (`lib/server/audit.ts`, fire-and-forget, never breaks a request):
  `share.create` + `share.revoke` (actor = owner) and `share.view` (actor null —
  the token acts; logged against the link's org via `getPublicByToken`, with
  client IP). 
- Regression guard: a test asserts `SnapshotScheduler.getSnapshot` returns a
  STABLE reference (the `useSyncExternalStore` contract whose violation caused the
  public-page render loop). Verified: typecheck + 127 tests + build.

Deferred (optional later): a live share mode for DB-backed dashboards.

### M10 — Advanced builder v2 + connector breadth
Two independent tracks — builder-v2 compute (calc fields, windows, joins) and
connector breadth (HTTP-file / REST-API / BigQuery, SSH tunnel, credential
rotation, scheduled sync, folders).

**Pass A — calculated fields + window functions (done):**
- The IR already declared `calculated`/`windows` and the compiler already inlined
  calculated fields; this pass added **window compilation** + both **editors**.
- Compiler (`compile/compile.ts`): window functions compile in an OUTER `SELECT`
  over the base query (`SELECT *, <win> OVER(…) FROM (<base>) AS __base`), so they
  run post-aggregation and reference the base's OUTPUT columns. Supported:
  `row_number`/`rank`/`dense_rank`, running/windowed `sum`/`avg` (with a
  `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` running frame), `lag`/`lead`
  (row offset via `WindowSpec.arg`), `ntile` (bucket count via `arg`). Window refs
  validate against the query's output columns (`resolveOutput`), a distinct check
  from the source allowlist — no new injection surface. Standard SQL, so DuckDB /
  Postgres / MySQL-8 all take it; joins still throw (later pass).
- Draft (`ir-draft.ts`): `DraftCalc` (binary arithmetic over a column/number ×
  operator × column/number) and `DraftWindow`; `compileIrDraft` validates + emits
  `ir.calculated`/`ir.windows`; `irToDraft` hydrates both (lossy only for
  expressions richer than the two-operand editor); `outputNamesForDraft` mirrors
  the compiler's output-column set to drive the window pickers + validation.
- UI (`AdvancedQueryBuilder`): a **Calculated fields** section (name = a ⊕ b) and a
  **Window functions** section (fn · value column · partition · order+dir ·
  running · arg · alias), both live-validated. Verified: typecheck + 136 tests
  (+10, incl. compiler SQL golden + draft round-trip) + build.

**Pass B — joins (done):**
- Compiler (`compile/compile.ts`): `fromClause` builds `INNER/LEFT/RIGHT/FULL JOIN
  <table> AS <alias> ON …`; table-qualified column refs emit `"alias"."col"` (the
  column still validated against the allowlist). A new `allowedTables` compile
  option rejects a join to any table not introspected — the injection guard for
  the widened surface.
- Multi-table pushdown: `Connector.columnAllowlist()` (Postgres + MySQL) unions
  every table's columns; the `/run` route uses it + `allowedTables = schema.tables`
  only when the IR has joins. `chooseExecution` forces joins to PUSHDOWN (they
  can't run over a single resident local table).
- Draft/UI: `DraftJoin` (table · type · base key · joined key — base key stays
  unqualified since the server picks the base table name; joined key qualified by
  its table) + a **Joins** section in the builder. Verified: typecheck + 139 tests
  (+3, incl. join SQL golden + allowlist rejection) + build.

**Pass C — connectors + credential rotation (done):**
- **HTTP-file + REST-API connectors** (`connectors/http.ts`): fetch-once + cache,
  CSV (RFC-4180-ish parser) or JSON (array / wrapper-object / single-object),
  column-type inference; bounded `fetchRows`; `runCompiled` throws (no server SQL
  engine) and `chooseExecution` keeps them LOCAL. Registered in the factory; the
  add-source "preview" caveat removed. Pure parsers unit-tested (+5).
- **Credential rotation**: `DbSourceStore.rotateSecret` re-seals a new secret
  (AES-256-GCM), `PATCH /api/datasources/[id]` (editor role) + disposes the cached
  connector so new creds take effect; `useDataSources.rotateSource`; a "Rotate
  credentials" action reuses `AddSourceDialog` in a locked-kind rotate mode.
- Verified: typecheck + 144 tests + build.

**Deferred (require external infra / credentials I can't provision or verify here;
tracked as the remaining M10 tail):** BigQuery connector + dialect
(`@google-cloud/bigquery` + GCP creds), SSH tunnel (`ssh2` + a live tunnel),
scheduled schema sync (a job runner/cron), and the source-folders UI (the
`folders` table + `folderId` columns already exist; only CRUD wiring remains).

---

## Security notes carried through every milestone

- The `/run` endpoint accepts the **IR**, not SQL; identifiers are validated against
  the server-introspected allowlist (quote-doubled), values are always bound params,
  and expressions are a closed algebra — no user SQL text is ever emitted.
- Public share tokens can only reach the sources referenced by *their* dashboard;
  they cannot enumerate other sources or tables. Row cap + `statement_timeout` +
  per-token rate limit bound cost.
- Credentials are encrypted at rest and never leave the server.

See [security.md](security.md) and [gap-analysis.md](gap-analysis.md).

---

## Smaller carry-overs (still valid)

- **Cap signal for SQL results** — plumb a real "result was capped" flag from the
  worker so the table's `capped` note fires for large SQL results.
- **Builder sort by dimension** — subsumed by the IR's ordinal `order` model (M3+).
- **Row virtualization** for very wide/tall table pages.
- **Refresh the top-level [`README.md`](../README.md)** once the milestones land.
- **E2E + component tests** (Playwright / Testing Library) on top of the existing
  adapter unit tests.
</content>
