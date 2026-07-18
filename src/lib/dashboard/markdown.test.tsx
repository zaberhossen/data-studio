import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "./markdown";

const html = (src: string) => renderToStaticMarkup(<>{renderMarkdown(src)}</>);

describe("renderMarkdown", () => {
  it("renders headings by level", () => {
    expect(html("# Big")).toContain("<h1");
    expect(html("### Small")).toContain("<h3");
  });

  it("renders inline bold / italic / code", () => {
    const out = html("a **b** c *d* e `f`");
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain("<em>d</em>");
    expect(out).toContain("<code");
    expect(out).toContain("f</code>");
  });

  it("renders unordered and ordered lists", () => {
    expect(html("- one\n- two")).toContain("<ul");
    expect(html("1. one\n2. two")).toMatch(/<ol[^>]*>.*<li>one<\/li>/s);
  });

  it("links only safe schemes; javascript: falls back to literal text", () => {
    expect(html("[x](https://a.com)")).toContain('href="https://a.com"');
    const evil = html("[x](javascript:alert(1))");
    expect(evil).not.toContain("<a");
    expect(evil).toContain("[x](javascript:alert(1))");
  });

  it("does not emit raw HTML from the source (auto-escaped)", () => {
    expect(html("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });

  it("separates paragraphs on blank lines", () => {
    const out = html("one\n\ntwo");
    expect(out.match(/<p/g)?.length).toBe(2);
  });
});
