/**
 * Value formatting + conditional formatting — shared by axis ticks, tooltips,
 * KPI values, and table cells so a widget's number style is consistent
 * everywhere. Pure + dependency-free (uses `Intl.NumberFormat`).
 */

import type { ConditionalRule, NumberFormat } from "@/lib/types/query";
import { STATUS, type StatusRole } from "@/lib/viz/palette";

/** Build a value→string formatter from a `NumberFormat` (sensible plain default). */
export function makeNumberFormatter(fmt?: NumberFormat): (v: unknown) => string {
  const decimals = fmt?.decimals;
  const opts: Intl.NumberFormatOptions = {};
  if (decimals != null) {
    opts.minimumFractionDigits = decimals;
    opts.maximumFractionDigits = decimals;
  }

  let intl: Intl.NumberFormat;
  switch (fmt?.style) {
    case "currency":
      intl = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: fmt.currency || "USD",
        ...opts,
      });
      break;
    case "percent":
      // Values are treated as ratios (0.42 → "42%").
      intl = new Intl.NumberFormat("en-US", { style: "percent", ...opts });
      break;
    case "compact":
      intl = new Intl.NumberFormat("en-US", { notation: "compact", ...opts });
      break;
    default:
      intl = new Intl.NumberFormat("en-US", opts);
  }

  const prefix = fmt?.prefix ?? "";
  const suffix = fmt?.suffix ?? "";
  return (v: unknown) => {
    if (v == null || v === "") return "—";
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return String(v);
    return `${prefix}${intl.format(n)}${suffix}`;
  };
}

/** Default compact formatter (axis ticks when no explicit format is set). */
export const compactFormat = makeNumberFormatter({ style: "compact" });

function passes(rule: ConditionalRule, n: number): boolean {
  switch (rule.op) {
    case "gt":
      return n > rule.value;
    case "gte":
      return n >= rule.value;
    case "lt":
      return n < rule.value;
    case "lte":
      return n <= rule.value;
    case "eq":
      return n === rule.value;
    case "between":
      return rule.value2 != null && n >= rule.value && n <= rule.value2;
    default:
      return false;
  }
}

/** Resolve a rule's color: a status role name maps to its reserved var, else raw. */
function ruleColor(color: string): string {
  return (STATUS as Record<string, string>)[color] ?? color;
}

/**
 * First matching rule's color for `value` in `column` (or the KPI value when
 * `column` is undefined), or null when nothing matches / the value isn't numeric.
 * Rules are evaluated in order; a rule with no `column`/`"*"` matches any column.
 */
export function conditionalColor(
  value: unknown,
  rules: ConditionalRule[] | undefined,
  column?: string,
): string | null {
  if (!rules || rules.length === 0) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  for (const rule of rules) {
    const scoped = !rule.column || rule.column === "*" || rule.column === column;
    if (scoped && passes(rule, n)) return ruleColor(rule.color);
  }
  return null;
}

export type { StatusRole };
