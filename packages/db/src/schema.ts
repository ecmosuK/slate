/**
 * The Slate data model.
 *
 * Conventions (see the shared README): UUIDv7 identifiers, UTC ISO-8601 timestamps, integer minor
 * units for money, content-addressed files. The YAML state of a Yjs document is stored base64
 * encoded because Postgres bytea round-trips badly through JSON tooling.
 */

import { relations } from "drizzle-orm";
import {
  boolean,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  avatarFileId: uuid("avatar_file_id"),
  passwordHash: text("password_hash").notNull(),
  totpSecret: text("totp_secret"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  icon: text("icon"),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.userId] }),
  }),
);

export const pages = pgTable("pages", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  title: text("title").notNull().default(""),
  icon: text("icon"),
  coverFileId: uuid("cover_file_id"),
  coverOffset: integer("cover_offset").default(50),
  /** Compacted Yjs snapshot, base64 encoded. */
  yjsState: bytea("yjs_state"),
  position: text("position").notNull(),
  isTemplate: boolean("is_template").default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const pagePermissions = pgTable(
  "page_permissions",
  {
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pageId, table.userId] }),
  }),
);

export const pageShares = pgTable("page_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  pageId: uuid("page_id")
    .notNull()
    .references(() => pages.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  mode: text("mode").notNull().default("view"),
  passwordHash: text("password_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Derived projection of the Yjs document. Rebuildable, never the source of truth. */
export const blocks = pgTable("blocks", {
  id: uuid("id").defaultRandom().primaryKey(),
  pageId: uuid("page_id")
    .notNull()
    .references(() => pages.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  type: text("type").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  position: text("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const databases = pgTable("databases", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  pageId: uuid("page_id").references(() => pages.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const databaseProperties = pgTable("database_properties", {
  id: uuid("id").defaultRandom().primaryKey(),
  databaseId: uuid("database_id")
    .notNull()
    .references(() => databases.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  options: jsonb("options").$type<Record<string, unknown>>().default({}),
  position: text("position").notNull(),
});

export const databaseRows = pgTable("database_rows", {
  id: uuid("id").defaultRandom().primaryKey(),
  databaseId: uuid("database_id")
    .notNull()
    .references(() => databases.id, { onDelete: "cascade" }),
  pageId: uuid("page_id").references(() => pages.id, { onDelete: "cascade" }),
  values: jsonb("values").$type<Record<string, unknown>>().notNull(),
  position: text("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** A page or tracker row linked to a folder on disk. */
export const projectLinks = pgTable("project_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  pageId: uuid("page_id").references(() => pages.id, { onDelete: "cascade" }),
  /** Absolute path to the project folder. */
  folderPath: text("folder_path").notNull(),
  readmePath: text("readme_path").notNull().default("README.md"),
  /** The folder the user explicitly approved. Writes outside it are refused. */
  allowlistRoot: text("allowlist_root").notNull(),
  syncEnabled: boolean("sync_enabled").default(true),
  stage: text("stage"),
  nextMilestone: text("next_milestone"),
  nextDue: date("next_due"),
  lastWrittenSha256: text("last_written_sha256"),
  lastWrittenAt: timestamp("last_written_at", { withTimezone: true }),
  lastError: text("last_error"),
});

export const repoFacts = pgTable("repo_facts", {
  projectLinkId: uuid("project_link_id")
    .primaryKey()
    .references(() => projectLinks.id, { onDelete: "cascade" }),
  branch: text("branch"),
  headSha: text("head_sha"),
  headAt: timestamp("head_at", { withTimezone: true }),
  dirty: boolean("dirty"),
  remoteUrl: text("remote_url"),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
});

/** A unit of agent work, claimed by a runner with a lease. */
export const agentJobs = pgTable("agent_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  projectLinkId: uuid("project_link_id").references(() => projectLinks.id, { onDelete: "set null" }),
  /** tap | request | api */
  source: text("source").notNull(),
  /** file | queue */
  transport: text("transport").notNull().default("queue"),
  prompt: text("prompt").notNull(),
  /** queued | claimed | running | done | failed | cancelled */
  status: text("status").notNull().default("queued"),
  runnerId: text("runner_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  branch: text("branch"),
  exitCode: integer("exit_code"),
  logPath: text("log_path"),
  provider: text("provider"),
  model: text("model"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costMicros: integer("cost_micros"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const pagesRelations = relations(pages, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [pages.workspaceId], references: [workspaces.id] }),
  parent: one(pages, { fields: [pages.parentId], references: [pages.id] }),
  children: many(pages),
  blocks: many(blocks),
  permissions: many(pagePermissions),
}));

export const projectLinksRelations = relations(projectLinks, ({ one }) => ({
  workspace: one(workspaces, { fields: [projectLinks.workspaceId], references: [workspaces.id] }),
  page: one(pages, { fields: [projectLinks.pageId], references: [pages.id] }),
  repoFacts: one(repoFacts, {
    fields: [projectLinks.id],
    references: [repoFacts.projectLinkId],
  }),
}));

export const agentJobsRelations = relations(agentJobs, ({ one }) => ({
  workspace: one(workspaces, { fields: [agentJobs.workspaceId], references: [workspaces.id] }),
  projectLink: one(projectLinks, {
    fields: [agentJobs.projectLinkId],
    references: [projectLinks.id],
  }),
}));
