import { describe, expect, it } from "vitest";
import {
  extractTemplateVars,
  hasTemplateSyntax,
  renderSqlTemplate,
  type TemplateVarValue,
} from "./sql-template";

const v = (value: string, type: TemplateVarValue["type"] = "text"): TemplateVarValue => ({
  type,
  value,
});

describe("hasTemplateSyntax", () => {
  it("detects {{var}} and ignores plain SQL", () => {
    expect(hasTemplateSyntax("select * from t where a = {{a}}")).toBe(true);
    expect(hasTemplateSyntax("select '{{not a var}}' from t")).toBe(false);
    expect(hasTemplateSyntax("select 1")).toBe(false);
  });
});

describe("extractTemplateVars", () => {
  it("returns unique vars in appearance order", () => {
    const vars = extractTemplateVars(
      "select {{b}} from t where x = {{a}} and y = {{b}}",
    );
    expect(vars.map((x) => x.name)).toEqual(["b", "a"]);
    expect(vars.every((x) => x.required)).toBe(true);
  });

  it("marks optional-only vars as not required", () => {
    const vars = extractTemplateVars(
      "select * from t where 1=1 [[and a = {{a}}]] and b = {{b}}",
    );
    expect(vars).toEqual([
      { name: "a", required: false },
      { name: "b", required: true },
    ]);
  });

  it("a var both inside and outside optional blocks stays required", () => {
    const vars = extractTemplateVars(
      "select {{a}} from t [[where a = {{a}}]]",
    );
    expect(vars).toEqual([{ name: "a", required: true }]);
  });
});

describe("renderSqlTemplate", () => {
  it("substitutes typed literals", () => {
    const r = renderSqlTemplate(
      "select * from t where name = {{n}} and qty > {{q}} and d >= {{d}}",
      { n: v("books"), q: v("42", "number"), d: v("2024-03-01", "date") },
    );
    expect(r).toEqual({
      ok: true,
      sql: "select * from t where name = 'books' and qty > 42 and d >= '2024-03-01'",
    });
  });

  it("escapes single quotes in text values", () => {
    const r = renderSqlTemplate("select * from t where a = {{a}}", {
      a: v("O'Brien'; DROP TABLE t; --"),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toContain("'O''Brien''; DROP TABLE t; --'");
  });

  it("rejects non-numeric numbers and malformed dates", () => {
    expect(
      renderSqlTemplate("select {{q}}", { q: v("1; DROP", "number") }).ok,
    ).toBe(false);
    expect(
      renderSqlTemplate("select {{d}}", { d: v("yesterday", "date") }).ok,
    ).toBe(false);
  });

  it("errors on a missing required value", () => {
    const r = renderSqlTemplate("select * from t where a = {{a}}", {});
    expect(r).toEqual({ ok: false, error: "Missing value for {{a}}." });
  });

  it("keeps a filled optional block (unwrapped) and drops an empty one", () => {
    const sql = "select * from t where 1=1 [[and a = {{a}}]] [[and b = {{b}}]]";
    const r = renderSqlTemplate(sql, { a: v("x") });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sql).toContain("and a = 'x'");
      expect(r.sql).not.toContain("b =");
      expect(r.sql).not.toContain("[[");
    }
  });

  it("drops an optional block when only some of its vars are filled", () => {
    const r = renderSqlTemplate(
      "select * from t [[where a = {{a}} and b = {{b}}]]",
      { a: v("x") },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql.trim()).toBe("select * from t");
  });

  it("multiline optional blocks work", () => {
    const r = renderSqlTemplate(
      "select *\nfrom t\n[[where d >= {{start}}\n  and d < {{end}}]]",
      { start: v("2024-01-01", "date"), end: v("2024-02-01", "date") },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sql).toContain("d >= '2024-01-01'");
      expect(r.sql).toContain("d < '2024-02-01'");
    }
  });
});
