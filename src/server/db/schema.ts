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
