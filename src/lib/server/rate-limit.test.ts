import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, __resetRateLimit } from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(() => __resetRateLimit());

  it("allows up to max within a window, then blocks", () => {
    const t = 1_000;
    expect(rateLimit("k", t, 2, 1000)).toBe(true);
    expect(rateLimit("k", t, 2, 1000)).toBe(true);
    expect(rateLimit("k", t, 2, 1000)).toBe(false);
  });

  it("resets after the window elapses", () => {
    expect(rateLimit("k", 1_000, 1, 1000)).toBe(true);
    expect(rateLimit("k", 1_500, 1, 1000)).toBe(false); // same window
    expect(rateLimit("k", 2_000, 1, 1000)).toBe(true); // window rolled over
  });

  it("tracks keys independently", () => {
    expect(rateLimit("a", 1_000, 1, 1000)).toBe(true);
    expect(rateLimit("b", 1_000, 1, 1000)).toBe(true);
    expect(rateLimit("a", 1_000, 1, 1000)).toBe(false);
  });
});
