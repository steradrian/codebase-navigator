// ─────────────────────────────────────────────────────────────────
// Read-side routes: projection, search, coverage, trails.
//
// Until now the server could answer exactly one question — "give me the
// whole graph" — and every piece of intelligence ran in the browser over
// a schema it had to load in full. That is the boundary the product's
// architecture depends on not crossing: the UI is supposed to ask what
// matters right now and receive a handful of entities, never the graph.
//
// Kept in its own module rather than added to api.ts, which is CRUD over
// a document. These routes compute.
//
// Every handler validates its query parameters against the closed unions
// they are meant to belong to. An unrecognised lens is an error, not a
// silent fallback to `overview` — a view that quietly answers a different
// question than the one asked is the failure mode this whole layer exists
// to avoid.
// ─────────────────────────────────────────────────────────────────

import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { graphs, snapshots, trails } from '../db/schema'
import type { getDb } from '../db/client'
import type { Altitude, Schema } from '../../types'
import { ALTITUDE_ORDER } from '../../schema/altitude'
import { computeProjection, LENS_PROFILES, type Lens } from '../../schema/projection'
import { computeCoverage } from '../../schema/coverage'
import { search } from '../../schema/search'
import { assessTrail, forkTrail, type Trail, type TrailStep } from '../../schema/trail'
import { summariseChange } from '../../schema/change'
import { assessIndexing } from '../../schema/indexing'

const LENSES = Object.keys(LENS_PROFILES) as Lens[]

const isLens = (v: string): v is Lens => (LENSES as string[]).includes(v)
const isAltitude = (v: string): v is Altitude => (ALTITUDE_ORDER as readonly string[]).includes(v)

/** Positive integer query parameter, or undefined when absent. */
function intParam(raw: string | undefined, name: string): number | undefined | { error: string } {
  if (raw === undefined || raw === '') return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return { error: name }
  return n
}

/** The concrete database handle, derived rather than restated. */
type Db = ReturnType<typeof getDb>

async function loadSchema(db: Db, graphId: string): Promise<Schema | null> {
  const [row] = await db.select().from(graphs).where(eq(graphs.id, graphId)).limit(1)
  return row?.data ?? null
}

