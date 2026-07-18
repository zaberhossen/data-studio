"use client";

/**
 * MultiValueInput — chip-style entry for multi-value filter operators
 * (`in` / `not_in` in the advanced builder).
 *
 * Type a value then Enter or comma to commit it as a chip; Backspace on an
 * empty field removes the last chip; each chip has its own remove button.
 * Values are plain strings here — the IR compiler binds them as params and
 * validates against the column's type.
 *
 * shadcn primitives: Input, Badge (chip), Button (chip remove via icon).
 * States: empty (placeholder), with chips, focused.
 */

import * as React from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface MultiValueInputProps {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  "aria-label"?: string;
}

export function MultiValueInput({
  values,
  onChange,
  placeholder = "Type a value, press Enter",
  "aria-label": ariaLabel,
}: MultiValueInputProps) {
  const [draft, setDraft] = React.useState("");

  const commit = React.useCallback(() => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  }, [draft, values, onChange]);

  const removeAt = (i: number) =>
    onChange(values.filter((_, idx) => idx !== i));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "" && values.length) {
      removeAt(values.length - 1);
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm",
        "focus-within:ring-1 focus-within:ring-ring",
      )}
    >
      {values.map((v, i) => (
        <Badge key={`${v}-${i}`} variant="secondary" className="gap-1">
          {v}
          <button
            type="button"
            onClick={() => removeAt(i)}
            aria-label={`Remove ${v}`}
            className="rounded-sm opacity-70 hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        aria-label={ariaLabel ?? "Add value"}
        placeholder={values.length ? "" : placeholder}
        className="min-w-[6rem] flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
