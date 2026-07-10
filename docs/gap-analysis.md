# Gap Analysis — Data Studio vs Metabase / Google Data Studio

A feature-by-feature capture of where the product stands today against the two
reference tools, across the four focus areas. This is the frozen analysis so the
codebase does not need to be re-explored each time — pair it with
[roadmap.md](roadmap.md) for the plan that closes each gap.

Legend: ✅ have · ⚠️ partial/stub · ❌ missing

---

## 1. Query builder

Today the visual builder ([`QueryBuilder.tsx`](../src/components/query/QueryBuilder.tsx))
compiles a loose draft into the strict Rust engine `Query`
([`analytics.ts`](../src/lib/types/analytics.ts)) via `compileQuery`
([`schema.ts`](../src/lib/query/schema.ts)). The engine
([`wasm/src/lib.rs`](../wasm/src/lib.rs)) does one pass:
`filter → group_by → aggregate → sort → limit`, single table, **one** aggregation,
**one** group-by. Everything richer lives only in raw SQL (DuckDB).

| Capability | Data Studio (today) | Metabase / GDS | Gap |
|---|---|---|---|
| Single-table filter/group/aggregate | ✅ | ✅ | — |
| Filter operators | ✅ eq/neq/gt/gte/lt/lte/contains/in_list | ✅ + between, null, starts/ends, relative-date, nested AND/OR | ❌ |
| Aggregations | ✅ sum/avg/count/min/max (one at a time) | ✅ + count-distinct/median/stddev, **multiple metrics** | ❌ |
| Group-by | ⚠️ exactly one dimension | ✅ multiple dimensions | ❌ |
| Date/temporal bucketing | ❌ (dates treated as strings) | ✅ hour/day/week/month/quarter/year | ❌ |
| Joins (multi-table) | ❌ SQL-only | ✅ visual join picker | ❌ |
| Calculated / custom fields | ❌ | ✅ expression editor | ❌ |
| Window functions / running totals | ❌ SQL-only | ✅ | ❌ |
| Having / post-aggregation filter | ❌ | ✅ | ❌ |
| Builder ⇄ SQL bridge | ✅ (`queryToSql`/`sqlToQuery`) | ✅ | — |
| Query pushdown to source DB | ❌ (always loads a slice, computes client-side) | ✅ native query on source | ❌ |
| Parameters / saved filters | ❌ | ✅ | ❌ |

---

## 2. Dashboard create (shareable, canvas-based)

Today: one hardcoded `default` dashboard, responsive 12-col grid
([`DashboardGrid.tsx`](../src/components/dashboard/DashboardGrid.tsx) via
`react-grid-layout`), persisted to localStorage
([`store.ts`](../src/lib/dashboard/store.ts)). Filter bar + cross-filters +
result-caching scheduler already exist.

| Capability | Data Studio (today) | Metabase / GDS | Gap |
|---|---|---|---|
| Grid layout, drag/resize | ✅ | ✅ | — |
| Free-form canvas (absolute, overlap, z-index, rotate) | ❌ grid only | ✅ (GDS) | ❌ |
| Text / image / shape / line elements | ❌ | ✅ (GDS) | ❌ |
| Multiple dashboards + folders | ❌ single `default` | ✅ | ❌ |
| Dashboard-level filters | ✅ 5 kinds | ✅ | — |
| Cross-filtering (click-to-filter) | ✅ | ✅ | — |
| Multi-level drill-down | ❌ (cross-filter only) | ✅ | ❌ |
| Share via link | ❌ | ✅ | ❌ |
| Public / embed view | ❌ | ✅ | ❌ |
| Permissions (view/edit) | ❌ | ✅ | ❌ |
| Scheduled refresh / email delivery | ❌ | ✅ | ❌ |
| Auth / multi-tenancy | ❌ single-user localStorage | ✅ orgs/workspaces | ❌ |

---

## 3. Dashboard widget create

