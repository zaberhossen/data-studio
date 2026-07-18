/**
 * Server-side dashboard store (Postgres / Drizzle) — the DB backing behind
 * `/api/dashboards`. Org-scoped like every tenant store: each method takes an
 * `AuthContext` and ANDs `requireOrg(...)`, so a dashboard from another org can
 * never be read, listed, saved, or deleted. Writes require an editor+ role.
 *
 * A `Dashboard` is DECOMPOSED into one `dashboards` row + N `widgets` child rows
 * on save (in a transaction) and REASSEMBLED on read. Widget ids are the app's
 * stable `w_…` strings (persisted filter targets reference them), so `save`
 * replaces the widget set by id rather than minting new ones.
 *
 * SERVER-ONLY.
 */

import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { dashboards, widgets } from "@/lib/db/schema";
import { assertCanWrite, requireOrg, type AuthContext } from "@/lib/db/scope";
import type { CanvasElement, Dashboard, ElementContent, Widget } from "@/lib/types/dashboard";
import type { QueryDefinition } from "@/lib/types/query";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Thrown by `save` when the caller's `expectedVersion` no longer matches the
 * stored row — i.e. another editor saved in between. Carries `status = 409` so
 * `errorResponse` maps it straight to a Conflict response.
 */
export class ConflictError extends Error {
  readonly status = 409;
  constructor(message = "This dashboard was changed by someone else since you opened it.") {
    super(message);
    this.name = "ConflictError";
  }
}

export type DashboardSummary = Pick<Dashboard, "id" | "name" | "updatedAt" | "layoutMode">;

/** The widget-only extras carried inside the `definition` jsonb alongside the
 *  query core (things that aren't part of `QueryDefinition`). */
type WidgetDefExtras = { clickBehavior?: Widget["clickBehavior"] };

/** Split a widget into its persisted definition core (id/title/layout stripped). */
function widgetDefinition(w: Widget): QueryDefinition & WidgetDefExtras {
  return {
    sourceId: w.sourceId,
    queryKind: w.queryKind,
    query: w.query,
    ir: w.ir,
    sql: w.sql,
    execution: w.execution,
    viz: w.viz,
    clickBehavior: w.clickBehavior,
  };
}

function rowToWidget(r: typeof widgets.$inferSelect): Widget {
  const def = (r.definition ?? {}) as QueryDefinition & WidgetDefExtras;
  return {
    ...def,
    id: r.id,
    title: r.title,
    kind: "query",
    layout: r.gridLayout ?? { x: 0, y: 0, w: 4, h: 4 },
    canvasLayout: r.canvasLayout ?? undefined,
    tabId: r.tabId ?? undefined,
  };
}

/** A non-query row (kind text/image/shape/line) → a `CanvasElement`. */
function rowToElement(r: typeof widgets.$inferSelect): CanvasElement {
  return {
    id: r.id,
    kind: (r.kind === "query" ? "text" : r.kind) as CanvasElement["kind"],
    canvasLayout: r.canvasLayout ?? { x: 0, y: 0, w: 240, h: 64 },
    // Grid box — present when the element (a text card) lives on the Page layout.
    layout: r.gridLayout ?? undefined,
    tabId: r.tabId ?? undefined,
    content: (r.content ?? { kind: "text", text: "" }) as ElementContent,
  };
}

