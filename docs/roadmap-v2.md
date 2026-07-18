# Roadmap v2 — M11–M15 (Metabase × Looker Studio convergence)

Continuation of [roadmap.md](roadmap.md) (M0–M10). Product thesis: combine
Metabase's query-builder depth (notebook editor, drill-through, models) with
Looker Studio's free-form report design — differentiated by client-side WASM
compute (zero server compute, instant drill-through, data privacy) and a
Figma-grade canvas mode with frames that neither competitor offers.

Grounded in a full audit of the current codebase (2026-07-12) and the Metabase
query-builder docs. Findings referenced inline.

---

## M11 — Foundation fixes + Supabase design system (1–2 weeks)

### A. Bug: data sources lost on refresh

Root cause: server-side sources (postgres/mysql/http-file/rest-api) persist
correctly via the Drizzle `DbSourceStore`. **File-upload sources exist only in
React state**: `useDataSources.addFileSource` (src/hooks/useDataSources.ts:251)
keeps the `File` handle in a `useRef` Map and the metadata in `localSources`
state — nothing is written anywhere durable, so a refresh wipes them.

Fix (no server changes needed):
- [ ] New client store `src/lib/sources/local-store.ts` following the existing
      swappable-store seam pattern, backed by **IndexedDB** (structured clone
      persists `File`/`Blob` natively — store `{id, name, file}` rows).
- [ ] `useDataSources`: hydrate `localSources` + `fileHandles` from IndexedDB on
      mount; write-through in `addFileSource`; delete in `removeSource`.
      `activate` already lazily calls `engine.loadFile(file)`, so worker
      re-registration works unchanged after reload.
- [ ] Persist `activeId` (localStorage) and re-activate on boot.
- [ ] UX: make the active workspace/org obvious — sources are org-scoped, so an
      org switch "losing" sources must not read as a persistence bug.

### B. Quick wins / stub cleanup

- [ ] SQL editor Limit select is display-only — wire it into `runSql`
      (SqlEditorView.tsx:48).
- [ ] ⌘↵ Run hint is cosmetic — bind Mod-Enter in CodeMirror.
- [ ] Saved `execution` preference is persisted but not restored on open
      (useQueryWorkspace.ts:419) — restore into the toggle.
- [ ] Delete dead code: `QueryBuilder.tsx`, `FilterRow.tsx` (or adopt
      `MultiValueInput.tsx` for in/not_in filters instead of comma-split text).
- [ ] Fix stale comment compile.ts:14 (joins/windows ARE compiled). Remove or
      implement the `bigquery` DialectId stub.

### C. Supabase design system

Current state: tokens are already Supabase-leaning (brand green #3ECF8E dark,
Inter, 6px radius); `button.tsx` is a faithful @supabase/ui clone. Gaps, in
leverage order:

- [ ] **Token layer** (globals.css + tailwind.config.ts): add a gray *scale
      ramp* (`scale-100…1200`) and surface tiers (`surface-100/200/300`,
      `border-muted/default/strong/stronger`) — Supabase Studio drives
      everything off these. Raise dark background from #121212 (7%) to **#1c1c1c
      (11%)** with panels ~#232323. Add tinted badge tokens.
- [ ] **Primitives rework**: `input`/`select` → filled control surface, no
      shadow, heights matched to the new button ramp (34px sm); `tabs` →
      underline style (transparent list, 2px brand underline); `card` →
      rounded-md, 1px border, shadowless; `dialog` → bordered header/footer
      sections, smaller radius; `table` → dense `text-xs`, `h-8` rows, mono data
      cells, surface-filled header; `badge` → tinted surface + colored text;
      `dropdown-menu` → compact text-xs items.
- [ ] **Missing primitives**: checkbox, switch, radio-group, textarea, label,
      tooltip, popover, separator, sheet, skeleton, scroll-area, toast (sonner).
