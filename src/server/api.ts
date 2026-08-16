// ─────────────────────────────────────────────────────────────────
// Hono API — local persistence for graphs (GE-020).
//
// Mounted as Vite dev middleware at /api/*. Also runnable as a
// standalone Node server via `@hono/node-server` if we ever extract
// for deployment.
//
// Surface is tiny and idempotent: GET/POST list + create, GET/PUT/
// DELETE for a single graph. Merge stays client-side (GE-007 contract).
// Validation runs on every write via the v1.0 `validate()` function.
// ─────────────────────────────────────────────────────────────────

import { Hono } from 'hono'
import { and, asc, desc, eq } from 'drizzle-orm'
import { getDb } from './db/client'
import { graphs, annotations } from './db/schema'
import { registerExploreRoutes } from './routes/explore'
import type { Schema } from '../types'
import { validate } from '../schema/validate'

type GraphSummary = {
  id: string
  name: string
  updatedAt: string
}

export function createApp() {
  const app = new Hono()
  const db = getDb()

  // Read-side routes that compute rather than fetch: projection, search,
  // coverage and trails. Registered first so the graph CRUD below stays
  // recognisably a document store.
  registerExploreRoutes(app, db)

  // ── list ───────────────────────────────────────────────────
  app.get('/graphs', async (c) => {
    const rows = await db
      .select({ id: graphs.id, name: graphs.name, updatedAt: graphs.updatedAt })
      .from(graphs)
      .orderBy(desc(graphs.updatedAt))
    const summaries: GraphSummary[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      updatedAt: r.updatedAt.toISOString(),
    }))
    return c.json({ graphs: summaries })
  })

  // ── create ─────────────────────────────────────────────────
  app.post('/graphs', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { kind: 'invalid_json' } }, 400)
    }
    const { name, schema } = (body ?? {}) as { name?: string; schema?: Schema }
    if (!name || typeof name !== 'string') {
      return c.json({ error: { kind: 'missing_field', field: 'name' } }, 400)
    }
    if (!schema) {
      return c.json({ error: { kind: 'missing_field', field: 'schema' } }, 400)
    }
    try {
      const v = validate(schema)
      if (!v.ok) {
        return c.json({ error: { kind: 'invalid_schema', issues: v.errors } }, 422)
      }
    } catch (err) {
      return c.json({ error: { kind: 'invalid_schema', message: (err as Error).message } }, 422)
    }

    const [inserted] = await db
      .insert(graphs)
      .values({ name, data: schema })
      .returning({ id: graphs.id, name: graphs.name, updatedAt: graphs.updatedAt })
    return c.json({
      id: inserted.id,
      name: inserted.name,
      updatedAt: inserted.updatedAt.toISOString(),
    }, 201)
  })

  // ── get one ────────────────────────────────────────────────
  app.get('/graphs/:id', async (c) => {
    const id = c.req.param('id')
    const [row] = await db.select().from(graphs).where(eq(graphs.id, id)).limit(1)
    if (!row) return c.json({ error: { kind: 'not_found' } }, 404)
    return c.json({
      id: row.id,
      name: row.name,
      schema: row.data,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  })

  // ── replace ────────────────────────────────────────────────
  app.put('/graphs/:id', async (c) => {
    const id = c.req.param('id')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { kind: 'invalid_json' } }, 400)
    }
    const { name, schema } = (body ?? {}) as { name?: string; schema?: Schema }
    if (!schema) {
      return c.json({ error: { kind: 'missing_field', field: 'schema' } }, 400)
    }
    try {
      const v = validate(schema)
      if (!v.ok) {
        return c.json({ error: { kind: 'invalid_schema', issues: v.errors } }, 422)
      }
    } catch (err) {
      return c.json({ error: { kind: 'invalid_schema', message: (err as Error).message } }, 422)
    }

    const patch: { data: Schema; updatedAt: Date; name?: string } = {
      data: schema,
      updatedAt: new Date(),
    }
    if (typeof name === 'string' && name.length > 0) patch.name = name

    const [updated] = await db
      .update(graphs)
      .set(patch)
      .where(eq(graphs.id, id))
      .returning({ id: graphs.id, name: graphs.name, updatedAt: graphs.updatedAt })
    if (!updated) return c.json({ error: { kind: 'not_found' } }, 404)

    return c.json({
      id: updated.id,
      name: updated.name,
      updatedAt: updated.updatedAt.toISOString(),
    })
  })

  // ── delete ─────────────────────────────────────────────────
  app.delete('/graphs/:id', async (c) => {
    const id = c.req.param('id')
    const deleted = await db.delete(graphs).where(eq(graphs.id, id)).returning({ id: graphs.id })
    if (deleted.length === 0) return c.json({ error: { kind: 'not_found' } }, 404)
    return c.json({ ok: true })
  })

  // ── annotations (GE-023) ───────────────────────────────────
  // List annotations for a graph, oldest-first. Clients render thread
  // structure client-side via `parent_id` references.
  app.get('/graphs/:graphId/annotations', async (c) => {
    const graphId = c.req.param('graphId')
    const rows = await db
      .select()
      .from(annotations)
      .where(eq(annotations.graphId, graphId))
      .orderBy(asc(annotations.createdAt))
    return c.json({
      annotations: rows.map((r) => ({
        id: r.id,
        graphId: r.graphId,
        targetType: r.targetType,
        targetId: r.targetId,
        author: r.author,
        body: r.body,
        parentId: r.parentId,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  })

  app.post('/graphs/:graphId/annotations', async (c) => {
    const graphId = c.req.param('graphId')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { kind: 'invalid_json' } }, 400)
    }
    const input = (body ?? {}) as {
      targetType?: 'node' | 'link'
      targetId?: string
      author?: string
      body?: string
      parentId?: string | null
    }
    for (const field of ['targetType', 'targetId', 'author', 'body'] as const) {
      if (!input[field]) return c.json({ error: { kind: 'missing_field', field } }, 400)
    }
    if (input.targetType !== 'node' && input.targetType !== 'link') {
      return c.json({ error: { kind: 'invalid_target_type' } }, 400)
    }

    // If parentId provided, enforce one-level-deep reply constraint:
    // the parent must itself have parentId === null.
    if (input.parentId) {
      const [parent] = await db
        .select({ id: annotations.id, parentId: annotations.parentId })
        .from(annotations)
        .where(and(eq(annotations.id, input.parentId), eq(annotations.graphId, graphId)))
        .limit(1)
      if (!parent) return c.json({ error: { kind: 'invalid_parent' } }, 400)
      if (parent.parentId !== null) {
        return c.json({ error: { kind: 'reply_too_deep', message: 'Replies are limited to one level.' } }, 400)
      }
    }

    const [inserted] = await db
      .insert(annotations)
      .values({
        graphId,
        targetType: input.targetType,
        targetId: input.targetId!,
        author: input.author!,
        body: input.body!,
        parentId: input.parentId ?? null,
      })
      .returning()

    return c.json({
      id: inserted.id,
      graphId: inserted.graphId,
      targetType: inserted.targetType,
      targetId: inserted.targetId,
      author: inserted.author,
      body: inserted.body,
      parentId: inserted.parentId,
      createdAt: inserted.createdAt.toISOString(),
    }, 201)
  })

  app.delete('/annotations/:id', async (c) => {
    const id = c.req.param('id')
    // For MVP: anyone can delete. Real auth comes with GE-024's multi-user story.
    const deleted = await db.delete(annotations).where(eq(annotations.id, id)).returning({ id: annotations.id })
    if (deleted.length === 0) return c.json({ error: { kind: 'not_found' } }, 404)
    return c.json({ ok: true })
  })

  return app
}
