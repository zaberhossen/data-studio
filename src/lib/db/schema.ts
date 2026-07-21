/**
 * Application database schema (Drizzle / Postgres).
 *
 * Tenancy model: every tenant-owned table carries an `orgId`. All reads/writes
 * are scoped through `lib/db/scope.ts` so a row from another org simply never
 * matches the `WHERE` — cross-tenant access is impossible by construction, not
 * by convention.
 *
 * Auth tables (`users`, `accounts`, `sessions`, `verificationTokens`) follow the
 * Auth.js Drizzle-adapter shape so NextAuth can own them directly; `users` adds a
 * nullable `passwordHash` for the Credentials provider.
 *
 * Persisted app entities hold DEFINITIONS ONLY — never query results, never raw
 * rows, never plaintext credentials (secrets are sealed via `lib/server/crypto`).
 */

import { relations, sql } from "drizzle-orm";
import {
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DataSourceKind, DataSourceStatus } from "@/lib/types/datasource";
import type { QueryDefinition } from "@/lib/types/query";
import type {
  CanvasConfig,
  CanvasLayout,
  DashboardFilter,
  DashboardTab,
  ElementContent,
  WidgetLayout,
} from "@/lib/types/dashboard";
import type { DashboardSnapshot } from "@/lib/types/share";

// ---------------------------------------------------------------------------
// Column helpers + enums
// ---------------------------------------------------------------------------

/** Raw binary column (Postgres `bytea`), surfaced to JS as a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const roleEnum = pgEnum("member_role", ["owner", "admin", "editor", "viewer"]);
export const layoutModeEnum = pgEnum("layout_mode", ["grid", "canvas"]);
export const widgetKindEnum = pgEnum("widget_kind", [
  "query",
  "text",
  "image",
  "shape",
  "line",
]);
export const sharePermissionEnum = pgEnum("share_permission", ["view", "edit"]);
export const shareModeEnum = pgEnum("share_mode", ["link", "embed"]);

// ---------------------------------------------------------------------------
// Auth.js tables (+ passwordHash)
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").notNull(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  /** Nullable: null for pure-OAuth users, set for Credentials sign-in. */
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  emailUnique: uniqueIndex("users_email_unique").on(sql`lower(${t.email})`),
}));

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<"oauth" | "oidc" | "email" | "webauthn">().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
  }),
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.identifier, t.token] }),
  }),
);

// ---------------------------------------------------------------------------
// Tenancy: organizations + memberships
// ---------------------------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgUserUnique: uniqueIndex("memberships_org_user_unique").on(t.orgId, t.userId),
    userIdx: index("memberships_user_idx").on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// Invitations (pending org memberships)
// ---------------------------------------------------------------------------

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lowercased invitee email. */
    email: text("email").notNull(),
    role: roleEnum("role").notNull().default("viewer"),
    /** Opaque, unguessable accept token (the capability — shared by the admin). */
    token: text("token").notNull().unique(),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    /** Set once accepted; a non-null value means the invite is spent. */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    /** Soft-revoke (kept for audit); a non-null value disables the token. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index("invitations_org_idx").on(t.orgId),
    emailIdx: index("invitations_email_idx").on(sql`lower(${t.email})`),
  }),
);

// ---------------------------------------------------------------------------
// Data sources (encrypted secrets)
// ---------------------------------------------------------------------------

export const dataSources = pgTable(
  "data_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<DataSourceKind>().notNull(),
    status: text("status").$type<DataSourceStatus>().notNull().default("idle"),
    tableName: text("table_name"),
    rowCount: integer("row_count"),
    error: text("error"),
    // Sealed connection secret (AES-256-GCM). Never leaves the server.
    secretCiphertext: bytea("secret_ciphertext"),
    secretIv: bytea("secret_iv"),
    secretTag: bytea("secret_tag"),
    keyVersion: integer("key_version"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index("data_sources_org_idx").on(t.orgId),
  }),
);

// ---------------------------------------------------------------------------
// Folders (organize dashboards + saved queries)
// ---------------------------------------------------------------------------

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgParentIdx: index("folders_org_parent_idx").on(t.orgId, t.parentId),
  }),
);

// ---------------------------------------------------------------------------
// Saved queries
// ---------------------------------------------------------------------------

export const savedQueries = pgTable(
  "saved_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    /** Nullable → demo/in-memory source. */
    sourceId: uuid("source_id").references(() => dataSources.id, { onDelete: "set null" }),
    /** The full QueryDefinition (query | ir | sql | viz). */
    definition: jsonb("definition").$type<QueryDefinition>().notNull(),
    schemaVersion: integer("schema_version").notNull().default(2),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index("saved_queries_org_idx").on(t.orgId),
  }),
);

