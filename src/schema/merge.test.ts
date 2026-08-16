import { describe, expect, it } from 'vitest'
import type { Journey, Link, Node, Origin, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { merge } from '@/schema/merge'
import { validate } from '@/schema/validate'

// ─── fixture helpers ─────────────────────────────────────────

const emptySchema = (sources: Origin[] = []): Schema => ({
  meta: { name: 'Test', version: SCHEMA_VERSION, sources },
  nodeTypes: { service: { color: '#000', label: 'Service' }, database: { color: '#111', label: 'Database' } },
  linkTypes: { data_flow: { color: '#222', label: 'Data Flow' } },
  nodes: [],
  links: [],
  paths: [],
  annotations: [],
})

const mkNode = (id: string, origin: Origin, over: Partial<Node> = {}): Node => ({
  id,
  name: id.toUpperCase(),
  type: 'service',
  description: `Description of ${id}`,
  origin,
  ...over,
})

const mkLink = (id: string, source: string, target: string, origin: Origin, over: Partial<Link> = {}): Link => ({
  id,
  source,
  target,
  label: 'link',
  description: `Link from ${source} to ${target}`,
  type: 'data_flow',
  origin,
  ...over,
})

// ─── tests ───────────────────────────────────────────────────

describe('merge — trivial cases', () => {
  it('empty existing + non-empty candidate → candidate wins', () => {
    const existing = emptySchema()
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('a', 'auto:openapi')]

    const result = merge(existing, candidate)
    expect(result.schema.nodes).toHaveLength(1)
    expect(result.schema.nodes[0].id).toBe('a')
    expect(result.conflicts).toEqual([])
  })

  it('non-empty existing + empty candidate with matching origin drops auto entities', () => {
    // Explicit: candidate claims auto:openapi authority but has no entities,
    // so prior auto:openapi entities are dropped (no path refs blocking).
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi')]
    const candidate = emptySchema(['auto:openapi'])

    const result = merge(existing, candidate)
    expect(result.schema.nodes).toEqual([])
  })

  it('merge is pure — produces byte-identical output on repeated runs', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi'), mkNode('b', 'manual')]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('a', 'auto:openapi', { description: 'updated' })]

    const a = merge(existing, candidate)
    const b = merge(existing, candidate)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('merge — auto updates', () => {
  it('updates an auto node description when candidate provides a new one', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi', { description: 'old' })]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('a', 'auto:openapi', { description: 'new' })]

    const result = merge(existing, candidate)
    expect(result.schema.nodes[0].description).toBe('new')
    expect(result.conflicts).toEqual([])
  })

  it('adds a new auto node from the candidate', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi')]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('a', 'auto:openapi'), mkNode('b', 'auto:openapi')]

    const result = merge(existing, candidate)
    const ids = result.schema.nodes.map((n) => n.id)
    expect(ids).toEqual(['a', 'b'])
    expect(result.conflicts).toEqual([])
  })
})

describe('merge — manual override tracking', () => {
  it('preserves overridden field and logs the conflict', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [
      mkNode('a', 'auto:openapi', { description: 'user-edited', manualOverrides: ['description'] }),
    ]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('a', 'auto:openapi', { description: 'fresh from spec' })]

    const result = merge(existing, candidate)
    expect(result.schema.nodes[0].description).toBe('user-edited')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({
      kind: 'manual_override_wins',
      entityType: 'node',
      entityId: 'a',
      field: 'description',
    })
  })

  it('does not log a conflict when overridden field matches candidate', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [
      mkNode('a', 'auto:openapi', { description: 'same', manualOverrides: ['description'] }),
    ]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('a', 'auto:openapi', { description: 'same' })]

    const result = merge(existing, candidate)
    expect(result.conflicts).toEqual([])
  })
})

describe('merge — manual entities are sacred', () => {
  it('preserves a manual node and logs conflict when candidate has same ID as auto', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'manual', { description: 'human-authored' })]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('a', 'auto:openapi', { description: 'auto-generated' })]

    const result = merge(existing, candidate)
    expect(result.schema.nodes).toHaveLength(1)
    expect(result.schema.nodes[0].origin).toBe('manual')
    expect(result.schema.nodes[0].description).toBe('human-authored')
    expect(result.conflicts[0]).toMatchObject({
      kind: 'manual_shadows_auto_candidate',
      entityType: 'node',
      entityId: 'a',
    })
  })

  it('never drops a manual node, even when candidate is empty', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'manual')]
    const candidate = emptySchema(['auto:openapi'])

    const result = merge(existing, candidate)
    expect(result.schema.nodes).toHaveLength(1)
    expect(result.schema.nodes[0].id).toBe('a')
  })
})

