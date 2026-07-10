"use client";

/**
 * ShareDialog — create / copy / revoke public share links for a dashboard.
 *
 * Creating a link FREEZES a snapshot: it captures every widget's currently
 * computed rows (via the scheduler) and uploads a secret-free render payload, so
 * a public viewer renders static data and never reaches the source. Existing
 * links are listed with copy + revoke; a note makes the frozen-data behavior
 * explicit and offers re-sharing to refresh.
 */

import * as React from "react";
import { Check, Copy, Link2, Loader2, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Dashboard } from "@/lib/types/dashboard";
import type { ShareLinkMeta } from "@/lib/types/share";
import type { QueryScheduler } from "@/hooks/useQueryScheduler";
import { buildSnapshot } from "@/lib/dashboard/snapshot";
import { getShareStore, publicUrlFor } from "@/lib/share/store";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboard: Dashboard;
  scheduler: QueryScheduler;
}

export function ShareDialog({ open, onOpenChange, dashboard, scheduler }: Props) {
  const store = React.useMemo(() => getShareStore(), []);
  const [links, setLinks] = React.useState<ShareLinkMeta[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !dashboard.id) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-open: sets loading state around an async list() request
    setLoading(true);
    setError(null);
    store
      .list(dashboard.id)
      .then((l) => !cancelled && setLinks(l))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, dashboard.id, store]);

  const active = links.filter((l) => !l.revokedAt);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const snapshot = await buildSnapshot(dashboard, scheduler);
      const link = await store.create(dashboard.id, snapshot);
      setLinks((prev) => [link, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    const prev = links;
    setLinks((l) => l.filter((x) => x.id !== id)); // optimistic
    try {
      await store.revoke(id);
    } catch (e) {
      setLinks(prev); // rollback
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share “{dashboard.name}”</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          A share link shows a <strong>snapshot</strong> of this dashboard&apos;s
          data, frozen at the moment you create it. Viewers need no account and
          never reach your data sources. Create a new link to refresh the data.
        </p>

        <Button onClick={create} disabled={creating} className="w-full">
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          {creating ? "Capturing snapshot…" : "Create share link"}
        </Button>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="max-h-64 space-y-2 overflow-auto">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading links…
            </div>
          ) : active.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No active links yet.
            </p>
          ) : (
            active.map((link) => <LinkRow key={link.id} link={link} onRevoke={() => revoke(link.id)} />)
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LinkRow({ link, onRevoke }: { link: ShareLinkMeta; onRevoke: () => void }) {
  const url = publicUrlFor(link.token);
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — the input is selectable as a fallback */
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-border p-2">
      <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="h-8 flex-1 text-xs" />
      <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={copy} title="Copy link">
        {copied ? <Check className="h-3.5 w-3.5 text-[color:var(--viz-good)]" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-destructive hover:bg-destructive/10"
        onClick={onRevoke}
        title="Revoke link"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
