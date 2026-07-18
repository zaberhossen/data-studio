import { describe, it, expect } from "vitest";
import {
  completedCount,
  EMPTY_ONBOARDING,
  isComplete,
  mergeOnboarding,
} from "./onboarding";

describe("mergeOnboarding", () => {
  it("latches: a step true in prev stays true even if live is false", () => {
    const merged = mergeOnboarding({ source: true }, { source: false, query: true });
    expect(merged.source).toBe(true);
    expect(merged.query).toBe(true);
    expect(merged.dashboard).toBe(false);
  });

  it("treats null/undefined prev as empty", () => {
    expect(mergeOnboarding(null, { share: true })).toEqual({
      ...EMPTY_ONBOARDING,
      share: true,
    });
  });

  it("ignores unknown keys and never mutates its inputs", () => {
    const prev = { dashboard: true };
    const live = { query: true };
    const merged = mergeOnboarding(prev, live);
    expect(merged).toEqual({ source: false, query: true, dashboard: true, share: false });
    expect(prev).toEqual({ dashboard: true });
    expect(live).toEqual({ query: true });
  });
});

describe("completedCount / isComplete", () => {
  it("counts completed steps", () => {
    expect(completedCount(EMPTY_ONBOARDING)).toBe(0);
    expect(completedCount({ source: true, query: true, dashboard: false, share: false })).toBe(2);
  });

  it("isComplete only when all four are done", () => {
    expect(isComplete(EMPTY_ONBOARDING)).toBe(false);
    expect(isComplete({ source: true, query: true, dashboard: true, share: true })).toBe(true);
    expect(isComplete({ source: true, query: true, dashboard: true, share: false })).toBe(false);
  });
});
