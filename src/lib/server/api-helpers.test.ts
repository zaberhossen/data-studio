import { describe, it, expect, beforeEach } from "vitest";
import { errorResponse, mutationRateLimit } from "./api-helpers";
import { ConflictError } from "./dashboard-store";
import { __resetRateLimit } from "./rate-limit";
import type { AuthContext } from "@/lib/db/scope";

const ctx = (userId: string): AuthContext => ({ userId, orgId: "o1", role: "editor" });

describe("mutationRateLimit", () => {
  beforeEach(() => __resetRateLimit());

  it("returns null under the limit, then a 429 once exceeded", () => {
    const t = 1_000;
    expect(mutationRateLimit(ctx("u1"), 2, t)).toBeNull();
    expect(mutationRateLimit(ctx("u1"), 2, t)).toBeNull();
    const blocked = mutationRateLimit(ctx("u1"), 2, t);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
  });

  it("scopes the window per user", () => {
    const t = 1_000;
    expect(mutationRateLimit(ctx("a"), 1, t)).toBeNull();
    expect(mutationRateLimit(ctx("b"), 1, t)).toBeNull(); // different user, own budget
    expect(mutationRateLimit(ctx("a"), 1, t)).not.toBeNull(); // a is now over
  });
});

describe("errorResponse", () => {
  it("passes a 4xx .status through (ConflictError → 409)", () => {
    expect(errorResponse(new ConflictError()).status).toBe(409);
    expect(errorResponse({ status: 403, message: "no" }).status).toBe(403);
  });

  it("defaults to 500 for errors without a 4xx status", () => {
    expect(errorResponse(new Error("boom")).status).toBe(500);
    expect(errorResponse({ status: 500 }).status).toBe(500);
    expect(errorResponse("weird").status).toBe(500);
  });
});
