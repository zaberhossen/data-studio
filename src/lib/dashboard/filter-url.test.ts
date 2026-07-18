import { describe, it, expect } from "vitest";
import { filtersFromSearch, searchWithFilters } from "./filter-url";

describe("filtersFromSearch", () => {
  it("reads f.<id> params, JSON-decoding every value shape", () => {
    const search = `?f.region=${encodeURIComponent('"west"')}&f.qty=${encodeURIComponent("5")}&f.tags=${encodeURIComponent('["a","b"]')}&other=x`;
    expect(filtersFromSearch(search)).toEqual({ region: "west", qty: 5, tags: ["a", "b"] });
  });

  it("tolerates a bare (non-JSON) string value", () => {
    expect(filtersFromSearch("?f.region=west")).toEqual({ region: "west" });
  });

  it("ignores non-filter params and empty ids", () => {
    expect(filtersFromSearch("?page=2&f.=x")).toEqual({});
  });
});

describe("searchWithFilters", () => {
  it("writes active values as JSON, preserving non-filter params", () => {
    const out = searchWithFilters("?page=2", { region: "west", tags: ["a", "b"] });
    const params = new URLSearchParams(out);
    expect(params.get("page")).toBe("2");
    expect(params.get("f.region")).toBe('"west"');
    expect(params.get("f.tags")).toBe('["a","b"]');
  });

  it("replaces stale filter params and drops empty values", () => {
    const out = searchWithFilters("?f.old=1", { region: "", tags: [], q: "hi" });
    expect(out).toBe(`f.q=${encodeURIComponent('"hi"')}`);
  });

  it("skips ids in the skip set (locked filters)", () => {
    const out = searchWithFilters("", { region: "west", scope: "acme" }, new Set(["scope"]));
    const params = new URLSearchParams(out);
    expect(params.get("f.region")).toBe('"west"');
    expect(params.has("f.scope")).toBe(false);
  });

  it("round-trips through filtersFromSearch", () => {
    const active = { region: "west", qty: 5, tags: ["a", "b"] };
    expect(filtersFromSearch("?" + searchWithFilters("", active))).toEqual(active);
  });
});
