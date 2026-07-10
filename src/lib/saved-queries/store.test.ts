import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSavedQueryStore } from "./store";
import { sameDefinition, toDefinition } from "./dirty";
import { SAVED_QUERY_SCHEMA_VERSION } from "@/lib/types/query";
import type { QueryDefinition, SavedQuery } from "@/lib/types/query";

/** Minimal in-memory Storage stub (the store only uses get/set/removeItem). */
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
}

const builderDef: QueryDefinition = {
  sourceId: "demo",
  queryKind: "builder",
  query: {
    group_by: "region",
    aggregation: { func: "sum", column: "revenue" },
    sort: "desc",
    limit: 50,
  },
  viz: { type: "bar" },
};

const sqlDef: QueryDefinition = {
  sourceId: "demo",
  queryKind: "sql",
  sql: "SELECT region, SUM(revenue) FROM dataset GROUP BY region",
  viz: { type: "table" },
};

describe("LocalSavedQueryStore", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: new MemoryStorage() };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("create() stamps id, timestamps, and the current schema version", async () => {
    const store = new LocalSavedQueryStore();
    const q = await store.create(builderDef, "Revenue by region", "  top regions ");
    expect(q.id).toMatch(/^sq_/);
    expect(q.name).toBe("Revenue by region");
    expect(q.description).toBe("top regions"); // trimmed
    expect(q.schemaVersion).toBe(SAVED_QUERY_SCHEMA_VERSION);
    expect(q.createdAt).toBe(q.updatedAt);
    expect(q.queryKind).toBe("builder");
    expect(q.query).toEqual(builderDef.query);
  });

  it("persists NO result data — only the definition + metadata keys", async () => {
    const store = new LocalSavedQueryStore();
    const q = await store.create(builderDef, "R");
    const raw = JSON.parse(
      (globalThis as unknown as { window: { localStorage: MemoryStorage } }).window.localStorage.getItem(
        `data-studio:saved-query:${q.id}`,
      )!,
    );
    expect(Object.keys(raw).sort()).toEqual(
      [
        "createdAt",
        "id",
        "name",
        "queryKind",
        "schemaVersion",
        "sourceId",
        "updatedAt",
        "viz",
        "query",
      ].sort(),
    );
  });

  it("list() returns summaries (no payload) sorted by updatedAt desc", async () => {
    const store = new LocalSavedQueryStore();
    const a = await store.create(builderDef, "A");
    // Force a strictly-later timestamp for B regardless of clock granularity.
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create(sqlDef, "B");

    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(list[0]).not.toHaveProperty("sql");
    expect(list[0]).not.toHaveProperty("query");
    expect(list[0].queryKind).toBe("sql");
    expect(list[0].sourceId).toBe("demo");
  });

  it("update() patches the definition and bumps updatedAt, keeping createdAt", async () => {
    const store = new LocalSavedQueryStore();
    const q = await store.create(builderDef, "A");
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.update(q.id, { viz: { type: "line" } });
    expect(updated.viz.type).toBe("line");
    expect(updated.createdAt).toBe(q.createdAt);
    expect(updated.updatedAt > q.updatedAt).toBe(true);
    expect(updated.schemaVersion).toBe(SAVED_QUERY_SCHEMA_VERSION);
  });

  it("rename() changes only the name", async () => {
    const store = new LocalSavedQueryStore();
    const q = await store.create(builderDef, "Old");
    const renamed = await store.rename(q.id, "New");
    expect(renamed.name).toBe("New");
    expect(sameDefinition(renamed, q)).toBe(true);
  });

  it("remove() drops the record and its index entry", async () => {
    const store = new LocalSavedQueryStore();
    const q = await store.create(builderDef, "A");
    await store.remove(q.id);
    expect(await store.get(q.id)).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  it("update() rejects an unknown id", async () => {
    const store = new LocalSavedQueryStore();
    await expect(store.update("sq_missing", { name: "x" })).rejects.toThrow();
  });
});

describe("dirty tracking", () => {
  it("sameDefinition ignores key order and absent-vs-undefined", () => {
    const a: QueryDefinition = { ...builderDef };
    const b: QueryDefinition = {
      viz: { type: "bar" },
      queryKind: "builder",
      sourceId: "demo",
      sql: undefined,
      query: {
        limit: 50,
        sort: "desc",
        aggregation: { column: "revenue", func: "sum" },
        group_by: "region",
      },
    };
    expect(sameDefinition(a, b)).toBe(true);
  });

  it("detects a viz change and a source change", () => {
    expect(sameDefinition(builderDef, { ...builderDef, viz: { type: "kpi" } })).toBe(false);
    expect(sameDefinition(builderDef, { ...builderDef, sourceId: "other" })).toBe(false);
  });

  it("toDefinition strips identity + metadata", () => {
    const saved: SavedQuery = {
      ...builderDef,
      id: "sq_1",
      name: "n",
      schemaVersion: 1,
      createdAt: "t",
      updatedAt: "t",
    };
    const def = toDefinition(saved);
    expect(def).not.toHaveProperty("id");
    expect(def).not.toHaveProperty("name");
    expect(def).toEqual(builderDef);
  });
});
