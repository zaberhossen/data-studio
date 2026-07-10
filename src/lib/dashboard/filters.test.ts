/**
 * Cross-filter correctness tests — verifying both core invariants.
 *
 * Invariant 1: a base widget's stored QueryDefinition is byte-identical before
 *   and after any filter is applied + cleared (deep-equal via JSON).
 *
 * Invariant 2: changing a filter only produces a new cache key for widgets that
 *   are in the filter's targets; widgets NOT targeted retain the same cache key
 *   (and therefore get a scheduler cache hit, not a re-run).
 *
 * Additional coverage: builder predicate merge, SQL subquery wrap, cross-filter
 * loop guard, and SQL column-skip for unknown columns.
 */

import { describe, expect, it } from "vitest";
import { buildEffectiveWidget } from "./filters";
import { widgetCacheKey } from "./hash";
import type {
  ActiveFilters,
  CrossFilter,
  DashboardFilter,
  Widget,
} from "@/lib/types/dashboard";
import type { Query } from "@/lib/types/analytics";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let seq = 0;

function makeBuilderWidget(overrides: Partial<Widget> = {}): Widget {
  seq++;
  const q: Query = { group_by: "region", aggregation: { func: "count" } };
  return {
    id: `w${seq}`,
    title: `widget ${seq}`,
    sourceId: "demo",
    queryKind: "builder",
    query: q,
    viz: { type: "bar" },
    layout: { x: 0, y: 0, w: 6, h: 6 },
    ...overrides,
  };
}

function makeSqlWidget(sql = "SELECT region, COUNT(*) AS cnt FROM dataset GROUP BY region"): Widget {
  seq++;
  return {
    id: `w${seq}`,
    title: `widget ${seq}`,
    sourceId: "demo",
    queryKind: "sql",
    sql,
    viz: { type: "table" },
    layout: { x: 0, y: 0, w: 6, h: 6 },
  };
}