Today: bar/line/table/kpi via Recharts + `@tanstack/react-table`
([`ResultsChart.tsx`](../src/components/results/ResultsChart.tsx),
[`ResultsTable.tsx`](../src/components/results/ResultsTable.tsx)). Configuration is
limited to source/title/viz-type/kpi-unit in
[`AddWidgetDialog.tsx`](../src/components/dashboard/AddWidgetDialog.tsx).

| Capability | Data Studio (today) | Metabase / GDS | Gap |
|---|---|---|---|
| Bar / line / table / KPI | ✅ | ✅ | — |
| Pie / donut | ❌ | ✅ | ❌ |
| Scatter / bubble | ❌ | ✅ | ❌ |
| Area, stacked & 100%-stacked bar | ❌ | ✅ | ❌ |
| Combo / dual-axis | ❌ | ✅ | ❌ |
| Gauge / funnel / waterfall | ❌ | ✅ | ❌ |
| Pivot table | ❌ | ✅ | ❌ |
| Geo map | ❌ | ✅ | ❌ |
| Series colors / palette | ❌ (fixed primary token) | ✅ | ❌ |
| Axis titles / scale / legend placement | ❌ | ✅ | ❌ |
| Number / date / currency / percent formatting | ⚠️ KPI unit only | ✅ | ❌ |
| Conditional formatting / thresholds | ❌ | ✅ | ❌ |
| Goal / trend indicators | ❌ | ✅ | ❌ |
| Table: sort, paginate, CSV export | ✅ | ✅ | — |
| Table: column hide/reorder, subtotals, row highlight | ❌ | ✅ | ❌ |
| Resize / move (edit mode) | ✅ | ✅ | — |

---

## 4. Add data source UI

Today: Postgres live; MySQL/HTTP-file/REST-API are creatable but their connectors
throw ([`connectors/index.ts`](../src/lib/server/connectors/index.ts)). Credentials
stored **plaintext** in `.data/datasources.json`
([`datasource-store.ts`](../src/lib/server/datasource-store.ts)). Client-side file
upload (CSV/Parquet/JSON) is fully working.

| Capability | Data Studio (today) | Metabase / GDS | Gap |
|---|---|---|---|
| Postgres | ✅ | ✅ | — |
| File upload (CSV/Parquet/JSON) | ✅ client-side | ✅ | — |
| MySQL | ⚠️ UI stub | ✅ | ❌ |
| HTTP-file | ⚠️ UI stub | ✅ | ❌ |
| REST-API | ⚠️ UI stub | ✅ | ❌ |
| BigQuery / Snowflake / Redshift / Mongo | ❌ | ✅ 50+ | ❌ |
| Connection test | ✅ | ✅ | — |
| Schema introspection + allowlist | ✅ (Postgres) | ✅ | — |
| Credential encryption at rest | ❌ plaintext JSON | ✅ vault | ❌ |
| Credential edit / rotate | ❌ delete+re-add | ✅ | ❌ |
| SSH tunnel / bastion | ❌ | ✅ | ❌ |
| Per-source multi-table picker | ⚠️ default table only | ✅ | ❌ |
| Scheduled schema sync | ❌ manual refresh | ✅ | ❌ |
| Source folders / groups | ❌ flat list | ✅ | ❌ |
| Row cap + per-request timeout | ✅ | ✅ | — |
| Connection pooling | ✅ (pg.Pool per source) | ✅ | — |
| OAuth / IAM / service accounts | ❌ | ✅ | ❌ |
| Connection / access audit log | ❌ | ✅ | ❌ |

---

## Architectural strengths to preserve

These are why the app is fast and safe; every gap-closing change must keep them:

- **React never holds raw rows** — data lives in the Rust/WASM + DuckDB workers;
  persisted entities hold definitions only. See [architecture.md](architecture.md).
- **Credentials server-side only** — `DataSourceMeta` is the only thing that
  crosses to the client. See [security.md](security.md).
- **Pluggable store seams** — `DashboardStore` / `SavedQueryStore` / `SourceStore`
  are swapped at their factory singletons without touching components.
- **Layout edits never re-query** — grid (and the future canvas) only persist
  layout boxes; the scheduler ignores them.
- **Arrow IPC wire format** + local-first compute keep the UI at 60 FPS on
  200k-row datasets.
</content>