describe('merge — deletion blocking', () => {
  it('blocks dropping an auto node referenced by a manual guided path', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi'), mkNode('b', 'auto:openapi')]
    existing.paths = [
      { id: 'p1', name: 'Flow', description: '', color: '#f0f', steps: [{ nodeId: 'a', annotation: 'start' }] },
    ]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('b', 'auto:openapi')] // 'a' no longer in spec

    const result = merge(existing, candidate)
    const ids = result.schema.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['a', 'b'])
    expect(result.conflicts[0]).toMatchObject({
      kind: 'manual_blocks_auto_deletion',
      entityType: 'node',
      entityId: 'a',
      blockedBy: { pathIds: ['p1'] },
    })
  })

  it('blocks dropping an auto node referenced by a manual link', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi'), mkNode('b', 'manual')]
    existing.links = [mkLink('l1', 'b', 'a', 'manual')]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [] // both 'a' and 'b' missing; 'b' is manual so kept anyway

    const result = merge(existing, candidate)
    const ids = result.schema.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['a', 'b'])
    const conflict = result.conflicts.find((c) => c.kind === 'manual_blocks_auto_deletion')
    expect(conflict).toBeDefined()
  })

  it('drops auto nodes when nothing manual references them', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi'), mkNode('b', 'auto:openapi')]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('b', 'auto:openapi')]

    const result = merge(existing, candidate)
    expect(result.schema.nodes.map((n) => n.id)).toEqual(['b'])
  })
})

describe('merge — cross-origin isolation', () => {
  it('leaves auto:codebase entities untouched when candidate only claims auto:openapi', () => {
    const existing = emptySchema(['auto:openapi', 'auto:codebase'])
    existing.nodes = [mkNode('a', 'auto:openapi'), mkNode('c', 'auto:codebase')]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [] // auto:openapi authority says 'a' is gone

    const result = merge(existing, candidate)
    const ids = result.schema.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['c']) // 'a' dropped (auto:openapi scope), 'c' preserved (out of scope)
  })
})

describe('merge — link orphan cleanup', () => {
  it('drops auto links whose source/target was deleted', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi'), mkNode('b', 'auto:openapi')]
    existing.links = [mkLink('l1', 'a', 'b', 'auto:openapi')]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('b', 'auto:openapi')] // 'a' gone

    const result = merge(existing, candidate)
    expect(result.schema.nodes.map((n) => n.id)).toEqual(['b'])
    expect(result.schema.links).toEqual([])
  })
})

describe('merge — output shape & validator round-trip', () => {
  it('produces a merged schema that passes the validator', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi')]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('a', 'auto:openapi', { description: 'updated' }), mkNode('b', 'auto:openapi')]
    candidate.links = [mkLink('l1', 'a', 'b', 'auto:openapi')]

    const result = merge(existing, candidate)
    const v = validate(result.schema)
    expect(v.errors).toEqual([])
  })

  it('preserves existing paths and annotations verbatim', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi'), mkNode('b', 'auto:openapi')]
    existing.paths = [
      { id: 'p1', name: 'Flow', description: '', color: '#f0f', steps: [{ nodeId: 'a', annotation: 'x' }] },
    ]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('a', 'auto:openapi'), mkNode('b', 'auto:openapi')]

    const result = merge(existing, candidate)
    expect(result.schema.paths).toEqual(existing.paths)
  })

  it('unions sources from both schemas', () => {
    const existing = emptySchema(['manual', 'auto:openapi'])
    const candidate = emptySchema(['auto:codebase'])

    const result = merge(existing, candidate)
    expect(result.schema.meta.sources).toEqual(['auto:codebase', 'auto:openapi', 'manual'])
  })

  it('does not mutate either input schema', () => {
    const existing = emptySchema(['auto:openapi'])
    existing.nodes = [mkNode('a', 'auto:openapi')]
    const candidate = emptySchema(['auto:openapi'])
    candidate.nodes = [mkNode('a', 'auto:openapi', { description: 'new' })]

    const existingSnapshot = JSON.stringify(existing)
    const candidateSnapshot = JSON.stringify(candidate)

    merge(existing, candidate)

    expect(JSON.stringify(existing)).toBe(existingSnapshot)
    expect(JSON.stringify(candidate)).toBe(candidateSnapshot)
  })
})

// ─── v1.3: journeys survive re-import ────────────────────────

describe('merge — journeys (v1.3)', () => {
  it('preserves existing journeys through a merge', () => {
    const journey: Journey = {
      id: 'j1',
      name: 'Deposit',
      description: '',
      color: '#fff',
      steps: [{ id: 's1', name: 'Submit', annotation: '', kind: 'action' }],
      transitions: [],
    }
    const existing: Schema = { ...emptySchema(['manual']), journeys: [journey] }
    const candidate: Schema = emptySchema(['auto:openapi'])

    expect(merge(existing, candidate).schema.journeys).toEqual([journey])
  })

  it('does not let an importer candidate clobber authored journeys', () => {
    const authored: Journey = {
      id: 'j1', name: 'Authored', description: '', color: '#fff', steps: [], transitions: [],
    }
    const existing: Schema = { ...emptySchema(['manual']), journeys: [authored] }
    const candidate: Schema = { ...emptySchema(['auto:openapi']), journeys: [] }

    expect(merge(existing, candidate).schema.journeys).toEqual([authored])
  })
})
