import { describe, expect, it } from 'vitest'
import type { Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import {
  appendStep,
  assessTrail,
  forkTrail,
  trailFocusIds,
  type Trail,
  type TrailStep,
} from '@/schema/trail'

const step = (id: string, focusId: string, at: string): TrailStep => ({
  id, focusId, lens: 'overview', altitude: 'implementation', at,
})

const mkTrail = (steps: TrailStep[] = []): Trail => ({
  id: 't1',
  name: 'How auth works',
  author: 'Ada',
  visibility: 'personal',
  state: 'in_progress',
  steps,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
})

const mkNode = (id: string, lastModified?: string): Node => ({
  id, name: id, type: 'hook', description: 'd', origin: 'auto:codebase',
  metadata: lastModified ? { lastModified } : undefined,
})

const mkSchema = (nodes: Node[]): Schema => ({
  meta: { name: 'T', version: SCHEMA_VERSION },
  nodeTypes: {}, linkTypes: {},
  nodes, links: [], paths: [], journeys: [], annotations: [],
})

describe('appendStep', () => {
  it('adds a step and moves the updated timestamp', () => {
    const t = appendStep(mkTrail(), step('s1', 'a', '2026-08-02T00:00:00Z'))
    expect(t.steps).toHaveLength(1)
    expect(t.updatedAt).toBe('2026-08-02T00:00:00Z')
  })

  it('does not mutate the original', () => {
    const t = mkTrail()
    appendStep(t, step('s1', 'a', '2026-08-02T00:00:00Z'))
    expect(t.steps).toHaveLength(0)
  })
})

describe('forkTrail', () => {
  const source = mkTrail([
    step('s1', 'auth', '2026-08-01T00:00:00Z'),
    step('s2', 'session', '2026-08-01T01:00:00Z'),
    step('s3', 'jwt', '2026-08-01T02:00:00Z'),
  ])
  const input = { id: 't2', name: 'My branch', author: 'Lin', at: '2026-08-05T00:00:00Z' }

  it('keeps the shared prefix up to and including the branch point', () => {
    // Dropping the prefix would lose the context that made the branch
    // make sense in the first place.
    const forked = forkTrail(source, 's2', input)!
    expect(forked.steps.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('records where it branched from', () => {
    expect(forkTrail(source, 's2', input)!.forkedFrom).toEqual({ trailId: 't1', stepId: 's2' })
  })

  it('starts private no matter how the original was shared', () => {
    // Inheriting "recommended" would let anyone publish under someone
    // else's endorsement.
    const recommended: Trail = { ...source, visibility: 'recommended' }
    expect(forkTrail(recommended, 's1', input)!.visibility).toBe('personal')
  })

  it('starts in progress even when the original was complete', () => {
    const complete: Trail = { ...source, state: 'complete' }
    expect(forkTrail(complete, 's1', input)!.state).toBe('in_progress')
  })

  it('returns null for an unknown step', () => {
    expect(forkTrail(source, 'ghost', input)).toBeNull()
  })
})

describe('assessTrail', () => {
  const trail = mkTrail([
    step('s1', 'auth', '2026-08-01T00:00:00Z'),
    step('s2', 'session', '2026-08-01T00:00:00Z'),
  ])

  it('reports a fresh trail when nothing moved', () => {
    const s = mkSchema([mkNode('auth'), mkNode('session')])
    expect(assessTrail(trail, s).freshness).toBe('fresh')
  })

  it('marks a step whose entity no longer exists as missing', () => {
    const s = mkSchema([mkNode('auth')])
    const a = assessTrail(trail, s)
    expect(a.steps.find((x) => x.stepId === 's2')?.freshness).toBe('missing')
    expect(a.missingCount).toBe(1)
  })

  it('marks a step whose entity changed after the visit', () => {
    const s = mkSchema([mkNode('auth'), mkNode('session', '2026-08-10T00:00:00Z')])
    const a = assessTrail(trail, s)
    const changed = a.steps.find((x) => x.stepId === 's2')!
    expect(changed.freshness).toBe('changed')
    expect(changed.changedAt).toBe('2026-08-10T00:00:00Z')
  })

  it('does not flag a change that predates the visit', () => {
    const s = mkSchema([mkNode('auth'), mkNode('session', '2026-07-01T00:00:00Z')])
    expect(assessTrail(trail, s).freshness).toBe('fresh')
  })

  it('rates a vanished entity as worse than a changed one', () => {
    // A missing entity breaks the trail's thread outright; a changed one
    // can still be followed with a caveat.
    const s = mkSchema([mkNode('auth', '2026-08-10T00:00:00Z')])
    expect(assessTrail(trail, s).freshness).toBe('stale')
  })

  it('reports per-step detail so the UI can mark the specific break', () => {
    const s = mkSchema([mkNode('auth')])
    expect(assessTrail(trail, s).steps).toHaveLength(2)
  })
})

describe('trailFocusIds', () => {
  it('returns visited ids oldest first, deduplicated', () => {
    const t = mkTrail([
      step('s1', 'auth', '2026-08-01T00:00:00Z'),
      step('s2', 'session', '2026-08-01T01:00:00Z'),
      step('s3', 'auth', '2026-08-01T02:00:00Z'),
    ])
    // This is the shape ExplorationQuery.trail expects, so a saved trail
    // can seed a live projection.
    expect(trailFocusIds(t)).toEqual(['auth', 'session'])
  })
})
