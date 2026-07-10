/**
 * effectiveQuery merge — dashboard cross-filtering engine.
 *
 * The ONE function here, `buildEffectiveWidget`, computes an ephemeral Widget
 * that has active dashboard filters + cross-filters folded into its query.
 * The base widget is NEVER mutated (Invariant 1). The returned widget keeps the
 * same `id`, so the scheduler routes results back to the correct subscriber;
 * its cache key reflects the merged query (Invariant 2).
 *
 * Builder path: clone the Query; append predicates for each applicable filter.
 * SQL path: wrap the user's SQL as a subquery and add an outer parameterized-
 * style WHERE. Values are escaped with SQL-standard literal quoting (single
 * quotes doubled) rather than string interpolation of structure — DuckDB does
 * not expose a prepared-statement API through the existing worker interface.
 *
 * Cross-filter loop guard: a widget is never a target of its own cross-filter
 * (sourceWidgetId === widget.id → skip). SQL cross-filter columns are only
 * applied when the widget's cached result schema confirms the column exists
 * (resultColumns != null); if unknown, the predicate is omitted (conservative).
 */

import type {
  ActiveFilters,
  CrossFilter,
  DashboardFilter,
  FilterKind,
  FilterOperator,
  FilterValue,
  Widget,
} from "@/lib/types/dashboard";
import type { Cell, Filter, Operator } from "@/lib/types/analytics";

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultOp(kind: FilterKind): FilterOperator {
  switch (kind) {
    case "multi-select":
      return "in_list";
    case "text":
      return "contains";
    default:
      return "eq";
  }
}

/** Escape a scalar to a SQL literal (single-quotes doubled; numbers bare). */
function sqlLiteral(value: string | number | boolean): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Quote a column identifier (double-quotes doubled). */
function sqlIdent(col: string): string {
  return `"${col.replace(/"/g, '""')}"`;
}

/**
 * Build one or more SQL predicate strings for a filter value.
 * date-range / number-range → two predicates (>= and <=).
 * in_list → single IN (...) predicate.
 * scalar operators → single comparison predicate.
 */
function buildSqlPredicates(
  col: string,
  kind: FilterKind,
  op: FilterOperator,
  value: FilterValue,
): string[] {
  const ident = sqlIdent(col);

  if (
    (kind === "date-range" || kind === "number-range") &&
    Array.isArray(value) &&
    value.length === 2
  ) {
    const lo = value[0] as string | number;
    const hi = value[1] as string | number;
    return [`${ident} >= ${sqlLiteral(lo)}`, `${ident} <= ${sqlLiteral(hi)}`];
  }

  if (op === "in_list" && Array.isArray(value)) {
    if ((value as unknown[]).length === 0) return [];
    const items = (value as Array<string | number>).map(sqlLiteral).join(", ");
    return [`${ident} IN (${items})`];
  }

  const sqlOpMap: Record<FilterOperator, string> = {
    eq: "=",
    neq: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    contains: "LIKE",
    in_list: "IN",
  };
  const scalar = value as string | number | boolean;
  const lit =
    op === "contains"
      ? sqlLiteral(`%${String(scalar)}%`)
      : sqlLiteral(scalar);
  return [`${ident} ${sqlOpMap[op]} ${lit}`];
}

/**
 * Build builder `Filter` objects from a filter value.
 * date-range / number-range → two Filter objects (gte + lte).
 * in_list → one Filter with `values`.
 * scalar → one Filter with `value`.
 */
function buildBuilderFilters(
  col: string,
  kind: FilterKind,
  op: FilterOperator,
  value: FilterValue,
): Filter[] {
  if (
    (kind === "date-range" || kind === "number-range") &&
    Array.isArray(value) &&
    value.length === 2
  ) {
    return [
      { column: col, operator: "gte" as Operator, value: value[0] as Cell },
      { column: col, operator: "lte" as Operator, value: value[1] as Cell },
    ];
  }

  if (op === "in_list" && Array.isArray(value)) {
    if ((value as unknown[]).length === 0) return [];
    return [
      {
        column: col,
        operator: "in_list" as Operator,
        values: value as Cell[],
      },
    ];
  }

  return [
    {
      column: col,
      operator: op as Operator,
      value: value as Cell,
    },
  ];
}

