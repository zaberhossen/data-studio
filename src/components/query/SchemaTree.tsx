"use client";

/**
 * SchemaTree — the Builder page's left rail (Supabase table-editor style): the
 * active source's table header + a searchable column list.
 *
 * Notebook UX (M12 Stage 2): each column row carries hover actions —
 *   • “+” adds the column to the query (dimension, or a SUM metric for
 *     numeric/metric-role columns) via the hoisted workspace draft.
 *   • “i” expands an inline PROFILE (rows, nulls, distinct, min/max) computed
 *     by ONE cheap DuckDB query over the resident table. Results are cached
 *     per source+column; only the tiny summary crosses to React — never rows.
 */

import * as React from "react";
import { Diamond, Hash, Info, Key, Loader2, Plus, Search, Table2, Type } from "lucide-react";
import { useEngine, useSources, useWorkspace } from "@/app/(app)/WorkspaceProvider";
import { newDraftDimension, newDraftMetric } from "@/lib/query/ir-draft";
import type { Field } from "@/lib/query/schema";

/** Pick a small type glyph for a column. */
function TypeGlyph({ field }: { field: Field }) {
  if (field.name.toLowerCase() === "id") return <Key className="h-3.5 w-3.5 text-amber-500" />;
  if (field.role === "metric") return <Hash className="h-3.5 w-3.5 text-muted-foreground" />;
  if (field.dataType === "number") return <Hash className="h-3.5 w-3.5 text-muted-foreground" />;
  if (field.dataType === "string") return <Type className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Diamond className="h-3 w-3 text-muted-foreground" />;
}

interface FieldProfile {
  total: number;
  nonNull: number;
  distinct: number;
  min: string | null;
  max: string | null;
}

type ProfileState = "loading" | { error: string } | FieldProfile;

/** Quote an identifier for the profile query (name comes from the allowlist). */
function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

export function SchemaTree() {
  const { activeSource } = useSources();
  const engine = useEngine();
  const ws = useWorkspace();
  // The workspace's EFFECTIVE fields — the active source's schema normally,
  // the promoted result set's columns during an explore session.
  const activeFields = ws.fields;

  const [search, setSearch] = React.useState("");
  const [openProfile, setOpenProfile] = React.useState<string | null>(null);
  const [profiles, setProfiles] = React.useState<Record<string, ProfileState>>({});

  const sourceReady = ws.explore !== null || activeSource?.status === "ready";
  // Keyed by table too, so an explore column never reuses a source profile.
  const profileKey = (column: string) => `${activeSource?.id ?? ""}:${ws.tableName}:${column}`;

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return activeFields;
    return activeFields.filter((f) => f.name.toLowerCase().includes(needle));
  }, [activeFields, search]);

  const addField = (f: Field) => {
    ws.setIrDraft((prev) =>
      f.role === "metric" || f.dataType === "number"
        ? { ...prev, metrics: [...prev.metrics, newDraftMetric("sum", f.name)] }
        : { ...prev, dimensions: [...prev.dimensions, newDraftDimension(f.name)] },
    );
  };

  const toggleProfile = (f: Field) => {
    const key = profileKey(f.name);
    if (openProfile === key) {
      setOpenProfile(null);
      return;
    }
    setOpenProfile(key);
    if (profiles[key] || !sourceReady) return;
    setProfiles((p) => ({ ...p, [key]: "loading" }));
    const c = q(f.name);
    const sql =
      `SELECT count(*) AS total, count(${c}) AS non_null, ` +
      `count(DISTINCT ${c}) AS uniq, min(${c}) AS mn, max(${c}) AS mx ` +
      `FROM ${q(ws.tableName)}`;
    engine
      .runSql(sql, { limit: 1, offset: 0 })
      .then((r) => {
        const row = r.rows[0] ?? [];
        const num = (v: unknown) => (v == null ? 0 : Number(v));
        const str = (v: unknown) => (v == null ? null : String(v));
        setProfiles((p) => ({
          ...p,
          [key]: {
            total: num(row[0]),
            nonNull: num(row[1]),
            distinct: num(row[2]),
            min: str(row[3]),
            max: str(row[4]),
          },
        }));
      })
      .catch((err: unknown) => {
        setProfiles((p) => ({
          ...p,
          [key]: { error: err instanceof Error ? err.message : "Profile failed." },
        }));
      });
  };

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex flex-col gap-0.5 border-b border-border px-3 py-2.5">
        <span className="truncate text-base font-semibold">Query builder</span>
        <span className="truncate text-xs text-muted-foreground">
          {ws.explore ? "SQL results" : activeSource?.name}
        </span>
      </div>

      <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Schema
        </span>
        {activeFields.length > 0 && (
          <span className="text-xs text-muted-foreground">{activeFields.length}</span>
        )}
      </div>

      {activeFields.length > 0 && (
        <div className="relative px-3 pb-1.5">
          <Search className="pointer-events-none absolute left-5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search columns"
            aria-label="Search columns"
            className="h-7 w-full rounded-md border border-strong bg-surface-100 pl-6 pr-2 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-stronger focus:border-stronger"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {activeSource?.status === "connecting" ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading schema…
          </div>
        ) : activeFields.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No columns available.</div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No columns match “{search.trim()}”.
          </div>
        ) : (
          filtered.map((f) => {
            const key = profileKey(f.name);
            const open = openProfile === key;
            const profile = profiles[key];
            return (
              <div key={f.name}>
                <div
                  className="group flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
                  title={`${f.name} · ${f.dataType}`}
                >
                  <TypeGlyph field={f} />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground group-hover:hidden">
                    {f.dataType}
                  </span>
                  <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                    <button
                      type="button"
                      onClick={() => addField(f)}
                      aria-label={
                        f.role === "metric" || f.dataType === "number"
                          ? `Add SUM of ${f.name}`
                          : `Group by ${f.name}`
                      }
                      title={
                        f.role === "metric" || f.dataType === "number"
                          ? "Add as SUM metric"
                          : "Add to Group by"
                      }
                      className="rounded p-0.5 text-muted-foreground hover:bg-surface-300 hover:text-foreground"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleProfile(f)}
                      aria-label={`Profile ${f.name}`}
                      aria-expanded={open}
                      title={sourceReady ? "Column profile" : "Load the source first"}
                      disabled={!sourceReady}
                      className="rounded p-0.5 text-muted-foreground hover:bg-surface-300 hover:text-foreground disabled:opacity-40"
                    >
                      <Info className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>

                {open && (
                  <div className="mx-3 mb-1.5 rounded-md border border-border bg-surface-100 px-2.5 py-2 text-xs">
                    {profile === "loading" || profile === undefined ? (
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Profiling…
                      </span>
                    ) : "error" in profile ? (
                      <span className="text-destructive">{profile.error}</span>
                    ) : (
                      <dl className="space-y-0.5 text-muted-foreground">
                        <ProfileRow label="Rows" value={profile.total.toLocaleString()} />
                        <ProfileRow
                          label="Nulls"
                          value={`${(profile.total - profile.nonNull).toLocaleString()} (${
                            profile.total > 0
                              ? (((profile.total - profile.nonNull) / profile.total) * 100).toFixed(1)
                              : "0.0"
                          }%)`}
                        />
                        <ProfileRow label="Distinct" value={profile.distinct.toLocaleString()} />
                        <ProfileRow label="Min" value={profile.min ?? "∅"} />
                        <ProfileRow label="Max" value={profile.max ?? "∅"} />
                      </dl>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0">{label}</dt>
      <dd className="truncate font-mono text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}
