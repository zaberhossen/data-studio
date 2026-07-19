/**
 * Caret-aware text insertion for the calculated-field formula bar.
 *
 * Pure + total so it's unit-testable away from the DOM: the component reads the
 * input's selection, calls this to splice a snippet (a `[column]` ref or a
 * `fn(` call) over the current selection, then restores the caret to the end of
 * the inserted text. Out-of-range / inverted selections are clamped, so a stale
 * selection can never throw or corrupt the formula.
 */

export interface SplicedText {
  text: string;
  /** Caret position to restore — just past the inserted snippet. */
  caret: number;
}

export function spliceSnippet(
  text: string,
  start: number,
  end: number,
  snippet: string,
): SplicedText {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return {
    text: text.slice(0, s) + snippet + text.slice(e),
    caret: s + snippet.length,
  };
}

/**
 * A `[column]` reference. The formula lexer reads to the first `]` (no escape
 * form), so we wrap the raw name verbatim — matching exactly what the parser
 * will read back.
 */
export function columnRef(name: string): string {
  return `[${name}]`;
}