- [ ] **Focus unification**: the button's 2px brand `outline` pattern applied to
      all interactive primitives (inputs still use shadcn `ring-1`).
- [ ] **Feature surfaces**: ResultsTable/PivotTable (dense grid treatment),
      SchemaTree (in progress), DataSourcesView, AddSourceDialog, HomeView,
      CommandMenu, SqlSidebar, VizFormatPanel.

---

## M12 — Query Builder 2.0: the notebook editor (3–4 weeks, highest priority)

The audit's headline: **the IR is well ahead of the UI.** Having, offset,
OR/NOT filter groups, expression functions (case/concat/date_trunc/…),
multi-condition joins, multi-key sort, aliases — all compile and are tested,
but unreachable from the UI, and `irToDraft` silently drops them.

### Stage 1 — Close the IR↔UI gap (pure UI work, IR untouched)

- [ ] Filter **groups**: nested AND/OR/NOT tree UI (IrDraft currently flattens
      to AND-only and drops groups — ir-draft.ts:735).
- [ ] **Having** step (post-aggregation filter) — IR + compiler already done.
- [ ] **Sort**: multi-key, sortable by dimension/column (today: single metric
      ordinal only).
- [ ] Dimension/aggregation **aliases**.
- [ ] **Joins**: replace free-text table/column inputs with pickers backed by
      introspected schema; support multi-condition joins (IR supports, draft
      hydrates only `on[0]`).
- [ ] **Window functions**: multi-column partition/order.
- [ ] **Expression editor** for calculated fields: Metabase-style formula bar
      with `[Column]` refs, autocomplete, and the full Expr algebra (binary ops,
      8 fns, `case`) — today's UI is a single `a <op> b` row.
