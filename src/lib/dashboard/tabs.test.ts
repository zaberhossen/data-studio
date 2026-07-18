import { describe, it, expect } from "vitest";
import { itemTabId, itemsOnTab, nextTabId, resolveActiveTab } from "./tabs";
import type { DashboardTab } from "@/lib/types/dashboard";

const tabs: DashboardTab[] = [
  { id: "t1", name: "Tab 1" },
  { id: "t2", name: "Tab 2" },
];

describe("nextTabId", () => {
  it("mints a tab-prefixed id", () => {
    expect(nextTabId().startsWith("tab_")).toBe(true);
  });
});

describe("itemTabId", () => {
  it("returns the item's tab, falling back to the first tab when unset", () => {
    expect(itemTabId({ tabId: "t2" }, tabs)).toBe("t2");
    expect(itemTabId({}, tabs)).toBe("t1"); // untabbed → first tab
  });
  it("is undefined when the dashboard has no tabs", () => {
    expect(itemTabId({ tabId: "t2" }, undefined)).toBeUndefined();
    expect(itemTabId({}, [])).toBeUndefined();
  });
});

describe("itemsOnTab", () => {
  const items = [
    { id: "a", tabId: "t1" },
    { id: "b", tabId: "t2" },
    { id: "c" }, // untabbed → first tab (t1)
  ];

  it("filters to the active tab, counting untabbed items as the first tab", () => {
    expect(itemsOnTab(items, tabs, "t1").map((i) => i.id)).toEqual(["a", "c"]);
    expect(itemsOnTab(items, tabs, "t2").map((i) => i.id)).toEqual(["b"]);
  });

  it("passes everything through when there are no tabs / no active tab", () => {
    expect(itemsOnTab(items, undefined, null)).toHaveLength(3);
    expect(itemsOnTab(items, tabs, null)).toHaveLength(3);
  });
});

describe("resolveActiveTab", () => {
  it("keeps a valid choice, else falls back to the first tab", () => {
    expect(resolveActiveTab(tabs, "t2")).toBe("t2");
    expect(resolveActiveTab(tabs, "gone")).toBe("t1");
    expect(resolveActiveTab(tabs, null)).toBe("t1");
  });
  it("is null when there are no tabs", () => {
    expect(resolveActiveTab(undefined, "t1")).toBeNull();
    expect(resolveActiveTab([], null)).toBeNull();
  });
});
