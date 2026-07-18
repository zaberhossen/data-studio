/**
 * Sharing contract — the secret-free projection of a dashboard that a public
 * share token exposes, plus the share-link metadata.
 *
 * SECURITY: a share `snapshot` is a deliberate, isolated exception to the
 * "store definitions, never results" rule. Public sharing FREEZES each widget's
 * computed rows at share time so an unauthenticated viewer renders static data
 * and NEVER reaches the customer database, sees a `sourceId`/table, or receives
 * a `sql`/`ir` definition. The projection below is what crosses to the public
 * page — nothing identifying about the underlying sources leaks.
 */

import type {
  CanvasConfig,
  CanvasElement,
  CanvasLayout,
  DashboardTab,
  LayoutMode,
  WidgetLayout,
} from "@/lib/types/dashboard";
import type { QueryKind, WidgetViz } from "@/lib/types/query";
import type { ResultTable } from "@/lib/types/results";

export type SharePermission = "view" | "edit";
export type ShareMode = "link" | "embed";

/** A widget stripped of everything identifying — only what's needed to render. */
export interface PublicWidget {
  id: string;
  title: string;
  viz: WidgetViz;
  /** Kept for rendering hints only; carries no query/source detail. */
  queryKind: QueryKind;
  layout: WidgetLayout;
  canvasLayout?: CanvasLayout;
  kind?: "query";
  /** Page-view tab membership (safe to expose — no data). */
  tabId?: string;
}

/** A dashboard stripped to its renderable shell (no sources, no definitions). */
export interface PublicDashboard {
  name: string;
  layoutMode?: LayoutMode;
  canvas?: CanvasConfig;
  widgets: PublicWidget[];
  /** Decoration elements are safe to expose (they hold no data). */
  elements?: CanvasElement[];
  /** Page-view tabs (grid mode). */
  tabs?: DashboardTab[];
}

/**
 * The frozen payload a public token serves: the renderable shell + each
 * widget's computed page, captured at share (or refresh) time.
 */
export interface DashboardSnapshot {
  dashboard: PublicDashboard;
  /** widgetId → the widget's computed result page (already row-capped). */
  results: Record<string, ResultTable>;
  /** ISO timestamp the snapshot was captured. */
  createdAt: string;
}

/** Share-link metadata returned to the owner (never includes the snapshot). */
export interface ShareLinkMeta {
  id: string;
  token: string;
  permission: SharePermission;
  mode: ShareMode;
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
}
