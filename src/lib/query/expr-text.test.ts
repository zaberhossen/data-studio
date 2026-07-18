import { describe, expect, it } from "vitest";
import { formatExprText, parseExprText } from "./expr-text";
import type { Expr } from "./ir";

/** Parse, expect success, return the tree. */
function parse(text: string): Expr {
  const { expr, error } = parseExprText(text);
  expect(error).toBeNull();
  expect(expr).not.toBeNull();
  return expr!;
}

/** Round-trip: text → expr → text → expr must be structurally identical. */
function roundTrip(text: string): void {
  const first = parse(text);
  const formatted = formatExprText(first);
  expect(formatted).not.toBeNull();
  const second = parse(formatted!);
  expect(second).toEqual(first);
}

describe("parseExprText", () => {
  it("parses arithmetic with precedence", () => {
    expect(parse("[a] + [b] * 2")).toEqual({
      op: "binary",
      operator: "+",
      left: { op: "field", ref: { kind: "column", name: "a" } },
      right: {
        op: "binary",
        operator: "*",
        left: { op: "field", ref: { kind: "column", name: "b" } },
        right: { op: "lit", value: 2 },
      },
    });
  });

  it("parses parens overriding precedence", () => {
    const e = parse("([a] + [b]) * 2");
    expect(e).toMatchObject({ op: "binary", operator: "*" });
  });

  it("parses bracketed names with spaces and bare identifiers", () => {
    expect(parse("[unit price] * qty")).toMatchObject({
      op: "binary",
      left: { op: "field", ref: { kind: "column", name: "unit price" } },
      right: { op: "field", ref: { kind: "column", name: "qty" } },
    });
  });

  it("parses string/boolean/null literals and negative numbers", () => {
    expect(parse("'it''s'")).toEqual({ op: "lit", value: "it's" });
    expect(parse("true")).toEqual({ op: "lit", value: true });
    expect(parse("null")).toEqual({ op: "lit", value: null });
    expect(parse("-4.5")).toEqual({ op: "lit", value: -4.5 });
  });

  it("parses known functions and rejects unknown ones", () => {
    expect(parse("round([revenue] / 100)")).toMatchObject({ op: "fn", name: "round" });
    expect(parse("coalesce([a], [b], 0)")).toMatchObject({ op: "fn", name: "coalesce" });
    const { error } = parseExprText("regexp([a])");
    expect(error).toMatch(/Unknown function/);
  });

  it("parses case with and/or/not conditions", () => {
    const e = parse(
      "case when [qty] > 10 and [region] = 'EU' then 'big' when [qty] is null then 'none' else 'small' end",
    );
    expect(e).toMatchObject({
      op: "case",
      whens: [
        {
          when: {
            op: "and",
            clauses: [
              { op: "gt", field: { kind: "column", name: "qty" }, value: 10 },
              { op: "eq", field: { kind: "column", name: "region" }, value: "EU" },
            ],
          },
          then: { op: "lit", value: "big" },
        },
        { when: { op: "is_null", field: { kind: "column", name: "qty" } } },
      ],
      else: { op: "lit", value: "small" },
    });
  });

  it("reports friendly errors", () => {
    expect(parseExprText("").error).toMatch(/Enter a formula/);
    expect(parseExprText("[open").error).toMatch(/Unclosed/);
    expect(parseExprText("[a] +").error).toBeTruthy();
    expect(parseExprText("case when [a] > 1 then 2").error).toMatch(/end/);
  });
});

describe("formatExprText round-trips", () => {
  it.each([
    "[a] + [b] * 2",
    "([a] + [b]) * 2",
    "[a] - [b] - [c]",
    "[a] / ([b] - [c])",
    "0 - [a]",
    "round([revenue] / 100)",
    "coalesce([a], [b], 0)",
    "concat(lower([first]), ' ', upper([last]))",
    "case when [qty] > 10 then 'big' else 'small' end",
    "case when [qty] is not null and [region] != 'EU' then [qty] * 2 end",
    "case when not [done] = true then 1 else 0 end",
  ])("%s", (text) => {
    roundTrip(text);
  });

  it("returns null for filter ops outside the condition grammar", () => {
    const expr: Expr = {
      op: "case",
      whens: [
        {
          when: { op: "in", field: { kind: "column", name: "r" }, values: ["a"] },
          then: { op: "lit", value: 1 },
        },
      ],
    };
    expect(formatExprText(expr)).toBeNull();
  });
});
