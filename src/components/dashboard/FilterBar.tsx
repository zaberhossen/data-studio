"use client";

/**
 * FilterBar — the dashboard filter control strip.
 *
 * Renders one control per DashboardFilter by kind:
 *   date-range    → two date inputs (start / end)
 *   select        → single text input (eq match)
 *   multi-select  → tag-input style (comma-separated → string[])
 *   number-range  → two number inputs (min / max)
 *   text          → text input (contains match)
 *
 * Also renders cross-filter chips (emitted by chart clicks) with per-chip
 * clear buttons and a global clear-all button for all active filters.
 *
 * The filter bar is hidden when there are no filter definitions AND no
 * cross-filters (so it doesn't take up space on an unfiltered dashboard).
 */

import * as React from "react";
import { X, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DashboardFilter, FilterValue } from "@/lib/types/dashboard";
import { useFilterContext } from "./DashboardFilterContext";

// ── FilterBar ─────────────────────────────────────────────────────────────────

interface FilterBarProps {
  className?: string;
}

export function FilterBar({ className }: FilterBarProps) {
  const {
    filterDefs,
    activeFilters,
    crossFilters,
    setFilter,
    clearFilter,
    clearAllFilters,
    removeCrossFilter,
    clearAllCrossFilters,
    hasActiveFilters,
  } = useFilterContext();

  if (filterDefs.length === 0 && crossFilters.length === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-2",
        className,
      )}
      role="toolbar"
      aria-label="Dashboard filters"
    >
      {filterDefs.length > 0 && (
        <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          Filters
        </div>
      )}

      {/* Dashboard filter controls */}
      {filterDefs.map((f) => (
        <FilterControl
          key={f.id}
          filter={f}
          value={activeFilters[f.id]}
          onChange={(v) => setFilter(f.id, v, f.kind === "select" || f.kind === "multi-select")}
          onClear={() => clearFilter(f.id)}
        />
      ))}

      {/* Cross-filter chips */}
      {crossFilters.length > 0 && (
        <>
          {filterDefs.length > 0 && (
            <div className="h-5 w-px bg-border" role="separator" />
          )}
          <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            Click filters
          </div>
          {crossFilters.map((cf) => (
            <CrossFilterChip
              key={cf.id}
              column={cf.column}
              value={cf.value}
              onRemove={() => removeCrossFilter(cf.id)}
            />
          ))}
        </>
      )}

      {/* Clear all */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            clearAllFilters();
            clearAllCrossFilters();
          }}
          aria-label="Clear all filters"
        >
          <X className="h-3 w-3" />
          Clear all
        </Button>
      )}
    </div>
  );
}

// ── Per-filter control ────────────────────────────────────────────────────────

interface FilterControlProps {
  filter: DashboardFilter;
  value: FilterValue | undefined;
  onChange: (value: FilterValue | undefined) => void;
  onClear: () => void;
}

