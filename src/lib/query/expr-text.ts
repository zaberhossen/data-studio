/**
 * Expression text ⇄ Expr — the formula bar behind calculated fields.
 *
 * `parseExprText` turns a Metabase-style formula string into the IR's CLOSED
 * `Expr` algebra; `formatExprText` is its exact inverse (every `Expr` the IR
 * can hold formats to a string that re-parses to the same tree), which is what
 * makes calculated fields lossless through `irToDraft`.
 *
 * Grammar (case-insensitive keywords):
 *   expr      := mul (('+'|'-') mul)*
 *   mul       := unary (('*'|'/'|'%') unary)*
 *   unary     := '-' NUMBER | primary
 *   primary   := NUMBER | STRING | true | false | null
 *              | '[' field name ']' | IDENT
 *              | FN '(' expr (',' expr)* ')'
 *              | '(' expr ')'
 *              | 'case' ('when' cond 'then' expr)+ ('else' expr)? 'end'
 *   cond      := andCond ('or' andCond)*
 *   andCond   := notCond ('and' notCond)*
 *   notCond   := 'not' notCond | '(' cond ')' | predicate
 *   predicate := fieldRef (CMP literal | 'is' ['not'] 'null')
 *
 * Field references parse as COLUMN refs; `compileIrDraft` rewrites names that
 * match an earlier calculated field into `expression` refs (the parser can't
 * know the distinction). No free SQL ever passes through — the output is the
 * same closed algebra the compiler validates and quotes.
 */

import type { Expr, ExprFn, FieldRef, Filter, ScalarOp } from "@/lib/query/ir";

export const EXPR_FNS: ExprFn[] = [
  "coalesce",
  "concat",
  "lower",
  "upper",
  "abs",
  "round",
  "extract",
  "date_trunc",
];
const EXPR_FN_SET: ReadonlySet<string> = new Set(EXPR_FNS);

const CMP_OPS: Record<string, ScalarOp> = {
  "=": "eq",
  "!=": "neq",
  "<>": "neq",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

export interface ParseResult {
  expr: Expr | null;
  error: string | null;
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "field"; v: string } // [bracketed name]
  | { t: "ident"; v: string } // bare identifier or keyword
  | { t: "op"; v: string } // + - * / % ( ) , = != <> > >= < <=
  | { t: "end" };

function tokenize(input: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "[") {
      const close = input.indexOf("]", i + 1);
      if (close === -1) return "Unclosed “[” — field references look like [column name].";
      const name = input.slice(i + 1, close).trim();
      if (!name) return "Empty field reference “[]”.";
      tokens.push({ t: "field", v: name });
      i = close + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let out = "";
      while (j < n) {
        if (input[j] === c) {
          // Doubled quote = escaped quote.
          if (input[j + 1] === c) {
            out += c;
            j += 2;
            continue;
          }
          break;
        }
        out += input[j];
        j++;
      }
      if (j >= n) return "Unclosed string literal.";
      tokens.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/i.exec(input.slice(i));
      if (!m) return `Invalid number at “${input.slice(i, i + 8)}”.`;
      tokens.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i))!;
      tokens.push({ t: "ident", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "!=" || two === "<>") {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%(),=<>".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    return `Unexpected character “${c}”.`;
  }
  tokens.push({ t: "end" });
  return tokens;
}

