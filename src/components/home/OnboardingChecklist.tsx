"use client";

/**
 * OnboardingChecklist — a dismissible "getting started" card on the home page:
 * connect a source → run a query → build a dashboard → share it.
 *
 * Step completion is a monotonic latch (see `lib/onboarding.ts`): live signals
 * (client-side sources + run history, plus server facts from `/api/onboarding`)
 * are OR-merged onto the state persisted in localStorage, so a completed step
 * stays checked and survives reloads. The whole card is dismissible per org.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { ArrowRight, Check, Database, LayoutDashboard, Share2, Sparkles, Table2, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSources, useWorkspace } from "@/app/(app)/WorkspaceProvider";
import {
  completedCount,
  EMPTY_ONBOARDING,
  isComplete,
  mergeOnboarding,
  ONBOARDING_STEPS,
  type OnboardingState,
  type OnboardingStepId,
} from "@/lib/onboarding";

interface StepMeta {
  id: OnboardingStepId;
  title: string;
  description: string;
  href: string;
  cta: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STEP_META: Record<OnboardingStepId, StepMeta> = {
  source: {
    id: "source",
    title: "Connect a data source",
    description: "Upload a file or connect a database to bring in your data.",
    href: "/sources",
    cta: "Add source",
    icon: Database,
  },
  query: {
    id: "query",
    title: "Run your first query",
    description: "Explore your data in the table or SQL editor.",
    href: "/editor",
    cta: "Open editor",
    icon: Table2,
  },
  dashboard: {
    id: "dashboard",
    title: "Build a dashboard",
    description: "Add a chart or table widget to a dashboard.",
    href: "/dashboards",
    cta: "New dashboard",
    icon: LayoutDashboard,
  },
  share: {
    id: "share",
    title: "Share a dashboard",
    description: "Publish a link or embed to share results with others.",
    href: "/dashboards",
    cta: "Share",
    icon: Share2,
  },
};

interface Stored {
  state: OnboardingState;
  dismissed: boolean;
}

function storageKey(orgId: string | null | undefined): string {
  return `ds:onboarding:v1:${orgId ?? "none"}`;
}

function readStored(orgId: string | null | undefined): Stored {
  if (typeof window === "undefined") return { state: EMPTY_ONBOARDING, dismissed: false };
  try {
    const raw = window.localStorage.getItem(storageKey(orgId));
    if (!raw) return { state: EMPTY_ONBOARDING, dismissed: false };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      state: mergeOnboarding(parsed.state, {}),
      dismissed: Boolean(parsed.dismissed),
    };
  } catch {
    return { state: EMPTY_ONBOARDING, dismissed: false };
  }
}

export function OnboardingChecklist() {
  const router = useRouter();
  const { data: session } = useSession();
  const orgId = session?.user?.orgId ?? null;
  const sources = useSources();
  const { historyList } = useWorkspace();

  const [facts, setFacts] = React.useState<{
    hasSavedQuery: boolean;
    hasDashboardWidget: boolean;
    hasShareLink: boolean;
  } | null>(null);
  const [stored, setStored] = React.useState<Stored>(() => readStored(orgId));

  // Re-read persisted state when the active org changes.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reload latched state on org switch
    setStored(readStored(orgId));
  }, [orgId]);

  // Fetch durable server facts once per org.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/onboarding", { cache: "no-store" });
        if (res.ok && !cancelled) {
          setFacts(
            (await res.json()) as {
              hasSavedQuery: boolean;
              hasDashboardWidget: boolean;
              hasShareLink: boolean;
            },
          );
        }
      } catch {
        /* checklist degrades to client-only signals */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // Live signals from client state + server facts.
  const live = React.useMemo<Partial<OnboardingState>>(
    () => ({
      source: sources.sources.some((s) => !s.builtin),
      query: historyList.length > 0 || Boolean(facts?.hasSavedQuery),
      dashboard: Boolean(facts?.hasDashboardWidget),
      share: Boolean(facts?.hasShareLink),
    }),
    [sources.sources, historyList.length, facts],
  );

  const display = React.useMemo(() => mergeOnboarding(stored.state, live), [stored.state, live]);

  // Persist the latched state (side effect only — no setState).
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        storageKey(orgId),
        JSON.stringify({ state: display, dismissed: stored.dismissed } satisfies Stored),
      );
    } catch {
      /* storage unavailable — checklist still works for the session */
    }
  }, [orgId, display, stored.dismissed]);

  if (stored.dismissed) return null;

  const done = completedCount(display);
  const total = ONBOARDING_STEPS.length;
  const allDone = isComplete(display);

  const dismiss = () => setStored((s) => ({ ...s, dismissed: true }));

  return (
    <Card className="relative mt-6 overflow-hidden p-5 shadow-none">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss getting started"
        className="absolute right-3 top-3 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand" />
        <h2 className="text-sm font-semibold">{allDone ? "You're all set!" : "Getting started"}</h2>
        <span className="text-xs text-muted-foreground">
          {done} / {total}
        </span>
      </div>

      {/* Progress bar */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-brand transition-all"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>

      {allDone ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nice work — you&apos;ve connected data, explored it, and shared a dashboard. You can
          dismiss this card.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {ONBOARDING_STEPS.map((id) => {
            const meta = STEP_META[id];
            const complete = display[id];
            const Icon = meta.icon;
            return (
              <li
                key={id}
                className={cn(
                  "flex items-center gap-3 rounded-md px-2 py-2",
                  complete ? "opacity-60" : "hover:bg-accent/50",
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                    complete
                      ? "border-brand bg-brand text-primary-foreground"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {complete ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm font-medium", complete && "line-through")}>
                    {meta.title}
                  </span>
                  {!complete && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {meta.description}
                    </span>
                  )}
                </span>
                {!complete && (
                  <Button variant="outline" size="xs" onClick={() => router.push(meta.href)}>
                    {meta.cta}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