// ---------------------------------------------------------------------------
// Dashboards + widgets (widgets are a child table)
// ---------------------------------------------------------------------------

export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    layoutMode: layoutModeEnum("layout_mode").notNull().default("grid"),
    /** { width, height, background } when layoutMode = canvas. */
    canvas: jsonb("canvas").$type<CanvasConfig>(),
    filters: jsonb("filters").$type<DashboardFilter[]>(),
    /** Page-view tabs ([{id,name}]); absent/empty = a single untabbed page. */
    tabs: jsonb("tabs").$type<DashboardTab[]>(),
    /** Optimistic-lock counter: bumped on every save; a stale save is rejected. */
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgFolderIdx: index("dashboards_org_folder_idx").on(t.orgId, t.folderId),
  }),
);

export const widgets = pgTable(
  "widgets",
  {
    // App-generated stable id (`w_…`), NOT a DB uuid: persisted dashboard filter
    // targets reference it, so it must survive save/reassemble unchanged.
    id: text("id").primaryKey(),
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    /** Denormalized for single-clause tenant scoping (no join needed). */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    kind: widgetKindEnum("kind").notNull().default("query"),
    /** QueryDefinition when kind = 'query'. */
    definition: jsonb("definition").$type<QueryDefinition>(),
    /** Text/image/shape/line props when kind !== 'query'. */
    content: jsonb("content").$type<ElementContent>(),
    gridLayout: jsonb("grid_layout").$type<WidgetLayout>(),
    canvasLayout: jsonb("canvas_layout").$type<CanvasLayout>(),
    /** Page-view tab this item belongs to (null → the first tab). */
    tabId: text("tab_id"),
    sort: integer("sort").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dashboardIdx: index("widgets_dashboard_idx").on(t.dashboardId),
  }),
);

// ---------------------------------------------------------------------------
// Share links (public / embed)
// ---------------------------------------------------------------------------

export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    /** Opaque, unguessable, revocable independently of the dashboard id. */
    token: text("token").notNull().unique(),
    /**
     * DEPRECATED — public sharing is view-only (frozen snapshots), so this is
     * always "view" and is no longer read by the app. Kept as a column (defaults
     * "view") to avoid a Postgres enum-value migration; drop in a later cleanup.
     */
    permission: sharePermissionEnum("permission").notNull().default("view"),
    mode: shareModeEnum("mode").notNull().default("link"),
    /**
     * Frozen render payload (dashboard shell + per-widget result pages) served
     * to public viewers. A deliberate, isolated exception to "definitions only"
     * — see `types/share.ts`. Public viewers thus never touch the customer DB.
     */
    snapshot: jsonb("snapshot").$type<DashboardSnapshot>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dashboardIdx: index("share_links_dashboard_idx").on(t.dashboardId),
  }),
);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null when the actor is an unauthenticated public share token. */
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgCreatedIdx: index("audit_log_org_created_idx").on(t.orgId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  dataSources: many(dataSources),
  dashboards: many(dashboards),
  savedQueries: many(savedQueries),
  folders: many(folders),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  org: one(organizations, {
    fields: [memberships.orgId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export const dashboardsRelations = relations(dashboards, ({ one, many }) => ({
  org: one(organizations, {
    fields: [dashboards.orgId],
    references: [organizations.id],
  }),
  widgets: many(widgets),
}));

export const widgetsRelations = relations(widgets, ({ one }) => ({
  dashboard: one(dashboards, {
    fields: [widgets.dashboardId],
    references: [dashboards.id],
  }),
}));
