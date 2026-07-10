/**
 * Data-viz palette — the validated color system for every chart.
 *
 * The actual hues live as CSS custom properties in `globals.css` (light + dark
 * steps), so charts are theme-aware for free. This module exposes them BY ROLE
 * as `var(--…)` tokens for Recharts/SVG `fill`/`stroke` props.
 *
 * Rules baked in (from the dataviz method, validated via the skill's script):
 *   • Categorical hues are a FIXED order, never cycled — a 9th+ series folds into
 *     "Other" (see the chart adapter), never a generated hue.
 *   • Sequential = one hue light→dark (magnitude). Status = reserved, never a series.
 *   • Text/labels wear ink tokens, never a series color.
 *
 * Palette validation (run in the skill dir):
 *   light: worst adjacent CVD ΔE 24.2 — PASS (3 slots sub-3:1 → relief: legend +
 *          direct labels + table view, all shipped).
 *   dark:  worst adjacent CVD ΔE 10.3 — PASS floor band (secondary encoding shipped).
 */

/** Categorical slots in FIXED order (theme-aware via CSS vars). */
export const CATEGORICAL: readonly string[] = [
  "var(--viz-1)",
  "var(--viz-2)",
  "var(--viz-3)",
  "var(--viz-4)",
  "var(--viz-5)",
  "var(--viz-6)",
  "var(--viz-7)",
  "var(--viz-8)",
];

/** Max distinct categorical series before the rest fold into "Other". */
export const MAX_SERIES = CATEGORICAL.length;

/** The color for series slot `i` (fixed order; caller caps at {@link MAX_SERIES}). */
export function seriesColor(i: number): string {
  return CATEGORICAL[i % CATEGORICAL.length];
}

/** Sequential blue ramp (near-zero → max), for heat/choropleth magnitude. */
export const SEQUENTIAL: readonly string[] = [
  "var(--viz-seq-0)",
  "var(--viz-seq-1)",
  "var(--viz-seq-2)",
  "var(--viz-seq-3)",
  "var(--viz-seq-4)",
];

/** Pick a sequential step for a normalized value `t` ∈ [0,1]. */
export function sequentialColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const idx = Math.round(clamped * (SEQUENTIAL.length - 1));
  return SEQUENTIAL[idx];
}

/** Reserved status colors — never used as a series hue; pair with icon + label. */
export const STATUS = {
  good: "var(--viz-good)",
  warning: "var(--viz-warning)",
  serious: "var(--viz-serious)",
  critical: "var(--viz-critical)",
} as const;

export type StatusRole = keyof typeof STATUS;

/** Chart chrome tokens (recessive grid/axis; text wears app ink tokens). */
export const CHROME = {
  grid: "var(--viz-grid)",
  axis: "var(--viz-axis)",
} as const;