- [ ] Make `irToDraft` lossless for everything the new UI can express; warn
      (don't silently drop) on anything it can't.

### Stage 2 — Notebook UX (Metabase editor parity)

- [ ] **Step pipeline UI**: Data → Join → Custom column → Filter → Summarize →
      Sort → Limit as visible, reorderable blocks (replacing the single stacked
      form).
- [ ] **Per-step preview**: first 10 rows up to that step — cheap on LOCAL
      (compile the IR truncated at the step, run on DuckDB).
- [ ] **Column picker on the data step** (raw-mode `fields` selection — needs a
      small IR addition: `fields?: FieldRef[]` for unaggregated queries).
- [ ] **SchemaTree upgrade**: search, click-to-add / drag-into-step, field
      profile popover (distinct count, min/max, null% — one cheap DuckDB query),
      multi-table view.
- [ ] **Auto chart suggestion** from result shape (1 dim temporal → line; 1 dim
      categorical → bar; 2 dims → stacked/grouped; no dims → KPI).

### Stage 3 — New IR capabilities

- [x] **Numeric binning** on dimensions (fixed width): `Dimension.bin =
      { width }` → `floor(x/width)*width` (lower edge), aliased `<col>_bin`,
      exclusive with `temporal`, numeric columns only. Draft input is a "bin
      size" number on numeric dimensions; round-trips via irToDraft. Golden
      tests × 3 dialects. *(Range-based "auto bin count" still open — needs a
      min/max pre-query.)*
- [x] **New aggregations**: `variance` (var_samp), `percentile` (quantile_cont
      on DuckDB / percentile_cont WITHIN GROUP on Postgres; MySQL rejects),
      `count_if` / `sum_if` (aggregation-level filter, compiled uniformly as
      `count/sum(CASE WHEN <cond> THEN …)` — predicate literals INLINED so an
      agg re-emitted in HAVING can't desync bound params). Percentile takes a
      0–1 or 0–100 input; count_if/sum_if take a single-condition editor.
      Golden + draft round-trip tests. *(Cumulative sum/count already covered by
      running-frame window functions.)*
- [x] **Multi-stage queries** (the big one): summarize → filter/summarize
      again. `QuerySource` is now a union — `{ table }` or `{ query: QueryIR }`
      (a nested subquery); `compileIR` recurses via `compileQuery` (per-level
      ctx SHARING the params array so bound params stay in emission order) and
      `fromClause` emits `(<inner sql>) AS <alias>`. The draft gains
      `nextStage?: IrDraft`; `compileIrDraft` nests stage 1 as the subquery
      source (dropping its limit/offset) and compiles stage 2 over
      `stageOutputFields` (synthesized output schema); `irToDraft` unwraps it.
      UI: `StagesEditor` in `/editor` reuses the whole builder for stage 2
      (fields = stage-1 output) with an "Add a stage" affordance. **LOCAL only**
      — `chooseExecution` + `canPushdown` force local and the `/run` endpoint
      rejects a nested source (pushdown rewrites `source` to a physical table,
      which would flatten the nesting). LOCAL allowlist switched from
      `allowlistFromFields` to `irColumns(ir)` so stage-output columns resolve.
      Golden tests × 3 dialects + draft round-trip tests. *(Reordering stages /
      3+ stages / cross-source joins in a stage still open.)*
- [ ] **Saved query as data source** (query-as-source) — after stages.

### Stage 4 — Chart editing everywhere ✅ (done)

- [x] `ChartSettings` mounts `VizFormatPanel` + the full 13-type picker in the
      Chart tab's "Customize" panel on both `/editor` and `/sql`
      (ResultsRegion, wired via `onVizChange`), bound to the RESULT's columns
      and live-updating.
- [x] Axis/series assignment (`xKey`/`yKeys`), per-series rename
      (`seriesLabels`) + per-series color picker (`viz.colors`).
- [x] Data labels, reference line, axis min/max, Y scale (linear/log),
      number-format prefix/suffix/decimals/style, conditional formatting.
- [x] Dropped series disclosed in `VizChart` when the series count exceeds the
      palette cap.

### Stage 5 — Drill-through (Metabase's killer feature, cheap for us on LOCAL)

- [ ] Column-header menu in results: filter by column, sort, **distribution**
      (instant histogram), sum/avg, distinct values.
- [ ] Cell click: filter by this value; **view underlying records** for an
      aggregated cell; break out by category/time.
- [ ] Chart point click: filter, view records, **temporal zoom** ("see this
      month by week"), drag range-select on continuous axes to filter.
- [ ] All implemented as IR rewrites executed LOCAL — instant, no server
      round-trip; this is where client-side compute visibly beats Metabase.

### Stage 6 — SQL editor pro ✅ (done)

- [x] `{{variable}}` parameters rendering typed filter widgets (text/number/
      date, safe literal rendering), `[[optional clause]]` brackets —
      `src/lib/query/sql-template.ts` + widgets bar in SqlEditorView.
- [x] SqlSidebar sections made real: FAVORITES (client-side star flag,
      localStorage) + REFERENCE (canned templates incl. variable examples).
      The saved-query list is already org-scoped server-side, so the fake
      SHARED stub was removed rather than duplicated. *(Deferred: per-user
      private vs shared split — needs `createdBy` on summaries.)*
- [x] Run selection (⌘↵ runs the highlighted text), SQL formatter
      (sql-formatter, duckdb dialect, template markers preserved), query
      cancel (immediate promise rejection + best-effort DuckDB interrupt).
- [x] **"Explore results"**: the SQL result set is promoted into its own
      DuckDB table (`promote` worker message) and the IR builder opens over
      it — drill-through included. Transient session (not saveable), exits
      back to the statement.
- [x] **View SQL / Convert to SQL** from the builder: ⋯ → View SQL shows the
      compiled+formatted statement; "Edit as SQL" is the one-way convert.

---

## M13 — Dashboards: Page view + Canvas view as first-class modes (3–4 weeks)

Split dashboard creation into two explicit types at create time:
**Page** (Metabase-style grid document) and **Canvas** (Figma-style free-form
with frames). `layoutMode` already exists in the schema; keep the lossless
toggle as a power-user "convert" action rather than the primary mental model.

- [x] **Create-time split**: CreateDashboardDialog (name + Page/Canvas cards);
      `layoutMode` through POST /api/dashboards + both stores; type icons in
      the switcher; the toolbar toggle replaced by ⋯ → "Convert to canvas/page"
      (lossless, `ensureCanvasReady`/`ensureGridReady` prime placements).

### A. Page view (Metabase parity)

- [x] **Tabs** — `dashboards.tabs` jsonb + `widgets.tab_id` (migration
      `0003_lumpy_lucky_pierre.sql`, generated — run `pnpm db:migrate`). Tab bar
      (`DashboardTabs`, grid mode): add/rename (dblclick)/remove, first "Add
      tabs" wraps existing content into Tab 1 + an empty Tab 2; removing the
      2nd-to-last collapses back to a clean single page. New/duplicated/pasted
      items land on the active tab and place within it. `tabId` semantics live
      in `src/lib/dashboard/tabs.ts` (untabbed item → first tab; tested).
      Off-tab widgets aren't mounted, so **only the active tab's widgets run**
      (compounds with viewport-lazy). Public/embed carries tabs (view-only bar);
      `buildSnapshot` now force-submits every widget so off-tab/off-screen tiles
      are still captured. Canvas mode ignores tabs (one surface).
- [x] **Text cards in grid mode** — `CanvasElement.layout` (grid box) persists
      via `widgets.grid_layout`; GridTextCard (double-click edit, hover
      drag/edit/delete); "Text" toolbar button; renders on public/embed via the
      shared DashboardView. *(Markdown rendering still TODO — plain styled text
      today.)*
- [x] **Filters upgrade**: persisted `default` values on load (provider keyed
      by dashboard id; no cross-dashboard leakage). **URL param sync**
      (`?f.<id>=<json>`, `src/lib/dashboard/filter-url.ts` — pure, tested;
      `urlSync` on the authed panel seeds from + writes to the URL via
      replaceState; off for public/embed; locked filters excluded).
      **required/locked params**: `DashboardFilter.required` (can't clear —
      resets to default; empty state flagged) + `locked` (pinned to default,
      read-only in the bar, never URL-overridable). **Auto-wire by column**:
      "Map to all widgets" in the filter editor maps one column across every
      widget. Default-value editor (shape by kind) added to the dialog.
      *(Deferred: gating a widget's run while a required filter is empty —
      required filters usually carry a default, so rarely empty.)*
- [x] Auto-refresh interval per dashboard (30s–15m, visibility-aware, persisted
      client-side — move into a `settings` jsonb with the tabs migration);
      fullscreen/TV mode (toolbar hidden, Esc exits).
- [x] Duplicate dashboard (deep copy; widget/element ids re-minted — global PK
      — and filter targets remapped).
- [x] Click behavior config per widget: cross-filter (default) / **custom URL**
      with `{{value}}`/`{{column}}` templating (new tab optional) / **go to
      dashboard** (seeds a target filter via `?f.<id>` and lands there through a
      full nav). `Widget.clickBehavior`; pure dispatch in
      `src/lib/dashboard/click-behavior.ts` (tested); configured in the widget
      dialog; persisted in the widget `definition` jsonb. `useDashboardList` is
      now URL-aware (`?d=<id>`) so links + reloads land on the right dashboard.
- [x] Export: **PNG per widget** (Download button on every tile) + **PDF per
      dashboard** (⋯ → Export PDF, paginated vertically). Client-side only —
      `src/lib/dashboard/export.ts` rasterizes the DOM node with `html-to-image`
      and lays it into `jspdf` (dynamically imported); controls are marked
      `data-export-ignore` so they're stripped from the capture. ⚠ needs a
      browser pass to eyeball capture fidelity; jspdf/html-to-image add to the
      dashboard chunk (flag for the M14 bundle budget). *(Per-frame canvas
      export still open.)*

### B. Canvas view (Figma-like)

Foundation already in place: px `CanvasLayout` with zIndex+rotation, Moveable
drag/resize/rotate incl. group gestures, Selecto marquee, element snapping,
align/distribute, DOM-direct gestures with commit-on-end.

- [x] **Frames/artboards**: named frames (`CanvasConfig.frames` — lives in the
      existing `canvas` jsonb, no migration). Membership is DERIVED by geometry
      (item center inside frame) instead of a persisted `frameId`, so dragging
      an item out needs no bookkeeping. Frame label: click-select, dblclick
      rename; dragging a frame carries its members (DOM-direct, commit on end);
      resize adjusts the frame only; delete keeps items. Renders read-only on
      public/embed (canvas config already flows through snapshots).
- [x] **Pan/zoom viewport** (`CanvasViewport`): wheel = pan, ⌘/Ctrl+wheel or
      pinch = zoom-to-cursor (10%–400%), Space/middle-mouse drag = hand pan,
      bottom-right − % + Fit cluster. Camera is a ref applied straight to CSS
      transform — zero React re-renders per frame; Moveable resolves gesture
      deltas through the ancestor matrix. ⚠ needs one manual browser pass
      (drag/resize accuracy while zoomed).
- [x] **Layers panel** (`CanvasLayersPanel`, toggle in the canvas toolbar):
      items listed top-most-z first, then a Frames section; click / shift-click
      selects (two-way bound to the stage), double-click renames (frame name /
      widget title), per-row lock + hide toggles. `locked`/`hidden` live on
      `CanvasLayout` + `CanvasFrame` (no migration — inside existing jsonb).
      Hidden items don't render (a hidden query widget also stops running);
      locked items drop the `.canvas-item` hook (Selecto ignores) and are
      excluded from Moveable targets even when selected via the panel.
      *(Explicit drag-reorder still TODO — front/back covers z-order for now.)*
- [x] **Persisted groups**: `CanvasLayout.groupId` (rides the `canvas` jsonb, no
      migration). "Group" (⌘G) mints a fresh id onto every selected non-frame
      item; "Ungroup" (⌘⇧G) clears the whole group (`useDashboard.groupItems`/
      `ungroupItems`). Selecting any member expands to the whole group
      (`expandGroups` in DashboardCanvas), so drag/resize move as one via the
      existing Moveable group gesture. Toolbar Group/Ungroup buttons + a group
      badge in the layers panel. Geometry commits now MERGE onto the existing box
      (`applyCanvasLayout`) so a drag never drops `groupId`/`locked`/`hidden`;
      paste remaps copied groupIds to fresh ones (no merge into the source group).
- [x] **Undo/redo**: snapshot history in `useDashboard` (cap 50, coalescing
      keys so typing/color-drags = one entry, StrictMode-safe, covers EVERY
      dashboard edit incl. grid + filters); ⌘Z/⌘⇧Z + toolbar buttons.
      **⌘D duplicate** (widgets + elements; elements get `duplicateElement`)
      and **arrow-key nudge** (1px, Shift=10px; frames included) on the canvas.
      **Clipboard copy/cut/paste** (⌘C/⌘X/⌘V) across dashboards + reloads:
      `src/lib/dashboard/clipboard.ts` (module mirror + localStorage, serializable
      widgets/elements only, never rows); `pasteItems` re-mints ids, offsets
      +24px, and selects the pasted items. Frames aren't copied (containers).
- [x] Rulers/guides, optional snap-to-grid, canvas background/size UI.
      ✅ **Canvas settings popover** ("Canvas" button, toolbar right) editing
      surface **size** (W/H) + **background** (now wired) + grid/ruler helpers,
      all on `CanvasConfig` (persisted in the `canvas` jsonb; `useDashboard.updateCanvas`,
      coalesced under one undo key). ✅ **Alignment grid**: CSS-gradient overlay
      on the stage (edit mode only) + **snap-to-grid** via Moveable
      `snapGridWidth/Height` (`gridSize`, default 8). ✅ **Rulers**: DPR-aware
      top/left `<canvas>` strips in `CanvasViewport`, painted imperatively from
      `apply()` so pan/zoom stays zero-re-render (nice-step ticks, camera-synced,
      `pointer-events-none` so they never block the stage). Element-to-element
      guides already existed (Moveable `elementGuidelines`).
- [~] **Element upgrades**: ✅ **markdown text** (headings/lists/links/bold/
      italic/code via a tiny dependency-free, XSS-safe renderer —
      `src/lib/dashboard/markdown.tsx`, link schemes allowlisted, tested;
      "MD" toggle on the text element). ✅ **shape** radius/opacity/shadow/border
      width. ✅ **line** dash (solid/dashed/dotted, native CSS border) +
      start/end arrowheads (CSS triangles). New fields ride the existing
      `content` jsonb (no migration) and flow to public/embed. *(Still open:
      image UPLOAD — needs an org asset store; URL-only for now.)*
- [x] **Per-frame export (PNG)** + **present mode**. ✅ `exportFrameToPng`
      (`src/lib/dashboard/export.ts`) rasterizes the stage ONCE and crops to the
      frame's logical box (frames don't contain their items in the DOM), measured
      pixel-ratio → correct at any DPR; the shared capture filter now also drops
      react-moveable/selecto control boxes + the grid overlay
      (`data-export-ignore`). Hover-reveal export button on each frame's label.
      ✅ **Present mode** (`CanvasPresent.tsx`): full-screen frame-by-frame
      slideshow reusing `CanvasStage` in VIEW mode (widgets stay live via the
      scheduler; renders inside the dashboard tree so the filter context flows),
      fit-to-frame transform, ←/→/Space/Esc + a control bar; no frames → the whole
      canvas is one slide. Launched from the toolbar "Present" button.
      *(Share of a single frame image → deferred with image UPLOAD, needs backend.)*

### C. Dashboard engine performance

- [x] **Viewport-lazy loading**: `DashboardWidget` gates its first submit behind
      an IntersectionObserver (`useHasBeenVisible`, 300px rootMargin) — a
      40-widget dashboard no longer fires 40 queries into the serial worker on
      load; only on-screen tiles run, off-screen ones wait until scrolled/panned
      near. A filter change while off-screen is deferred to the next time the
      tile is visible. Works in grid + canvas (transforms are IO-aware); falls
      back to eager where IntersectionObserver is absent (SSR/test).
- [x] Result cache: TTL + LRU size cap (`SchedulerConfig` — default 100 entries,
      5-min TTL, injectable clock). `cacheGet` drops stale entries + refreshes
      LRU recency; `cachePut` evicts the oldest beyond the cap. Tested
      (eviction + TTL expiry).
- [ ] **PUSHDOWN for dashboard widgets** on live sources (scheduler is
      LOCAL-only today; `chooseExecution` is a query-panel concern). Bigger:
      needs the resolver to expose source kind + a per-widget ingest dataset
      (residency is per-source today) — deferred as its own change.
- [ ] Filter merge: replace string-escaped literals with bound params where the
      execution path allows (filters.ts:225 documents the DuckDB limitation —
      revisit; DuckDB-WASM now has prepared statements).

---

## M14 — Performance hardening (continuous, gate per milestone)

Non-negotiable invariants stay: React never holds raw rows; layout edits never
re-query; one dataset crossing into the worker.

- [ ] Bundle budget + @next/bundle-analyzer in CI; route-level code splitting
      audit (canvas is lazy; verify recharts/codemirror/duckdb chunks).
- [ ] ResultsTable row virtualization (tanstack-virtual) for large pages.
- [ ] Query concurrency: move the scheduler from strict serial to a small pool
      using multiple DuckDB-WASM connections (respecting the Rust engine's
      single-active-dataset constraint via the existing builder batching).
- [ ] `useSyncExternalStore` stable-snapshot audit (known footgun in repo).
- [ ] Lighthouse CI + web-vitals reporting; interaction budget for canvas
      (60fps) and builder keystroke→validation latency.

---

## M15 — Production readiness

### Data integrity
- [x] Optimistic locking on dashboards. `dashboards.version` counter (migration
      `0004`); `save(ctx, dashboard, expectedVersion?)` bumps it in one atomic
      UPDATE whose WHERE carries the version guard (check + write can't race) —
      a mismatch throws `ConflictError` (→ 409 via `errorResponse`, now 4xx
      pass-through) instead of clobbering. Client echoes the version on every
      save (held in a ref → no autosave loop), stashes the returned version;
      `ApiDashboardStore` throws `DashboardConflictError` on 409. `useDashboard`
      exposes `conflict` (pauses autosave) + `resolveConflict("reload" |
      "overwrite")`; DashboardPanel shows a "changed elsewhere" banner with
      Reload theirs / Keep mine. Tested (errorResponse status mapping). *(Rename
      PATCH still force-saves — low-conflict; a partial PATCH API is the next item.)*
- [~] Partial PATCH API for dashboards (widget-level) instead of full PUT.
      ✅ **Server-side diff save** — the PUT transaction no longer delete-all +
      re-inserts every widget on each autosave; it now DELETEs only rows no longer
      present (`notInArray(keepIds)`) and UPSERTs the current set
      (`onConflictDoUpdate` on the widget id, `excluded.*`). Unchanged widgets keep
      their row identity + `createdAt`; a 40-widget dashboard where one tile moved
      does 1 targeted delete-scan + upserts instead of 40 deletes + 40 inserts.
      Client contract unchanged (still sends the full dashboard). *(A true
      client-side delta protocol — dirty-tracking + per-widget versioning to also
      cut conflict scope — remains open; the upsert delivers the efficiency win
      without that risk.)*

### Security
- [x] Rate limiting on all mutation routes (was: only public token path).
      `mutationRateLimit(ctx)` (`api-helpers.ts`) — per-user fixed-window backstop
      reusing `rate-limit.ts`, applied after auth in every POST/PUT/PATCH/DELETE
      across the 11 API route files (datasources incl. run/test, saved-queries,
      dashboards incl. share, share-links, orgs). Generous ceilings so legit heavy
      use never trips (240/min default; 600/min for the autosave PUT + query
      `/run` hot paths); returns 429. Tested. *(Per-process, like the public
      limiter — a shared store for a global quota stays out of scope.)*
- [ ] `share_links.permission = "edit"` is dead schema — implement or drop.
- [ ] Dashboard filter SQL merge → bound params (see M13-C).
- [~] CSP headers; dependency audit in CI; `DATA_STUDIO_ENC_KEY` rotation
      runbook.
      ✅ **CSP + security headers** (`next.config.mjs`): baseline hardening
      (`X-Content-Type-Options`, `Referrer-Policy`, HSTS, `Permissions-Policy`,
      `X-DNS-Prefetch-Control`) enforced on every route; the existing
      `frame-ancestors` clickjacking rule kept in its own enforcing header
      (embed `*` / everything else `'none'`). A full content policy
      (`default-src 'self'`; `script-src` with `'wasm-unsafe-eval'`+`blob:` for
      the WASM/DuckDB workers; `connect-src https: wss:` for client-side
      connectors; `img-src data: blob: https:`; `worker-src blob:`) ships as
      **`Content-Security-Policy-Report-Only` by default** — enforcement is
      opt-in via `CSP_ENFORCE=1` after a browser pass confirms no false
      positives (documented in `docs/security.md`). *(Dependency audit in CI +
      enc-key rotation runbook still open.)*

### Testing & CI
- [ ] CI pipeline: lint → typecheck → vitest → `pnpm exec next build` (without
      wasm-pack, per CLAUDE.md) → migration check.
- [ ] Playwright e2e for the critical path: add source → build query → save →
      add to dashboard → share → public view.
- [ ] Golden compile tests for every new IR feature × 3 dialects.

### Observability & ops
- [ ] Sentry (client + server), structured request logging, `/api/health`.
- [ ] Dockerfile + compose for deploy; env validation at boot (zod).
- [ ] DB backup/restore runbook; migration gate in CI.

### Product polish
- [~] Error boundaries + empty states + skeletons everywhere. ✅ Reusable
      `ErrorBoundary` (`src/components/ui/error-boundary.tsx`, `resetKeys`
      auto-recovery, tested) wrapping **each dashboard widget body** (a chart that
      throws on malformed data shows an inline "Try again" card instead of
      crashing the dashboard; auto-resets when result/viz changes) and **each
      canvas element**. Next.js route boundaries: `(app)/error.tsx`,
      `(public)/error.tsx`, root `global-error.tsx` (self-contained inline styles).
      *(Empty states + skeletons already exist in results/widgets; a broader
      skeleton/empty-state sweep across remaining surfaces still open.)*
- [x] User invitations + role management UI (AuthContext roles exist).
      New `invitations` table (migration `0005`, run `pnpm db:migrate`) +
      `member-store.ts` (org-scoped, admin-gated): list/change-role/remove
      members and create/list/revoke/accept invites. Pure role rules in
      `lib/types/members.ts` (unit-tested: owner acts on anyone, admin on
      everyone-but-owners, assignable-role matrix); DB-dependent guards in the
      store (last-owner can't be demoted/removed, no self-modify, admins can't
      touch owners). Invites are **link-based** (no mailer wired — the admin
      copies an opaque-token accept link); `acceptInvite` binds redemption to the
      invited email. Routes: `/api/orgs/members[/id]`,
      `/api/orgs/members/invites[/id]`, `/api/invites/[token]` (GET preview +
      POST accept). UI: admin-gated `/members` page (`MembersView` — inline role
      selects + remove + invite form) and a public `/invite/[token]` accept page
      that round-trips through login via `?callbackUrl` and switches org on
      accept. Admin-gated nav in `IconRail` + `CommandMenu`. Actions audit-logged
      (`member.invite`/`role_change`/`remove`/`invite_revoke`/`join`). *(Email
      delivery of invites still needs a mailer — deferred with observability.)*
- [x] Audit log viewer for admins. Read-only viewer over the existing
      fire-and-forget audit log (share create/revoke/view + any future action).
      `canAdmin`/`assertCanAdmin` (owner+admin) gate in `db/scope.ts`; client-safe
      `AuditLogRecord`/`AuditLogPage` + a pure `parseAuditListParams` (unit-tested)
      in `lib/types/audit.ts`; `listAudit` (org-scoped, keyset-paginated on the
      bigserial `id`, actor left-joined from `users`) + `listAuditActions` in
      `server/audit.ts`; `GET /api/audit-log` (page + `?actions=1` filter chips,
      403 for non-admins); `AuditLogView` + `/audit` route (LogsView-style dense
      rows, action-filter rail, "Load more"); admin-gated nav entry in `IconRail`
      + `CommandMenu`.
- [ ] Onboarding checklist (connect source → first query → first dashboard →
      first share).

---

## Sequencing recommendation

1. **M11** now — the bug is user-visible trust damage; the design system
   unblocks all subsequent UI work from being restyled twice.
2. **M12 stages 1–2, 4–5** — builder gap-close, notebook UX, chart editing,
   drill-through. Highest product value per effort (much of it is UI over an IR
   that already works).
3. **M13** — page/canvas split, frames, dashboard perf.
4. **M12 stage 3** (multi-stage IR) — heavy, well-isolated; can run in parallel
   with M13 or after.
5. **M14/M15** — continuous gates, with a final ~2-week production push.

Rough total: ~3–4 months to a production-grade release.
