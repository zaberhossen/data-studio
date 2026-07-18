import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary, keysChanged } from "./error-boundary";

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary fallback={() => <span>fallback</span>}>
        <span>ok</span>
      </ErrorBoundary>,
    );
    expect(html).toContain("ok");
    expect(html).not.toContain("fallback");
  });
});

describe("keysChanged (auto-reset detection)", () => {
  const obj = {};
  it("is false for identical references and equal contents", () => {
    expect(keysChanged(undefined, undefined)).toBe(false);
    const same: unknown[] = [1, "a", obj];
    expect(keysChanged(same, same)).toBe(false);
    expect(keysChanged([1, "a", obj], [1, "a", obj])).toBe(false);
  });

  it("is true when any element, the length, or presence differs", () => {
    expect(keysChanged([1], [2])).toBe(true);
    expect(keysChanged([1], [1, 2])).toBe(true);
    expect(keysChanged(undefined, [1])).toBe(true);
    expect(keysChanged([{}], [{}])).toBe(true); // distinct object identities
  });
});
