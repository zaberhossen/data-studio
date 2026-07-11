"use client";

/**
 * SchemaTree — the Builder page's left rail (Supabase table-editor style): the
 * active source's table header + its column list (name · role glyph · dataType).
 * Read-only browsing; field role/label curation still lives on /sources. Reads
 * the hoisted `useSources()` context — metadata only, never rows.
 */

import * as React from "react";
import { Diamond, Hash, Key, Loader2, Table2, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSources } from "@/app/(app)/WorkspaceProvider";
import type { Field } from "@/lib/query/schema";

/** Pick a small type glyph for a column. */
function TypeGlyph({ field }: { field: Field }) {
  if (field.name.toLowerCase() === "id") return <Key className="h-3.5 w-3.5 text-amber-500" />;
  if (field.role === "metric") return <Hash className="h-3.5 w-3.5 text-muted-foreground" />;
  if (field.dataType === "number") return <Hash className="h-3.5 w-3.5 text-muted-foreground" />;
  if (field.dataType === "string") return <Type className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Diamond className="h-3 w-3 text-muted-foreground" />;
}

export function SchemaTree() {
  const { activeSource, activeFields } = useSources();

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Table2 className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {activeSource?.name ?? "No source"}
        </span>
        {activeFields.length > 0 && (
          <span className="text-xs text-muted-foreground">{activeFields.length}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {activeSource?.status === "connecting" ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading schema…
          </div>
        ) : activeFields.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No columns available.</div>
        ) : (
          activeFields.map((f) => (
            <div
              key={f.name}
              className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
              title={`${f.name} · ${f.dataType}`}
            >
              <TypeGlyph field={f} />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span
                className={cn(
                  "shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground",
                )}
              >
                {f.dataType}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