// ── Parser ───────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.pos];
  }
  next(): Token {
    return this.tokens[this.pos++];
  }
  isKeyword(kw: string): boolean {
    const t = this.peek();
    return t.t === "ident" && t.v.toLowerCase() === kw;
  }
  eatKeyword(kw: string): boolean {
    if (this.isKeyword(kw)) {
      this.next();
      return true;
    }
    return false;
  }
  isOp(v: string): boolean {
    const t = this.peek();
    return t.t === "op" && t.v === v;
  }
  expectOp(v: string): void {
    if (!this.isOp(v)) throw new ExprError(`Expected “${v}”.`);
    this.next();
  }

  parseExpr(): Expr {
    let left = this.parseMul();
    while (this.isOp("+") || this.isOp("-")) {
      const operator = (this.next() as { v: string }).v as "+" | "-";
      left = { op: "binary", operator, left, right: this.parseMul() };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const operator = (this.next() as { v: string }).v as "*" | "/" | "%";
      left = { op: "binary", operator, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOp("-")) {
      this.next();
      const t = this.peek();
      if (t.t === "num") {
        this.next();
        return { op: "lit", value: -t.v };
      }
      // General negation: 0 - x (formats back the same way).
      return { op: "binary", operator: "-", left: { op: "lit", value: 0 }, right: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.t === "num") {
      this.next();
      return { op: "lit", value: t.v };
    }
    if (t.t === "str") {
      this.next();
      return { op: "lit", value: t.v };
    }
    if (t.t === "field") {
      this.next();
      return { op: "field", ref: { kind: "column", name: t.v } };
    }
    if (t.t === "op" && t.v === "(") {
      this.next();
      const inner = this.parseExpr();
      this.expectOp(")");
      return inner;
    }
    if (t.t === "ident") {
      const kw = t.v.toLowerCase();
      if (kw === "true" || kw === "false") {
        this.next();
        return { op: "lit", value: kw === "true" };
      }
      if (kw === "null") {
        this.next();
        return { op: "lit", value: null };
      }
      if (kw === "case") return this.parseCase();
      // Function call?
      if (this.tokens[this.pos + 1]?.t === "op" && (this.tokens[this.pos + 1] as { v: string }).v === "(") {
        if (!EXPR_FN_SET.has(kw)) {
          throw new ExprError(`Unknown function “${t.v}” — available: ${EXPR_FNS.join(", ")}.`);
        }
        this.next(); // fn name
        this.next(); // (
        const args: Expr[] = [];
        if (!this.isOp(")")) {
          args.push(this.parseExpr());
          while (this.isOp(",")) {
            this.next();
            args.push(this.parseExpr());
          }
        }
        this.expectOp(")");
        return { op: "fn", name: kw as ExprFn, args };
      }
      // Bare identifier = field reference.
      this.next();
      return { op: "field", ref: { kind: "column", name: t.v } };
    }
    throw new ExprError("Expected a value, [column], function, or “(”.");
  }

  private parseCase(): Expr {
    this.next(); // case
    const whens: Array<{ when: Filter; then: Expr }> = [];
    while (this.eatKeyword("when")) {
      const when = this.parseCond();
      if (!this.eatKeyword("then")) throw new ExprError("Expected “then” after the condition.");
      whens.push({ when, then: this.parseExpr() });
    }
    if (whens.length === 0) throw new ExprError("“case” needs at least one “when … then …”.");
    let els: Expr | undefined;
    if (this.eatKeyword("else")) els = this.parseExpr();
    if (!this.eatKeyword("end")) throw new ExprError("Expected “end” to close the case.");
    return { op: "case", whens, else: els };
  }

  // ── Conditions (inside case when) ──────────────────────────────────────────

  private parseCond(): Filter {
    let left = this.parseAndCond();
    while (this.eatKeyword("or")) {
      const right = this.parseAndCond();
      left = left.op === "or" ? { op: "or", clauses: [...left.clauses, right] } : { op: "or", clauses: [left, right] };
    }
    return left;
  }

  private parseAndCond(): Filter {
    let left = this.parseNotCond();
    while (this.eatKeyword("and")) {
      const right = this.parseNotCond();
      left =
        left.op === "and" ? { op: "and", clauses: [...left.clauses, right] } : { op: "and", clauses: [left, right] };
    }
    return left;
  }

  private parseNotCond(): Filter {
    if (this.eatKeyword("not")) return { op: "not", clause: this.parseNotCond() };
    if (this.isOp("(")) {
      this.next();
      const inner = this.parseCond();
      this.expectOp(")");
      return inner;
    }
    return this.parsePredicate();
  }

  private parsePredicate(): Filter {
    const t = this.peek();
    let field: FieldRef;
    if (t.t === "field") {
      this.next();
      field = { kind: "column", name: t.v };
    } else if (t.t === "ident") {
      this.next();
      field = { kind: "column", name: t.v };
    } else {
      throw new ExprError("Conditions start with a [column].");
    }

    if (this.eatKeyword("is")) {
      const negated = this.eatKeyword("not");
      if (!this.eatKeyword("null")) throw new ExprError("Expected “null” after “is”.");
      return negated ? { op: "not_null", field } : { op: "is_null", field };
    }

    const opTok = this.peek();
    if (opTok.t !== "op" || !(opTok.v in CMP_OPS)) {
      throw new ExprError("Expected a comparison (=, !=, >, >=, <, <=) or “is null”.");
    }
    this.next();
    const lit = this.peek();
    let value: string | number | boolean;
    if (lit.t === "num") value = lit.v;
    else if (lit.t === "str") value = lit.v;
    else if (lit.t === "ident" && (lit.v.toLowerCase() === "true" || lit.v.toLowerCase() === "false")) {
      value = lit.v.toLowerCase() === "true";
    } else {
      throw new ExprError("Compare against a number, 'string', true, or false.");
    }
    this.next();
    return { op: CMP_OPS[opTok.v], field, value };
  }
}

class ExprError extends Error {}

/** Parse a formula string into an `Expr`; never throws. */
export function parseExprText(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { expr: null, error: "Enter a formula." };
  const tokens = tokenize(trimmed);
  if (typeof tokens === "string") return { expr: null, error: tokens };
  const parser = new Parser(tokens);
  try {
    const expr = parser.parseExpr();
    if (parser.peek().t !== "end") {
      return { expr: null, error: "Unexpected trailing input after the formula." };
    }
    return { expr, error: null };
  } catch (err) {
    return { expr: null, error: err instanceof ExprError ? err.message : "Invalid formula." };
  }
}

// ── Formatter (exact inverse) ────────────────────────────────────────────────

function fmtLit(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${value.replace(/'/g, "''")}'`;
}

function fmtRef(ref: FieldRef): string {
  // Aggregation refs can't occur inside a calculated field; expression refs
  // print as fields (they re-resolve on compile).
  const name = ref.kind === "aggregation" ? String(ref.index) : ref.name;
  return `[${name}]`;
}

function fmtFilter(f: Filter): string {
  switch (f.op) {
    case "and":
      return f.clauses.map(fmtFilterAtom).join(" and ");
    case "or":
      return f.clauses.map(fmtFilterAtom).join(" or ");
    case "not":
      return `not ${fmtFilterAtom(f.clause)}`;
    case "is_null":
      return `${fmtRef(f.field)} is null`;
    case "not_null":
      return `${fmtRef(f.field)} is not null`;
    case "eq":
      return `${fmtRef(f.field)} = ${fmtLit(f.value)}`;
    case "neq":
      return `${fmtRef(f.field)} != ${fmtLit(f.value)}`;
    case "gt":
      return `${fmtRef(f.field)} > ${fmtLit(f.value)}`;
    case "gte":
      return `${fmtRef(f.field)} >= ${fmtLit(f.value)}`;
    case "lt":
      return `${fmtRef(f.field)} < ${fmtLit(f.value)}`;
    case "lte":
      return `${fmtRef(f.field)} <= ${fmtLit(f.value)}`;
    default:
      // Operators beyond the condition grammar (in/between/…) can't round-trip
      // through text; the caller treats the whole expression as unformattable.
      throw new ExprError(`“${f.op}” conditions aren't supported in formulas.`);
  }
}

function fmtFilterAtom(f: Filter): string {
  const s = fmtFilter(f);
  return f.op === "and" || f.op === "or" ? `(${s})` : s;
}

const PRECEDENCE: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2 };

function fmt(expr: Expr, parentPrec: number): string {
  switch (expr.op) {
    case "lit":
      return fmtLit(expr.value);
    case "field":
      return fmtRef(expr.ref);
    case "binary": {
      const prec = PRECEDENCE[expr.operator];
      const s = `${fmt(expr.left, prec)} ${expr.operator} ${fmt(expr.right, prec + 1)}`;
      return prec < parentPrec ? `(${s})` : s;
    }
    case "fn":
      return `${expr.name}(${expr.args.map((a) => fmt(a, 0)).join(", ")})`;
    case "case": {
      const whens = expr.whens
        .map((w) => `when ${fmtFilter(w.when)} then ${fmt(w.then, 0)}`)
        .join(" ");
      const els = expr.else !== undefined ? ` else ${fmt(expr.else, 0)}` : "";
      return `case ${whens}${els} end`;
    }
  }
}

/**
 * Format an `Expr` back to formula text. Returns null for trees that use
 * filter operators outside the condition grammar (in/between/relative dates
 * inside a case) — callers should then warn instead of silently mangling.
 */
export function formatExprText(expr: Expr): string | null {
  try {
    return fmt(expr, 0);
  } catch {
    return null;
  }
}