export class DbDashboardStore {
  async list(ctx: AuthContext): Promise<DashboardSummary[]> {
    const rows = await db()
      .select({
        id: dashboards.id,
        name: dashboards.name,
        updatedAt: dashboards.updatedAt,
        layoutMode: dashboards.layoutMode,
      })
      .from(dashboards)
      .where(requireOrg(dashboards.orgId, ctx))
      .orderBy(desc(dashboards.updatedAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      updatedAt: r.updatedAt.getTime(),
      layoutMode: r.layoutMode ?? "grid",
    }));
  }

  async get(ctx: AuthContext, id: string): Promise<Dashboard | null> {
    if (!isUuid(id)) return null;
    const [head] = await db()
      .select()
      .from(dashboards)
      .where(and(requireOrg(dashboards.orgId, ctx), eq(dashboards.id, id)))
      .limit(1);
    if (!head) return null;

    const widgetRows = await db()
      .select()
      .from(widgets)
      .where(and(requireOrg(widgets.orgId, ctx), eq(widgets.dashboardId, id)))
      .orderBy(asc(widgets.sort));

    return {
      id: head.id,
      name: head.name,
      layoutMode: head.layoutMode ?? "grid",
      canvas: head.canvas ?? undefined,
      filters: head.filters ?? [],
      tabs: head.tabs ?? undefined,
      updatedAt: head.updatedAt.getTime(),
      version: head.version,
      widgets: widgetRows.filter((r) => (r.kind ?? "query") === "query").map(rowToWidget),
      elements: widgetRows.filter((r) => r.kind && r.kind !== "query").map(rowToElement),
    };
  }

  async create(
    ctx: AuthContext,
    name = "Untitled dashboard",
    layoutMode: Dashboard["layoutMode"] = "grid",
  ): Promise<Dashboard> {
    assertCanWrite(ctx);
    const mode = layoutMode ?? "grid";
    // A canvas dashboard gets its surface geometry at birth so the free-form
    // view renders without a client-side "ensure ready" pass.
    const canvas = mode === "canvas" ? { width: 1200, height: 800 } : null;
    const [row] = await db()
      .insert(dashboards)
      .values({
        orgId: ctx.orgId,
        name,
        layoutMode: mode,
        canvas,
        filters: [],
        createdBy: ctx.userId,
      })
      .returning();
    return {
      id: row.id,
      name: row.name,
      layoutMode: mode,
      canvas: canvas ?? undefined,
      filters: [],
      widgets: [],
      elements: [],
      updatedAt: row.updatedAt.getTime(),
      version: row.version,
    };
  }

  /**
   * Overwrite an existing dashboard (head + full widget set) in one transaction.
   * When `expectedVersion` is given, the head UPDATE is gated on the stored
   * `version` matching it (optimistic lock); a mismatch throws `ConflictError`
   * rather than silently clobbering a concurrent editor. The version is bumped on
   * every successful save. Omit `expectedVersion` to force (last-write-wins).
   */
  async save(
    ctx: AuthContext,
    dashboard: Dashboard,
    expectedVersion?: number,
  ): Promise<Dashboard | null> {
    assertCanWrite(ctx);
    if (!isUuid(dashboard.id)) return null;

    const now = new Date();
    return db().transaction(async (tx) => {
      // Atomic bump: the version guard lives in the WHERE so the check + write
      // can't race. `and(...)` drops an undefined clause, so no guard = force.
      const updated = await tx
        .update(dashboards)
        .set({
          name: dashboard.name,
          layoutMode: dashboard.layoutMode ?? "grid",
          canvas: dashboard.canvas ?? null,
          filters: dashboard.filters ?? [],
          tabs: dashboard.tabs ?? null,
          version: sql`${dashboards.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            requireOrg(dashboards.orgId, ctx),
            eq(dashboards.id, dashboard.id),
            expectedVersion != null ? eq(dashboards.version, expectedVersion) : undefined,
          ),
        )
        .returning({ version: dashboards.version });
      if (updated.length === 0) {
        // Zero rows = either the row is gone (404) or the version guard failed
        // (409). A cheap existence check distinguishes them.
        const [exists] = await tx
          .select({ id: dashboards.id })
          .from(dashboards)
          .where(and(requireOrg(dashboards.orgId, ctx), eq(dashboards.id, dashboard.id)))
          .limit(1);
        if (!exists) return null; // not found / not this org
        throw new ConflictError();
      }
      const nextVersion = updated[0].version;

      const rows = [
        ...dashboard.widgets.map((w, i) => ({
          id: w.id,
          dashboardId: dashboard.id,
          orgId: ctx.orgId,
          title: w.title,
          kind: "query" as const,
          definition: widgetDefinition(w),
          content: null,
          gridLayout: w.layout,
          canvasLayout: w.canvasLayout ?? null,
          tabId: w.tabId ?? null,
          sort: i,
          updatedAt: now,
        })),
        ...(dashboard.elements ?? []).map((e, j) => ({
          id: e.id,
          dashboardId: dashboard.id,
          orgId: ctx.orgId,
          title: "",
          kind: e.kind,
          definition: null,
          content: e.content,
          gridLayout: e.layout ?? null,
          canvasLayout: e.canvasLayout,
          tabId: e.tabId ?? null,
          sort: dashboard.widgets.length + j,
          updatedAt: now,
        })),
      ];
      // Reconcile the item set by id instead of delete-all + re-insert: drop
      // only rows no longer present, then UPSERT the current set (an unchanged
      // widget keeps its row identity + createdAt; a moved/edited one is updated
      // in place). Far less churn than mass delete/reinsert on every autosave.
      const keepIds = rows.map((r) => r.id);
      await tx.delete(widgets).where(
        and(
          requireOrg(widgets.orgId, ctx),
          eq(widgets.dashboardId, dashboard.id),
          keepIds.length ? notInArray(widgets.id, keepIds) : undefined,
        ),
      );

      if (rows.length > 0) {
        await tx
          .insert(widgets)
          .values(rows)
          .onConflictDoUpdate({
            target: widgets.id,
            set: {
              title: sql`excluded.title`,
              kind: sql`excluded.kind`,
              definition: sql`excluded.definition`,
              content: sql`excluded.content`,
              gridLayout: sql`excluded.grid_layout`,
              canvasLayout: sql`excluded.canvas_layout`,
              tabId: sql`excluded.tab_id`,
              sort: sql`excluded.sort`,
              updatedAt: now,
            },
          });
      }

      return {
        id: dashboard.id,
        name: dashboard.name,
        layoutMode: dashboard.layoutMode ?? "grid",
        canvas: dashboard.canvas,
        filters: dashboard.filters ?? [],
        tabs: dashboard.tabs,
        widgets: dashboard.widgets,
        elements: dashboard.elements ?? [],
        updatedAt: now.getTime(),
        version: nextVersion,
      };
    });
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    assertCanWrite(ctx);
    if (!isUuid(id)) return;
    // Widgets cascade via the dashboard FK (onDelete: cascade).
    await db()
      .delete(dashboards)
      .where(and(requireOrg(dashboards.orgId, ctx), eq(dashboards.id, id)));
  }
}

let store: DbDashboardStore | null = null;
export function getDashboardDbStore(): DbDashboardStore {
  if (!store) store = new DbDashboardStore();
  return store;
}