// ── Core export ───────────────────────────────────────────────────────────────

/**
 * Compute the ephemeral effective widget (base ⊕ active filters ⊕ cross-filters).
 *
 * @param widget        The persisted base widget (never mutated).
 * @param filters       Dashboard filter definitions (from Dashboard.filters).
 * @param activeFilters Runtime active filter values (ephemeral, not persisted).
 * @param crossFilters  Runtime cross-filter events (ephemeral, not persisted).
 * @param resultColumns Column names from the widget's last result; used to skip
 *                      SQL cross-filter predicates for unknown columns.
 *                      Pass `null` when no result is available yet.
 */
export function buildEffectiveWidget(
  widget: Widget,
  filters: DashboardFilter[],
  activeFilters: ActiveFilters,
  crossFilters: CrossFilter[] = [],
  resultColumns: string[] | null = null,
): Widget {
  // ── Collect applicable dashboard filters ────────────────────────────────
  const applicable = filters.filter((f) => {
    const val = activeFilters[f.id];
    if (val === undefined || val === null) return false;
    if (Array.isArray(val) && (val as unknown[]).length === 0) return false;
    return f.targets.some((t) => t.widgetId === widget.id);
  });

  // ── Collect applicable cross-filters (with loop guard) ─────────────────
  const crossApplicable = crossFilters.filter((cf) => {
    if (cf.sourceWidgetId === widget.id) return false; // loop guard

    if (widget.queryKind === "builder") {
      // For builder, cross-filter only applies when column matches group_by.
      return widget.query?.group_by === cf.column;
    }

    // SQL: only apply if we know the schema AND the column exists.
    // Conservative default: skip when schema is unknown to avoid DuckDB errors.
    if (resultColumns === null) return false;
    return resultColumns.includes(cf.column);
  });

  if (applicable.length === 0 && crossApplicable.length === 0) return widget;

  // ── Builder path ────────────────────────────────────────────────────────
  if (widget.queryKind === "builder") {
    if (!widget.query) return widget;
    const extra: Filter[] = [];

    for (const f of applicable) {
      const target = f.targets.find((t) => t.widgetId === widget.id)!;
      const op = f.op ?? defaultOp(f.kind);
      extra.push(
        ...buildBuilderFilters(target.column, f.kind, op, activeFilters[f.id]!),
      );
    }

    for (const cf of crossApplicable) {
      extra.push({
        column: cf.column,
        operator: "eq" as Operator,
        value: cf.value as Cell,
      });
    }

    return {
      ...widget,
      // Spread the base query (shallow clone is sufficient: arrays replaced below).
      query: {
        ...widget.query,
        filters: [...(widget.query.filters ?? []), ...extra],
      },
    };
  }

  // ── SQL path: subquery wrap with outer WHERE ─────────────────────────────
  const baseSql = widget.sql?.trim();
  if (!baseSql) return widget;

  const predicates: string[] = [];

  for (const f of applicable) {
    const target = f.targets.find((t) => t.widgetId === widget.id)!;
    const op = f.op ?? defaultOp(f.kind);
    predicates.push(
      ...buildSqlPredicates(
        target.column,
        f.kind,
        op,
        activeFilters[f.id]!,
      ),
    );
  }

  for (const cf of crossApplicable) {
    predicates.push(
      `${sqlIdent(cf.column)} = ${sqlLiteral(cf.value as string | number | boolean)}`,
    );
  }

  if (predicates.length === 0) return widget;

  return {
    ...widget,
    sql: `SELECT * FROM (\n${baseSql}\n) AS _t WHERE ${predicates.join(" AND ")}`,
  };
}
