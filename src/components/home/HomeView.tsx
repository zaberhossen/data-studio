"use client";

/**
 * HomeView — the project/workspace overview (Supabase project-home style).
 *
 * A status-overview row (engine health, active source, connected count, resident
 * rows) plus a connection-sources grid. Reads only metadata from the hoisted
 * `useSources()` / engine-status context — never raw rows. Clicking a source
 * activates it and routes to the data-sources page; the "Add source" card opens
 * the existing AddSourceDialog.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Globe,
  Layers,
  Loader2,
  Plus,
  Sparkles,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DataSourceKind } from "@/lib/types/datasource";
import { useSources, useEngineStatus } from "@/app/(app)/WorkspaceProvider";
import type { SourceView } from "@/hooks/useDataSources";
import { AddSourceDialog } from "@/components/sources/AddSourceDialog";
import { OnboardingChecklist } from "@/components/home/OnboardingChecklist";

const KIND_ICON: Record<DataSourceKind, React.ComponentType<{ className?: string }>> = {
  file: FileSpreadsheet,
  postgres: Database,
  mysql: Database,
  "http-file": Globe,
  "rest-api": Globe,
};

export function HomeView() {
  const router = useRouter();
  const { data } = useSession();
  const sources = useSources();
  const status = useEngineStatus();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const orgName = data?.user?.name ?? "Data Studio";
  const active = sources.activeSource;
  const readyCount = sources.sources.filter((s) => s.status === "ready").length;
  const residentRows = active?.status === "ready" ? active.rowCount : undefined;

  const openSource = (id: string) => {
    void sources.activate(id);
    router.push("/sources");
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">{orgName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Project overview</p>

        <OnboardingChecklist />

        {/* Status overview */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Engine status"
            value={
              status === "ready" ? "Healthy" : status === "booting" ? "Booting…" : "Error"
            }
            icon={
              status === "error" ? (
                <AlertCircle className="h-4 w-4 text-destructive" />
              ) : status === "booting" ? (
                <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              )
            }
          />
          <StatCard
            label="Active source"
            value={active?.name ?? "None"}
            icon={<Layers className="h-4 w-4 text-muted-foreground" />}
          />
          <StatCard
            label="Connected"
            value={`${readyCount} / ${sources.sources.length}`}
            icon={<Database className="h-4 w-4 text-muted-foreground" />}
          />
          <StatCard
            label="Resident rows"
            value={
              typeof residentRows === "number" ? residentRows.toLocaleString() : "—"
            }
            icon={<Activity className="h-4 w-4 text-muted-foreground" />}
          />
        </div>

        {/* Connection sources */}
        <div className="mt-10 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Data sources</h2>
          <span className="text-xs text-muted-foreground">
            {sources.listLoading ? "Loading…" : `${sources.sources.length} connected`}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sources.sources.map((s) => (
            <SourceCard key={s.id} source={s} onOpen={() => openSource(s.id)} />
          ))}
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="flex min-h-[92px] items-center justify-center gap-2 rounded-md border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
            Add source
          </button>
        </div>
      </div>

      <AddSourceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onAddServer={sources.addServerSource}
        onAddFile={sources.addFileSource}
        rotating={null}
        onRotate={sources.rotateSource}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="p-4 shadow-none">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-2 truncate text-lg font-medium" title={value}>
        {value}
      </p>
    </Card>
  );
}

function SourceCard({ source, onOpen }: { source: SourceView; onOpen: () => void }) {
  const Icon = source.builtin ? Sparkles : KIND_ICON[source.kind];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col gap-3 rounded-md border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{source.name}</span>
          <span className="block text-xs capitalize text-muted-foreground">
            {source.builtin ? "Demo dataset" : source.kind}
          </span>
        </span>
      </div>
      <SourceStatusLine source={source} />
    </button>
  );
}

function SourceStatusLine({ source }: { source: SourceView }) {
  if (source.status === "connecting") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Connecting…
      </span>
    );
  }
  if (source.status === "error") {
    return (
      <span className="flex items-center gap-1.5 truncate text-xs text-destructive">
        <AlertCircle className="h-3 w-3 shrink-0" /> {source.error ?? "Error"}
      </span>
    );
  }
  if (source.status === "ready") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn("h-1.5 w-1.5 rounded-full bg-emerald-500")} />
        {typeof source.rowCount === "number"
          ? `Ready · ${source.rowCount.toLocaleString()} rows`
          : "Ready"}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
      Not loaded
    </span>
  );
}
