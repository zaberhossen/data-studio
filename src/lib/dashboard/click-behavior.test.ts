import { describe, it, expect } from "vitest";
import { templateUrl, dashboardHref, resolveClick } from "./click-behavior";

describe("templateUrl", () => {
  it("substitutes url-encoded value + column", () => {
    expect(templateUrl("https://x.com/{{value}}", { column: "region", value: "West Side" })).toBe(
      "https://x.com/West%20Side",
    );
    expect(templateUrl("/q?c={{column}}&v={{value}}", { column: "region", value: 5 })).toBe(
      "/q?c=region&v=5",
    );
  });

  it("tolerates spaces in the placeholder and leaves unknowns intact", () => {
    expect(templateUrl("a/{{ value }}/{{other}}", { column: "c", value: "z" })).toBe(
      "a/z/{{other}}",
    );
  });
});

describe("dashboardHref", () => {
  it("targets the dashboard by ?d and seeds a filter when given", () => {
    expect(dashboardHref("dash_1", "region", "west")).toBe(
      `/dashboards?d=dash_1&f.region=${encodeURIComponent('"west"')}`,
    );
  });
  it("omits the filter param when no filterId", () => {
    expect(dashboardHref("dash_1", undefined, "west")).toBe("/dashboards?d=dash_1");
  });
});

describe("resolveClick", () => {
  const point = { column: "region", value: "west" };

  it("defaults to cross-filter when unset", () => {
    expect(resolveClick(undefined, point)).toEqual({ kind: "cross-filter", column: "region", value: "west" });
  });

  it("resolves a templated URL (new tab by default)", () => {
    expect(resolveClick({ type: "url", url: "https://x/{{value}}" }, point)).toEqual({
      kind: "open-url",
      url: "https://x/west",
      newTab: true,
    });
  });

  it("returns null for an unconfigured url / dashboard behavior", () => {
    expect(resolveClick({ type: "url", url: "  " }, point)).toBeNull();
    expect(resolveClick({ type: "dashboard", dashboardId: "" }, point)).toBeNull();
  });

  it("navigates for a dashboard behavior", () => {
    expect(resolveClick({ type: "dashboard", dashboardId: "d2", filterId: "region" }, point)).toEqual({
      kind: "navigate",
      href: `/dashboards?d=d2&f.region=${encodeURIComponent('"west"')}`,
    });
  });
});
