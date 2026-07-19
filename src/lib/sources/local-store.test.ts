import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readActiveSourceId, writeActiveSourceId } from "./local-store";

/** Minimal in-memory localStorage stub (node test env has no DOM). */
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe("per-org active source id", () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = { localStorage: new MemoryStorage() };
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("keeps each org's active source independent (no cross-org bleed)", () => {
    writeActiveSourceId("org-a", "src-1");
    writeActiveSourceId("org-b", "src-2");
    expect(readActiveSourceId("org-a")).toBe("src-1");
    expect(readActiveSourceId("org-b")).toBe("src-2");
  });

  it("returns null for an org with nothing saved", () => {
    expect(readActiveSourceId("fresh-org")).toBeNull();
  });

  it("clearing one org leaves the other intact", () => {
    writeActiveSourceId("org-a", "src-1");
    writeActiveSourceId("org-b", "src-2");
    writeActiveSourceId("org-a", null);
    expect(readActiveSourceId("org-a")).toBeNull();
    expect(readActiveSourceId("org-b")).toBe("src-2");
  });
});
