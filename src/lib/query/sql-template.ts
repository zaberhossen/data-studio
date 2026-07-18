/**
 * sql-template — Metabase-style SQL templates for the SQL editor.
 *
 *   {{variable}}         a parameter slot, rendered as a typed filter widget
 *   [[ … {{variable}} …]] an optional clause: kept only when EVERY variable
 *                         inside it has a value, removed entirely otherwise
 *
 * Rendering is TEXT-level substitution done client-side before the statement is
 * handed to the LOCAL DuckDB worker, so values are inlined as literals — which
 * is exactly why rendering is type-checked and escaped here:
 *   text   → single-quoted with '' escaping
 *   number → must parse as a plain numeric literal (emitted raw)
 *   date   → must be an ISO date / datetime (emitted single-quoted)
 * A value can never terminate the quote or smuggle a second statement.
 *
 * This never applies to server-side sources: the pushdown endpoint accepts the
 * IR only, and raw SQL always executes on the browser's own DuckDB.
 */

export type TemplateVarType = "text" | "number" | "date";

export interface TemplateVar {
  name: string;
  /** False when the variable only occurs inside [[optional]] blocks. */
  required: boolean;
}

/** One widget's state: the chosen type + the raw input text. */
export interface TemplateVarValue {
  type: TemplateVarType;
  value: string;
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const OPTIONAL_RE = /\[\[([\s\S]*?)\]\]/g;

/** True when the statement contains any template syntax at all. */
export function hasTemplateSyntax(sql: string): boolean {
  return /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/.test(sql);
}

/**
 * Extract the statement's variables in first-appearance order (deduped).
 * A variable is `required` unless every occurrence sits inside an [[optional]]
 * block.
 */
export function extractTemplateVars(sql: string): TemplateVar[] {
  const optionalOnly = new Map<string, boolean>();
  const order: string[] = [];

  const record = (name: string, insideOptional: boolean) => {
    if (!optionalOnly.has(name)) {
      order.push(name);
      optionalOnly.set(name, insideOptional);
    } else if (!insideOptional) {
      optionalOnly.set(name, false);
    }
  };

  // Pass 1: variables inside optional blocks.
  const withoutOptional = sql.replace(OPTIONAL_RE, (_m, inner: string) => {
    for (const m of inner.matchAll(VAR_RE)) record(m[1], true);
    return " ";
  });
  // Pass 2: variables in the remaining (required) text.
  for (const m of withoutOptional.matchAll(VAR_RE)) record(m[1], false);

  // Re-derive appearance order from the ORIGINAL text so a var that shows up
  // first inside an optional block keeps its position.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of sql.matchAll(VAR_RE)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ordered.push(m[1]);
    }
  }
  return ordered.map((name) => ({ name, required: !optionalOnly.get(name) }));
}

/** Escape + type-check one value as a SQL literal; null when invalid. */
function renderLiteral(v: TemplateVarValue): string | null {
  const raw = v.value.trim();
  switch (v.type) {
    case "number":
      return /^-?\d+(\.\d+)?$/.test(raw) ? raw : null;
    case "date":
      // ISO date or datetime; quoted — DuckDB casts in comparisons.
      return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(raw)
        ? `'${raw}'`
        : null;
    case "text":
      return `'${raw.replace(/'/g, "''")}'`;
  }
}

export type RenderResult =
  | { ok: true; sql: string }
  | { ok: false; error: string };

/**
 * Render a template into a runnable statement.
 *
 * Optional blocks whose variables are all filled are unwrapped (brackets
 * removed, content kept); blocks with any empty variable are dropped whole.
 * After that, every remaining {{var}} must have a valid value.
 */
export function renderSqlTemplate(
  sql: string,
  values: Record<string, TemplateVarValue | undefined>,
): RenderResult {
  const filled = (name: string) => (values[name]?.value ?? "").trim() !== "";

  let error: string | null = null;
  const substitute = (text: string): string =>
    text.replace(VAR_RE, (_m, name: string) => {
      const v = values[name];
      if (!v || v.value.trim() === "") {
        error ??= `Missing value for {{${name}}}.`;
        return "NULL";
      }
      const lit = renderLiteral(v);
      if (lit === null) {
        error ??= `"${v.value}" is not a valid ${v.type} for {{${name}}}.`;
        return "NULL";
      }
      return lit;
    });

  // Optional blocks first: keep-and-unwrap or drop-whole.
  const withOptional = sql.replace(OPTIONAL_RE, (_m, inner: string) => {
    const names = [...inner.matchAll(VAR_RE)].map((m) => m[1]);
    return names.every(filled) ? inner : " ";
  });

  const rendered = substitute(withOptional);
  if (error) return { ok: false, error };
  return { ok: true, sql: rendered };
}