function makeFilter(widgetId: string, column: string, kind: DashboardFilter["kind"] = "select"): DashboardFilter {
  return {
    id: `f-${widgetId}-${column}`,
    label: column,
    kind,
    targets: [{ widgetId, column }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 1 — base query NEVER mutated
// ─────────────────────────────────────────────────────────────────────────────

describe("Invariant 1 — persisted widget is byte-identical after filter apply + clear", () => {
  it("builder widget: query is deep-equal after applying a select filter", () => {
    const w = makeBuilderWidget();
    const before = JSON.stringify(w);

    const f = makeFilter(w.id, "region");
    const af: ActiveFilters = { [f.id]: "North" };

    const effective = buildEffectiveWidget(w, [f], af);

    // The effective widget must NOT be the same reference.
    expect(effective).not.toBe(w);
    // But the BASE widget must be unchanged — byte-identical JSON.
    expect(JSON.stringify(w)).toBe(before);
    // And the effective widget's extra filter must be present.
    expect(effective.query?.filters).toHaveLength(1);
    expect(effective.query?.filters?.[0]).toMatchObject({
      column: "region",
      operator: "eq",
      value: "North",
    });
  });

  it("builder widget: clearing filters restores identical base (effective → base)", () => {
    const w = makeBuilderWidget();
    const before = JSON.stringify(w);

    const f = makeFilter(w.id, "region");
    // Apply filter
    buildEffectiveWidget(w, [f], { [f.id]: "North" });
    // Clear filter (empty active)
    const cleared = buildEffectiveWidget(w, [f], {});

    expect(cleared).toBe(w); // fast path: no applicable filters → same reference
    expect(JSON.stringify(w)).toBe(before);
  });

  it("sql widget: sql string is deep-equal after applying + clearing a filter", () => {
    const w = makeSqlWidget();
    const before = JSON.stringify(w);

    const f = makeFilter(w.id, "region");
    buildEffectiveWidget(w, [f], { [f.id]: "North" });

    expect(JSON.stringify(w)).toBe(before);

    const cleared = buildEffectiveWidget(w, [f], {});
    expect(JSON.stringify(w)).toBe(before);
    expect(cleared).toBe(w);
  });

  it("builder: existing query.filters are preserved (not replaced)", () => {
    const w = makeBuilderWidget({
      query: {
        group_by: "region",
        aggregation: { func: "count" },
        filters: [{ column: "amount", operator: "gt", value: 100 }],
      },
    });
    const before = JSON.stringify(w);

    const f = makeFilter(w.id, "region");
    const effective = buildEffectiveWidget(w, [f], { [f.id]: "North" });

    // Base is intact
    expect(JSON.stringify(w)).toBe(before);
    // Effective has both the original filter AND the injected one
    expect(effective.query?.filters).toHaveLength(2);
    expect(effective.query?.filters?.[0]).toMatchObject({ column: "amount" });
    expect(effective.query?.filters?.[1]).toMatchObject({ column: "region" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 2 — cache key = hash of effective query (selective re-run)
// ─────────────────────────────────────────────────────────────────────────────

describe("Invariant 2 — only targeted widgets change cache key", () => {
  it("filter targeting w1 changes w1's key but NOT w2's key", () => {
    const w1 = makeBuilderWidget();
    const w2 = makeBuilderWidget();

    const keyW1Before = widgetCacheKey(w1);
    const keyW2Before = widgetCacheKey(w2);

    const f = makeFilter(w1.id, "region"); // targets w1 only
    const af: ActiveFilters = { [f.id]: "North" };

    const effW1 = buildEffectiveWidget(w1, [f], af);
    const effW2 = buildEffectiveWidget(w2, [f], af);

    // w1 must have a new key (affected)
    expect(widgetCacheKey(effW1)).not.toBe(keyW1Before);
    // w2 must keep the same key (cache hit)
    expect(widgetCacheKey(effW2)).toBe(keyW2Before);
  });

  it("same filter value → same effective cache key (idempotent)", () => {
    const w = makeBuilderWidget();
    const f = makeFilter(w.id, "region");
    const af: ActiveFilters = { [f.id]: "North" };

    const eff1 = buildEffectiveWidget(w, [f], af);
    const eff2 = buildEffectiveWidget(w, [f], af);
    expect(widgetCacheKey(eff1)).toBe(widgetCacheKey(eff2));
  });

  it("different filter values → different effective cache keys", () => {
    const w = makeBuilderWidget();
    const f = makeFilter(w.id, "region");

    const eff1 = buildEffectiveWidget(w, [f], { [f.id]: "North" });
    const eff2 = buildEffectiveWidget(w, [f], { [f.id]: "South" });
    expect(widgetCacheKey(eff1)).not.toBe(widgetCacheKey(eff2));
  });

  it("clearing filter restores original cache key", () => {
    const w = makeBuilderWidget();
    const originalKey = widgetCacheKey(w);

    const f = makeFilter(w.id, "region");
    const effFiltered = buildEffectiveWidget(w, [f], { [f.id]: "North" });
    expect(widgetCacheKey(effFiltered)).not.toBe(originalKey);

    const effCleared = buildEffectiveWidget(w, [f], {});
    // fast path returns same reference → same key
    expect(widgetCacheKey(effCleared)).toBe(originalKey);
  });

  it("sql widget: only targeted sql widget changes key; untargeted builder stays put", () => {
    const sqlW = makeSqlWidget();
    const builderW = makeBuilderWidget();

    const sqlKeyBefore = widgetCacheKey(sqlW);
    const builderKeyBefore = widgetCacheKey(builderW);

    const f = makeFilter(sqlW.id, "region");
    const af: ActiveFilters = { [f.id]: "North" };

    const effSql = buildEffectiveWidget(sqlW, [f], af);
    const effBuilder = buildEffectiveWidget(builderW, [f], af);

    expect(widgetCacheKey(effSql)).not.toBe(sqlKeyBefore);
    expect(widgetCacheKey(effBuilder)).toBe(builderKeyBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Builder predicate merge (kinds)
// ─────────────────────────────────────────────────────────────────────────────

describe("Builder filter predicates", () => {
  it("multi-select → in_list filter", () => {
    const w = makeBuilderWidget();
    const f: DashboardFilter = {
      id: "f1",
      label: "region",
      kind: "multi-select",
      targets: [{ widgetId: w.id, column: "region" }],
    };
    const eff = buildEffectiveWidget(w, [f], { f1: ["North", "South"] });
    const injected = eff.query?.filters?.[0];
    expect(injected?.operator).toBe("in_list");
    expect(injected?.values).toEqual(["North", "South"]);
  });

  it("date-range → two filters (gte + lte)", () => {
    const w = makeBuilderWidget();
    const f: DashboardFilter = {
      id: "f1",
      label: "date",
      kind: "date-range",
      targets: [{ widgetId: w.id, column: "created_at" }],
    };
    const eff = buildEffectiveWidget(w, [f], { f1: ["2024-01-01", "2024-12-31"] });
    expect(eff.query?.filters).toHaveLength(2);
    expect(eff.query?.filters?.[0]).toMatchObject({ operator: "gte", value: "2024-01-01" });
    expect(eff.query?.filters?.[1]).toMatchObject({ operator: "lte", value: "2024-12-31" });
  });

  it("number-range → two filters (gte + lte)", () => {
    const w = makeBuilderWidget();
    const f: DashboardFilter = {
      id: "f1",
      label: "amount",
      kind: "number-range",
      targets: [{ widgetId: w.id, column: "amount" }],
    };
    const eff = buildEffectiveWidget(w, [f], { f1: [10, 500] });
    expect(eff.query?.filters).toHaveLength(2);
    expect(eff.query?.filters?.[0]).toMatchObject({ operator: "gte", value: 10 });
    expect(eff.query?.filters?.[1]).toMatchObject({ operator: "lte", value: 500 });
  });

  it("text → contains filter", () => {
    const w = makeBuilderWidget();
    const f: DashboardFilter = {
      id: "f1",
      label: "name",
      kind: "text",
      targets: [{ widgetId: w.id, column: "name" }],
    };
    const eff = buildEffectiveWidget(w, [f], { f1: "foo" });
    expect(eff.query?.filters?.[0]).toMatchObject({ operator: "contains", value: "foo" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SQL parameterized outer WHERE (safe quoting, subquery wrap)
// ─────────────────────────────────────────────────────────────────────────────

describe("SQL subquery wrap + safe value quoting", () => {
  it("wraps base SQL in a subquery and applies outer WHERE", () => {
    const baseSql = "SELECT region, COUNT(*) FROM dataset GROUP BY region";
    const w = makeSqlWidget(baseSql);
    const f = makeFilter(w.id, "region");
    const eff = buildEffectiveWidget(w, [f], { [f.id]: "North" });

    expect(eff.sql).toContain("SELECT * FROM (");
    expect(eff.sql).toContain(baseSql);
    expect(eff.sql).toContain(") AS _t WHERE");
    expect(eff.sql).toContain(`"region" = 'North'`);
  });

  it("escapes single quotes in string values (SQL injection guard)", () => {
    const w = makeSqlWidget();
    const f = makeFilter(w.id, "name");
    const eff = buildEffectiveWidget(w, [f], { [f.id]: "O'Brien" });

    expect(eff.sql).toContain(`'O''Brien'`);
    expect(eff.sql).not.toContain(`'O'Brien'`);
  });

  it("date-range generates two outer predicates (>= and <=)", () => {
    const w = makeSqlWidget();
    const f: DashboardFilter = {
      id: "f1",
      label: "date",
      kind: "date-range",
      targets: [{ widgetId: w.id, column: "created_at" }],
    };
    const eff = buildEffectiveWidget(w, [f], { f1: ["2024-01-01", "2024-12-31"] });

    expect(eff.sql).toContain(`"created_at" >= '2024-01-01'`);
    expect(eff.sql).toContain(`"created_at" <= '2024-12-31'`);
  });

  it("multi-select generates IN (...) predicate", () => {
    const w = makeSqlWidget();
    const f: DashboardFilter = {
      id: "f1",
      label: "region",
      kind: "multi-select",
      targets: [{ widgetId: w.id, column: "region" }],
    };
    const eff = buildEffectiveWidget(w, [f], { f1: ["North", "South"] });

    expect(eff.sql).toContain(`"region" IN ('North', 'South')`);
  });

  it("skips unmapped SQL widgets (no target → returns base unchanged)", () => {
    const w1 = makeSqlWidget();
    const w2 = makeSqlWidget();
    const f = makeFilter(w1.id, "region"); // only targets w1

    const effW2 = buildEffectiveWidget(w2, [f], { [f.id]: "North" });
    expect(effW2).toBe(w2); // same reference — fast path
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-filter loop guard
// ─────────────────────────────────────────────────────────────────────────────

describe("Cross-filter loop guard", () => {
  it("emitting widget is excluded from its own cross-filter (builder)", () => {
    const emitter = makeBuilderWidget();
    const receiver = makeBuilderWidget({
      query: { group_by: "region", aggregation: { func: "count" } },
    });

    const cf: CrossFilter = {
      id: "cf1",
      column: "region",
      value: "North",
      sourceWidgetId: emitter.id,
    };

    // Emitter: cross-filter skipped (loop guard)
    const effEmitter = buildEffectiveWidget(emitter, [], {}, [cf]);
    expect(effEmitter).toBe(emitter); // no predicates → same ref

    // Receiver: cross-filter applied (column matches group_by)
    const effReceiver = buildEffectiveWidget(receiver, [], {}, [cf]);
    expect(effReceiver.query?.filters).toHaveLength(1);
    expect(effReceiver.query?.filters?.[0]).toMatchObject({
      column: "region",
      operator: "eq",
      value: "North",
    });
  });

  it("sql widget: cross-filter skipped when resultColumns is null (conservative)", () => {
    const w = makeSqlWidget();
    const cf: CrossFilter = {
      id: "cf1",
      column: "region",
      value: "North",
      sourceWidgetId: "other-widget",
    };

    // No result columns yet → conservative skip
    const effNull = buildEffectiveWidget(w, [], {}, [cf], null);
    expect(effNull).toBe(w);
  });

  it("sql widget: cross-filter applied when resultColumns includes the column", () => {
    const w = makeSqlWidget();
    const cf: CrossFilter = {
      id: "cf1",
      column: "region",
      value: "North",
      sourceWidgetId: "other-widget",
    };

    const effWithCols = buildEffectiveWidget(w, [], {}, [cf], ["region", "cnt"]);
    expect(effWithCols.sql).toContain(`"region" = 'North'`);
  });

  it("sql widget: cross-filter skipped when column NOT in resultColumns", () => {
    const w = makeSqlWidget();
    const cf: CrossFilter = {
      id: "cf1",
      column: "unknown_col",
      value: "X",
      sourceWidgetId: "other-widget",
    };

    const eff = buildEffectiveWidget(w, [], {}, [cf], ["region", "cnt"]);
    expect(eff).toBe(w); // skipped → no change
  });

  it("builder: cross-filter skipped when column doesn't match group_by", () => {
    const w = makeBuilderWidget({ query: { group_by: "region", aggregation: { func: "count" } } });
    const cf: CrossFilter = {
      id: "cf1",
      column: "category",  // different from group_by "region"
      value: "A",
      sourceWidgetId: "other-widget",
    };

    const eff = buildEffectiveWidget(w, [], {}, [cf]);
    expect(eff).toBe(w); // skipped → no change
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Verification Report (engine-call simulation)
// ─────────────────────────────────────────────────────────────────────────────

describe("Verification Report — cache-key counts (simulates scheduler cache behaviour)", () => {
  it("filter change: only targeted widgets get new keys; others show cache hit", () => {
    const targetedBuilder = makeBuilderWidget();
    const targetedSql = makeSqlWidget();
    const untargetedBuilder = makeBuilderWidget();
    const untargetedSql = makeSqlWidget();

    const allWidgets = [targetedBuilder, targetedSql, untargetedBuilder, untargetedSql];
    const f1 = makeFilter(targetedBuilder.id, "region");
    const f2 = makeFilter(targetedSql.id, "region");

    // Snapshot keys before filter
    const keysBefore = Object.fromEntries(allWidgets.map((w) => [w.id, widgetCacheKey(w)]));

    // Apply filter
    const af: ActiveFilters = { [f1.id]: "North", [f2.id]: "North" };
    const effectiveWidgets = allWidgets.map((w) =>
      buildEffectiveWidget(w, [f1, f2], af),
    );
    const keysAfter = Object.fromEntries(
      effectiveWidgets.map((w) => [w.id, widgetCacheKey(w)]),
    );

    const changedIds = allWidgets
      .filter((w) => keysAfter[w.id] !== keysBefore[w.id])
      .map((w) => w.id);

    const cacheHitIds = allWidgets
      .filter((w) => keysAfter[w.id] === keysBefore[w.id])
      .map((w) => w.id);

    // REPORT
    console.log(`\n=== Verification Report ===`);
    console.log(`Total widgets:  ${allWidgets.length}`);
    console.log(`Affected (new key → would re-run): ${changedIds.length}`);
    console.log(`Unaffected (cache hit → no re-run): ${cacheHitIds.length}`);
    console.log(`Changed widget IDs: [${changedIds.join(", ")}]`);
    console.log(`Cache-hit IDs:      [${cacheHitIds.join(", ")}]`);

    // Assertions
    expect(changedIds).toHaveLength(2); // targeted builder + targeted sql
    expect(cacheHitIds).toHaveLength(2); // untargeted builder + untargeted sql
    expect(changedIds).toContain(targetedBuilder.id);
    expect(changedIds).toContain(targetedSql.id);
    expect(cacheHitIds).toContain(untargetedBuilder.id);
    expect(cacheHitIds).toContain(untargetedSql.id);
  });
});