function FilterControl({ filter, value, onChange, onClear }: FilterControlProps) {
  const isActive = value !== undefined && value !== "" &&
    !(Array.isArray(value) && (value as unknown[]).length === 0);

  return (
    <div className="flex items-center gap-1">
      <div
        className={cn(
          "flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1",
          isActive && "border-primary/50 bg-primary/5",
        )}
      >
        <span className="text-xs font-medium text-muted-foreground">
          {filter.label}:
        </span>

        {filter.kind === "date-range" && (
          <DateRangeControl
            value={value as string[] | undefined}
            onChange={onChange}
          />
        )}
        {filter.kind === "number-range" && (
          <NumberRangeControl
            value={value as number[] | undefined}
            onChange={onChange}
          />
        )}
        {filter.kind === "multi-select" && (
          <MultiSelectControl
            value={value as string[] | undefined}
            onChange={onChange}
          />
        )}
        {filter.kind === "select" && (
          <SelectControl
            value={value as string | undefined}
            onChange={onChange}
          />
        )}
        {filter.kind === "text" && (
          <TextControl
            value={value as string | undefined}
            onChange={onChange}
          />
        )}
      </div>

      {isActive && (
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onClear}
          aria-label={`Clear ${filter.label} filter`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ── Individual input controls ─────────────────────────────────────────────────

function DateRangeControl({
  value,
  onChange,
}: {
  value: string[] | undefined;
  onChange: (v: FilterValue | undefined) => void;
}) {
  const start = (value as string[] | undefined)?.[0] ?? "";
  const end = (value as string[] | undefined)?.[1] ?? "";

  const handleChange = (newStart: string, newEnd: string) => {
    if (!newStart && !newEnd) {
      onChange(undefined);
      return;
    }
    onChange([newStart, newEnd]);
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        type="date"
        value={start}
        onChange={(e) => handleChange(e.target.value, end)}
        className="h-6 w-32 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
        aria-label="Start date"
      />
      <span className="text-xs text-muted-foreground">–</span>
      <Input
        type="date"
        value={end}
        onChange={(e) => handleChange(start, e.target.value)}
        className="h-6 w-32 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
        aria-label="End date"
      />
    </div>
  );
}

function NumberRangeControl({
  value,
  onChange,
}: {
  value: number[] | undefined;
  onChange: (v: FilterValue | undefined) => void;
}) {
  const lo = value?.[0] ?? "";
  const hi = value?.[1] ?? "";

  const handleChange = (newLo: string, newHi: string) => {
    const lo = newLo !== "" ? Number(newLo) : undefined;
    const hi = newHi !== "" ? Number(newHi) : undefined;
    if (lo === undefined && hi === undefined) {
      onChange(undefined);
      return;
    }
    onChange([lo ?? 0, hi ?? 0]);
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        value={String(lo)}
        onChange={(e) => handleChange(e.target.value, String(hi))}
        placeholder="min"
        className="h-6 w-20 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
        aria-label="Minimum value"
      />
      <span className="text-xs text-muted-foreground">–</span>
      <Input
        type="number"
        value={String(hi)}
        onChange={(e) => handleChange(String(lo), e.target.value)}
        placeholder="max"
        className="h-6 w-20 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
        aria-label="Maximum value"
      />
    </div>
  );
}

function MultiSelectControl({
  value,
  onChange,
}: {
  value: string[] | undefined;
  onChange: (v: FilterValue | undefined) => void;
}) {
  const [input, setInput] = React.useState("");
  const tags = (value as string[] | undefined) ?? [];

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    const next = [...tags, trimmed];
    onChange(next);
    setInput("");
  };

  const removeTag = (tag: string) => {
    const next = tags.filter((t) => t !== tag);
    onChange(next.length > 0 ? next : undefined);
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="hover:text-primary/60"
            aria-label={`Remove ${tag}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addTag(input);
          }
          if (e.key === "Backspace" && input === "" && tags.length > 0) {
            removeTag(tags[tags.length - 1]);
          }
        }}
        onBlur={() => {
          if (input.trim()) addTag(input);
        }}
        placeholder={tags.length === 0 ? "Add value…" : ""}
        className="h-6 min-w-[80px] max-w-[120px] border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
        aria-label="Add filter value"
      />
    </div>
  );
}

function SelectControl({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: FilterValue | undefined) => void;
}) {
  return (
    <Input
      value={value ?? ""}
      onChange={(e) =>
        onChange(e.target.value !== "" ? e.target.value : undefined)
      }
      placeholder="Value…"
      className="h-6 w-28 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
      aria-label="Filter value"
    />
  );
}

function TextControl({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: FilterValue | undefined) => void;
}) {
  return (
    <Input
      value={value ?? ""}
      onChange={(e) =>
        onChange(e.target.value !== "" ? e.target.value : undefined)
      }
      placeholder="Search…"
      className="h-6 w-28 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
      aria-label="Text search"
    />
  );
}

// ── Cross-filter chip ─────────────────────────────────────────────────────────

function CrossFilterChip({
  column,
  value,
  onRemove,
}: {
  column: string;
  value: FilterValue;
  onRemove: () => void;
}) {
  const display = Array.isArray(value) ? (value as string[]).join(", ") : String(value);
  return (
    <span className="flex items-center gap-1 rounded-full border border-amber-300/50 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300">
      <span className="text-amber-500 dark:text-amber-600">{column}</span>
      <span className="mx-0.5 text-amber-400">=</span>
      {display}
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 hover:text-amber-600 dark:hover:text-amber-400"
        aria-label={`Remove cross-filter on ${column}`}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
