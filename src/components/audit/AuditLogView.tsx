"use client";

/**
 * AuditLogView — the /audit page: a read-only viewer over the org's security
 * audit log (share links created/revoked/viewed, and any future logged action).
 *
 * Admin/owner only: the API 403s non-admins and this view renders that as a
 * "restricted" panel. Data lives entirely server-side — this component fetches
 * bounded pages (keyset "Load more") and holds only the current list in state,
 * consistent with the invariant that React never holds unbounded row sets.
 *
 * Layout mirrors LogsView: a left filter rail (action chips with the live count
 * of the loaded window) and dense, monospace rows on the right.
 */

import * as React from "react";
import { useSession } from "next-auth/react";
import { AlertTriangle, Loader2, RefreshCw, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AuditLogPage, AuditLogRecord } from "@/lib/types/audit";

/** Short, human labels for the actions we emit today; unknown actions pass through. */
const ACTION_LABEL: Record<string, string> = {
  "share.create": "Share link created",
  "share.revoke": "Share link revoked",
  "share.view": "Public view",
};

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/** A settled color accent per action family (create/view = neutral, revoke = warn). */
function actionDot(action: string): string {
  if (action.endsWith(".revoke") || action.endsWith(".delete")) return "bg-amber-500";
  if (action.endsWith(".view")) return "bg-sky-500";
  return "bg-emerald-500";
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function actorLabel(e: AuditLogRecord): string {
  if (!e.actorUserId) return "Public token";
  return e.actorEmail ?? e.actorName ?? e.actorUserId;
}

function entityLabel(e: AuditLogRecord): string {
  if (!e.entityType) return "";
  return e.entityId ? `${e.entityType} · ${e.entityId}` : e.entityType;
}

function metadataLabel(metadata: unknown): string {
  if (metadata === null || metadata === undefined) return "";
  if (typeof metadata === "string") return metadata;
  try {
    return JSON.stringify(metadata);
  } catch {
    return "";
  }
}

export function AuditLogView() {
  const { data: session } = useSession();
  const role = session?.user?.role ?? null;
  const isAdmin = role === "owner" || role === "admin";

  const [entries, setEntries] = React.useState<AuditLogRecord[]>([]);
  const [actions, setActions] = React.useState<string[]>([]);
  const [action, setAction] = React.useState<string | null>(null);
  const [nextCursor, setNextCursor] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [forbidden, setForbidden] = React.useState(false);

  const buildUrl = React.useCallback(
    (cursor: number | null, act: string | null) => {
      const p = new URLSearchParams();
      if (cursor !== null) p.set("cursor", String(cursor));
      if (act !== null) p.set("action", act);
      const qs = p.toString();
      return `/api/audit-log${qs ? `?${qs}` : ""}`;
    },
    [],
  );

  /** (Re)load page 1 for the current action filter. */
  const load = React.useCallback(
    async (act: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(buildUrl(null, act), { cache: "no-store" });
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const page = (await res.json()) as AuditLogPage;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load audit log.");
      } finally {
        setLoading(false);
      }
    },
    [buildUrl],
  );

  const loadMore = React.useCallback(async () => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await fetch(buildUrl(nextCursor, action), { cache: "no-store" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const page = (await res.json()) as AuditLogPage;
      setEntries((prev) => [...prev, ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more.");
    } finally {
      setLoadingMore(false);
    }
  }, [buildUrl, nextCursor, action]);

  // Initial load: distinct actions (for the rail) + first page.
  React.useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/audit-log?actions=1", { cache: "no-store" });
        if (res.ok && !cancelled) {
          const { actions: a } = (await res.json()) as { actions: string[] };
          setActions(a);
        }
      } catch {
        /* the chip rail is optional chrome */
      }
    })();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load on mount; not derivable during render
    void load(null);
    return () => {
      cancelled = true;
    };
  }, [isAdmin, load]);

  const selectAction = React.useCallback(
    (act: string | null) => {
      setAction(act);
      void load(act);
    },
    [load],
  );

  if (!isAdmin || forbidden) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Admins only</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The audit log is available to organization owners and admins.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left: action filter rail ──────────────────────────────────── */}
      <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-sm font-semibold">Audit log</span>
          {action && (
            <Button variant="ghost" size="xs" onClick={() => selectAction(null)}>
              <X className="h-3.5 w-3.5" />
              Reset
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Action
          </div>
          <div className="space-y-0.5">
            <ActionRow
              label="All actions"
              active={action === null}
              onClick={() => selectAction(null)}
            />
            {actions.map((a) => (
              <ActionRow
                key={a}
                label={actionLabel(a)}
                dot={actionDot(a)}
                active={action === a}
                onClick={() => selectAction(a)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── Right: entries ────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          <span className="text-xs text-muted-foreground">
            {entries.length} {entries.length === 1 ? "event" : "events"}
            {nextCursor !== null ? "+" : ""} loaded
            {action ? ` · ${actionLabel(action)}` : ""}
          </span>
          <Button variant="outline" size="xs" onClick={() => void load(action)}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {error && (
            <div className="flex items-center gap-2 border-b border-border bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" /> {error}
            </div>
          )}

          {loading && entries.length === 0 ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading audit log…
            </div>
          ) : entries.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {action ? "No events match this action." : "No audit events recorded yet."}
            </div>
          ) : (
            <>
              <table className="w-full border-collapse text-xs">
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-b border-border/60 align-top hover:bg-accent/50">
                      <td className="w-44 whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">
                        {formatTs(e.createdAt)}
                      </td>
                      <td className="w-6 py-2.5">
                        <span className={cn("block h-1.5 w-1.5 rounded-full", actionDot(e.action))} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 font-medium text-foreground">
                        {actionLabel(e.action)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">
                        {actorLabel(e)}
                      </td>
                      <td className="px-2 py-2 font-mono text-muted-foreground">
                        {entityLabel(e)}
                        {metadataLabel(e.metadata) && (
                          <span className="ml-2 text-muted-foreground/70">
                            {metadataLabel(e.metadata)}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-muted-foreground">
                        {e.ip ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {nextCursor !== null && (
                <div className="flex justify-center p-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionRow({
  label,
  dot,
  active,
  onClick,
}: {
  label: string;
  dot?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active ? "bg-secondary text-foreground" : "hover:bg-accent",
      )}
    >
      {dot ? (
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0" />
      )}
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}
