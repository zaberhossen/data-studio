import { describe, it, expect } from "vitest";
import {
  AUDIT_PAGE_SIZE,
  AUDIT_PAGE_MAX,
  parseAuditListParams,
} from "./audit";

const parse = (qs: string) => parseAuditListParams(new URLSearchParams(qs));

describe("parseAuditListParams", () => {
  it("defaults an empty query to page-1 defaults", () => {
    expect(parse("")).toEqual({ limit: AUDIT_PAGE_SIZE, cursor: null, action: null });
  });

  it("reads a valid limit, cursor, and action", () => {
    expect(parse("limit=10&cursor=500&action=share.create")).toEqual({
      limit: 10,
      cursor: 500,
      action: "share.create",
    });
  });

  it("clamps limit to the max and floors fractions", () => {
    expect(parse("limit=99999").limit).toBe(AUDIT_PAGE_MAX);
    expect(parse("limit=10.9").limit).toBe(10);
  });

  it("falls back to the default for non-positive / non-numeric limits", () => {
    expect(parse("limit=0").limit).toBe(AUDIT_PAGE_SIZE);
    expect(parse("limit=-5").limit).toBe(AUDIT_PAGE_SIZE);
    expect(parse("limit=abc").limit).toBe(AUDIT_PAGE_SIZE);
  });

  it("treats a non-positive / non-numeric cursor as page 1 (null)", () => {
    expect(parse("cursor=0").cursor).toBeNull();
    expect(parse("cursor=-1").cursor).toBeNull();
    expect(parse("cursor=nope").cursor).toBeNull();
  });

  it("trims a blank action to null", () => {
    expect(parse("action=").action).toBeNull();
    expect(parse("action=%20%20").action).toBeNull();
    expect(parse("action=%20share.view%20").action).toBe("share.view");
  });
});
