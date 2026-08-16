// ─────────────────────────────────────────────────────────────────
// Drizzle ORM schema (GE-020).
//
// Two tables:
//   - `graphs`      — one row per project. The entire v1.0 Schema is
//                     stored in a single JSONB column. Rationale:
//                     the API is full-schema PUT (dumb CRUD), so
//                     per-entity columns + joins add complexity
//                     without buying anything at MVP scale.
//   - `annotations` — reserved for GE-023. Separate row-per-annotation
//                     storage because annotations are appended
//                     independently of graph saves.
//   - `snapshots`   — the graph as it was before each write. Without
//                     these a change has no identity, /changes/:id
//                     cannot exist, and a trail cannot be compared
//                     against the model it was recorded against.
//   - `trails`      — saved exploration paths. Stored per-row rather than
//                     inside the graph blob because a trail belongs to a
//                     person, is written far more often than the graph,
//                     and must survive a re-import that rewrites the
//                     graph wholesale.
// ─────────────────────────────────────────────────────────────────

import { sql } from 'drizzle-orm'
import {
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import type { Schema } from '../../types'
import type { TrailStep, TrailState, TrailVisibility } from '../../schema/trail'

export const graphs = pgTable('graphs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // The entire v1.0 Schema value, typed through the JSONB column.
  data: jsonb('data').$type<Schema>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type GraphRow = typeof graphs.$inferSelect
export type GraphInsert = typeof graphs.$inferInsert

export const annotations = pgTable('annotations', {
  id: uuid('id').primaryKey().defaultRandom(),
  graphId: uuid('graph_id')
    .notNull()
    .references(() => graphs.id, { onDelete: 'cascade' }),
  targetType: text('target_type', { enum: ['node', 'link'] }).notNull(),
  targetId: text('target_id').notNull(),
  author: text('author').notNull(),
  body: text('body').notNull(),
  // Self-referential FK set up via foreignKey() below to sidestep
  // the TS circular-reference issue on the column-level `.references`.
  parentId: uuid('parent_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  parentFk: foreignKey({
    columns: [table.parentId],
    foreignColumns: [table.id],
    name: 'annotations_parent_id_fk',
  }).onDelete('cascade'),
}))

export type AnnotationRow = typeof annotations.$inferSelect
export type AnnotationInsert = typeof annotations.$inferInsert

// Suppress the unused-import lint for `sql` — Drizzle uses it implicitly
// when inference fails; keep it imported for expression-level defaults.
export const _sql = sql

export const trails = pgTable('trails', {
  id: uuid('id').primaryKey().defaultRandom(),
  graphId: uuid('graph_id')
    .notNull()
    .references(() => graphs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  author: text('author').notNull(),
  visibility: text('visibility').$type<TrailVisibility>().notNull().default('personal'),
  state: text('state').$type<TrailState>().notNull().default('in_progress'),
  // The ordered path. Stored as JSONB because steps are only ever read
  // and written as a whole sequence — a trail is not queried step-wise.
  steps: jsonb('steps').$type<TrailStep[]>().notNull().default([]),
  tags: jsonb('tags').$type<string[]>(),
  // Provenance of a branch: which trail and which step it grew from.
  forkedFromTrailId: uuid('forked_from_trail_id'),
  forkedFromStepId: text('forked_from_step_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type TrailRow = typeof trails.$inferSelect
export type TrailInsert = typeof trails.$inferInsert

export const snapshots = pgTable('snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  graphId: uuid('graph_id')
    .notNull()
    .references(() => graphs.id, { onDelete: 'cascade' }),
  // The schema as it stood BEFORE the write that created this row, so a
  // change is always the diff between consecutive snapshots.
  data: jsonb('data').$type<Schema>().notNull(),
  /** Optional human label, e.g. "before OpenAPI re-import". */
  label: text('label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type SnapshotRow = typeof snapshots.$inferSelect
export type SnapshotInsert = typeof snapshots.$inferInsert