const rowToTrail = (row: typeof trails.$inferSelect): Trail => ({
  id: row.id,
  name: row.name,
  description: row.description ?? undefined,
  author: row.author,
  visibility: row.visibility,
  state: row.state,
  steps: row.steps,
  tags: row.tags ?? undefined,
  forkedFrom:
    row.forkedFromTrailId && row.forkedFromStepId
      ? { trailId: row.forkedFromTrailId, stepId: row.forkedFromStepId }
      : undefined,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export function registerExploreRoutes(app: Hono, db: Db): void {
  // ── projection ─────────────────────────────────────────────
  app.get('/graphs/:graphId/projection', async (c) => {
    const schema = await loadSchema(db, c.req.param('graphId'))
    if (!schema) return c.json({ error: { kind: 'not_found' } }, 404)

    const focusId = c.req.query('focusId')
    if (!focusId) return c.json({ error: { kind: 'missing_field', field: 'focusId' } }, 400)

    const lensRaw = c.req.query('lens') ?? 'overview'
    if (!isLens(lensRaw)) {
      return c.json({ error: { kind: 'invalid_value', field: 'lens', allowed: LENSES } }, 400)
    }

    const altitudeRaw = c.req.query('altitude') ?? 'implementation'
    if (!isAltitude(altitudeRaw)) {
      return c.json(
        { error: { kind: 'invalid_value', field: 'altitude', allowed: ALTITUDE_ORDER } },
        400,
      )
    }

    const depth = intParam(c.req.query('depth'), 'depth')
    if (depth && typeof depth === 'object') {
      return c.json({ error: { kind: 'invalid_value', field: 'depth' } }, 400)
    }
    const budget = intParam(c.req.query('budget'), 'budget')
    if (budget && typeof budget === 'object') {
      return c.json({ error: { kind: 'invalid_value', field: 'budget' } }, 400)
    }

    // Trail arrives oldest-first as a comma-separated list, matching the
    // order ExplorationQuery expects.
    const trail = (c.req.query('trail') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    return c.json({
      data: computeProjection(schema, {
        focusId,
        lens: lensRaw,
        altitude: altitudeRaw,
        depth: depth as number | undefined,
        budget: budget as number | undefined,
        trail,
        now: c.req.query('now'),
      }),
    })
  })

  // ── search ─────────────────────────────────────────────────
  app.get('/graphs/:graphId/search', async (c) => {
    const schema = await loadSchema(db, c.req.param('graphId'))
    if (!schema) return c.json({ error: { kind: 'not_found' } }, 404)

    const q = c.req.query('q') ?? ''
    const limit = intParam(c.req.query('limit'), 'limit')
    if (limit && typeof limit === 'object') {
      return c.json({ error: { kind: 'invalid_value', field: 'limit' } }, 400)
    }
    return c.json({ data: search(schema, q, (limit as number | undefined) ?? 40) })
  })

  // ── coverage ───────────────────────────────────────────────
  app.get('/graphs/:graphId/coverage', async (c) => {
    const schema = await loadSchema(db, c.req.param('graphId'))
    if (!schema) return c.json({ error: { kind: 'not_found' } }, 404)
    return c.json({ data: computeCoverage(schema, { now: c.req.query('now') }) })
  })

  // ── changes: feed ──────────────────────────────────────────
  //
  // A change is the transition between two consecutive snapshots, so the
  // most recent change is "last snapshot -> current graph". Snapshots
  // hold the state BEFORE each write, which is what makes that pairing
  // work without storing anything twice.
  app.get('/graphs/:graphId/changes', async (c) => {
    const graphId = c.req.param('graphId')
    const [graph] = await db.select().from(graphs).where(eq(graphs.id, graphId)).limit(1)
    if (!graph) return c.json({ error: { kind: 'not_found' } }, 404)

    const rows = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.graphId, graphId))
      .orderBy(desc(snapshots.createdAt))

    // rows[0] is the state immediately before the current graph.
    const changes = rows.map((row, i) => {
      const after = i === 0 ? graph.data : rows[i - 1].data
      const { summary } = summariseChange(row.data, after)
      return {
        id: row.id,
        at: (i === 0 ? graph.updatedAt : rows[i - 1].createdAt).toISOString(),
        label: row.label ?? undefined,
        summary,
      }
    })

    return c.json({ changes })
  })

  // ── changes: one, with the full structural diff ────────────
  app.get('/changes/:id', async (c) => {
    const id = c.req.param('id')
    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, id)).limit(1)
    if (!row) return c.json({ error: { kind: 'not_found' } }, 404)

    const [graph] = await db.select().from(graphs).where(eq(graphs.id, row.graphId)).limit(1)
    if (!graph) return c.json({ error: { kind: 'not_found' } }, 404)

    // The state this snapshot gave way to: the next snapshot if one was
    // taken since, otherwise the graph as it stands now.
    const later = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.graphId, row.graphId))
      .orderBy(snapshots.createdAt)

    const index = later.findIndex((s) => s.id === id)
    const after = index >= 0 && index < later.length - 1 ? later[index + 1].data : graph.data

    return c.json({ data: { id: row.id, ...summariseChange(row.data, after) } })
  })

  // ── indexing status ────────────────────────────────────────
  app.get('/graphs/:graphId/indexing', async (c) => {
    const schema = await loadSchema(db, c.req.param('graphId'))
    if (!schema) return c.json({ error: { kind: 'not_found' } }, 404)
    return c.json({ data: assessIndexing(schema) })
  })

  // ── trails: list ───────────────────────────────────────────
  app.get('/graphs/:graphId/trails', async (c) => {
    const graphId = c.req.param('graphId')
    const author = c.req.query('author')

    const rows = await db
      .select()
      .from(trails)
      .where(author ? and(eq(trails.graphId, graphId), eq(trails.author, author)) : eq(trails.graphId, graphId))
      .orderBy(desc(trails.updatedAt))

    return c.json({ trails: rows.map(rowToTrail) })
  })

  // ── trails: create ─────────────────────────────────────────
  app.post('/graphs/:graphId/trails', async (c) => {
    const graphId = c.req.param('graphId')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { kind: 'invalid_json' } }, 400)
    }
    const { name, author, description, steps, tags, visibility } = (body ?? {}) as Partial<Trail>

    if (!name) return c.json({ error: { kind: 'missing_field', field: 'name' } }, 400)
    if (!author) return c.json({ error: { kind: 'missing_field', field: 'author' } }, 400)

    const [row] = await db
      .insert(trails)
      .values({
        graphId,
        name,
        author,
        description,
        tags,
        visibility: visibility ?? 'personal',
        steps: steps ?? [],
      })
      .returning()

    return c.json({ trail: rowToTrail(row) }, 201)
  })

  // ── trails: read, with freshness against the current model ──
  app.get('/trails/:id', async (c) => {
    const [row] = await db.select().from(trails).where(eq(trails.id, c.req.param('id'))).limit(1)
    if (!row) return c.json({ error: { kind: 'not_found' } }, 404)

    const schema = await loadSchema(db, row.graphId)
    const trail = rowToTrail(row)
    // Freshness is returned with the trail rather than on request:
    // replaying a stale trail silently would teach a reader something
    // that is no longer true.
    return c.json({
      trail,
      assessment: schema ? assessTrail(trail, schema) : null,
    })
  })

  // ── trails: update ─────────────────────────────────────────
  app.put('/trails/:id', async (c) => {
    const id = c.req.param('id')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { kind: 'invalid_json' } }, 400)
    }
    const patch = (body ?? {}) as Partial<Trail>

    const [row] = await db
      .update(trails)
      .set({
        name: patch.name,
        description: patch.description,
        visibility: patch.visibility,
        state: patch.state,
        steps: patch.steps as TrailStep[] | undefined,
        tags: patch.tags,
        updatedAt: new Date(),
      })
      .where(eq(trails.id, id))
      .returning()

    if (!row) return c.json({ error: { kind: 'not_found' } }, 404)
    return c.json({ trail: rowToTrail(row) })
  })

  // ── trails: fork ───────────────────────────────────────────
  app.post('/trails/:id/fork', async (c) => {
    const [row] = await db.select().from(trails).where(eq(trails.id, c.req.param('id'))).limit(1)
    if (!row) return c.json({ error: { kind: 'not_found' } }, 404)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { kind: 'invalid_json' } }, 400)
    }
    const { atStepId, name, author } = (body ?? {}) as {
      atStepId?: string
      name?: string
      author?: string
    }
    if (!atStepId) return c.json({ error: { kind: 'missing_field', field: 'atStepId' } }, 400)
    if (!author) return c.json({ error: { kind: 'missing_field', field: 'author' } }, 400)

    const source = rowToTrail(row)
    const forked = forkTrail(source, atStepId, {
      // The database assigns the real id; forkTrail only needs a value
      // to build a complete Trail, and the insert below overrides it.
      id: 'pending',
      name: name ?? `${source.name} (fork)`,
      author,
      at: new Date().toISOString(),
    })
    if (!forked) {
      return c.json({ error: { kind: 'not_found', field: 'atStepId' } }, 404)
    }

    const [created] = await db
      .insert(trails)
      .values({
        graphId: row.graphId,
        name: forked.name,
        description: forked.description,
        author: forked.author,
        visibility: forked.visibility,
        state: forked.state,
        steps: forked.steps,
        tags: forked.tags,
        forkedFromTrailId: row.id,
        forkedFromStepId: atStepId,
      })
      .returning()

    return c.json({ trail: rowToTrail(created) }, 201)
  })

  // ── trails: delete ─────────────────────────────────────────
  app.delete('/trails/:id', async (c) => {
    const [row] = await db.delete(trails).where(eq(trails.id, c.req.param('id'))).returning()
    if (!row) return c.json({ error: { kind: 'not_found' } }, 404)
    return c.json({ ok: true })
  })
}
