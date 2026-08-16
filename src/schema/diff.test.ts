import { describe, expect, it } from 'vitest'
import type { Link, Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { computeDiff, isEmptyDiff } from '@/schema/diff'

const emptySchema = (): Schema => ({
  meta: { name: 't', version: SCHEMA_VERSION },
  nodeTypes: { service: { color: '#000', label: 'Service' } },
  linkTypes: { data_flow: { color: '#111', label: 'Data' } },
  nodes: [],
  links: [],
  paths: [],
  annotations: [],
})

const mkNode = (id: string, extra: Partial<Node> = {}): Node => ({
  id, name: id.toUpperCase(), type: 'service', description: '', origin: 'manual', ...extra,
})
const mkLink = (id: string, src: string, tgt: string, extra: Partial<Link> = {}): Link => ({
  id, source: src, target: tgt, label: '', description: '', type: 'data_flow', origin: 'manual', ...extra,
})

describe('computeDiff — emptiness', () => {
  it('identical schemas produce an empty diff', () => {
    const a = emptySchema(); a.nodes = [mkNode('x')]
    const b = emptySchema(); b.nodes = [mkNode('x')]
    const d = computeDiff(a, b)
    expect(isEmptyDiff(d)).toBe(true)
  })

  it('empty schemas produce an empty diff', () => {
    expect(isEmptyDiff(computeDiff(emptySchema(), emptySchema()))).toBe(true)
  })
})

describe('computeDiff — nodes', () => {
  it('detects added / removed / modified nodes', () => {
    const before = emptySchema()
    before.nodes = [mkNode('a', { description: 'old' }), mkNode('keep')]
    const after = emptySchema()
    after.nodes = [mkNode('a', { description: 'new' }), mkNode('keep'), mkNode('fresh')]

    const d = computeDiff(before, after)
    expect(d.nodes.added.map((n) => n.id)).toEqual(['fresh'])
    expect(d.nodes.removed).toEqual([])
    expect(d.nodes.modified).toHaveLength(1)
    expect(d.nodes.modified[0].after.id).toBe('a')
    expect(d.nodes.modified[0].changes).toHaveLength(1)
    expect(d.nodes.modified[0].changes[0].field).toBe('description')
    expect(d.nodes.modified[0].changes[0].before).toBe('old')
    expect(d.nodes.modified[0].changes[0].after).toBe('new')
  })

  it('skips non-tracked field changes', () => {
    // Changing origin alone should not register — it's identity, not content.
    const before = emptySchema(); before.nodes = [mkNode('a', { origin: 'manual' })]
    const after = emptySchema(); after.nodes = [mkNode('a', { origin: 'auto:openapi' })]
    const d = computeDiff(before, after)
    expect(isEmptyDiff(d)).toBe(true)
  })
})

describe('computeDiff — links', () => {
  it('detects added / removed / modified links', () => {
    const before = emptySchema()
    before.nodes = [mkNode('a'), mkNode('b')]
    before.links = [mkLink('l1', 'a', 'b', { label: 'old' })]

    const after = emptySchema()
    after.nodes = [mkNode('a'), mkNode('b'), mkNode('c')]
    after.links = [mkLink('l1', 'a', 'b', { label: 'new' }), mkLink('l2', 'b', 'c')]

    const d = computeDiff(before, after)
    expect(d.links.added.map((l) => l.id)).toEqual(['l2'])
    expect(d.links.modified.map((m) => m.after.id)).toEqual(['l1'])
    expect(d.links.modified[0].changes.find((c) => c.field === 'label')).toBeDefined()
  })
})

describe('computeDiff — paths', () => {
  it('detects added / removed / modified paths at step granularity', () => {
    const before = emptySchema()
    before.paths = [
      { id: 'p1', name: 'Flow', description: '', color: '#f0f', steps: [{ nodeId: 'a', annotation: 'go' }] },
      { id: 'pOld', name: 'Old', description: '', color: '#fff', steps: [] },
    ]
    const after = emptySchema()
    after.paths = [
      { id: 'p1', name: 'Flow', description: '', color: '#f0f', steps: [
        { nodeId: 'a', annotation: 'go' },
        { nodeId: 'b', annotation: 'then' },
      ] },
      { id: 'pNew', name: 'New', description: '', color: '#fff', steps: [] },
    ]

    const d = computeDiff(before, after)
    expect(d.paths.added.map((p) => p.id)).toEqual(['pNew'])
    expect(d.paths.removed.map((p) => p.id)).toEqual(['pOld'])
    expect(d.paths.modified.map((m) => m.after.id)).toEqual(['p1'])
    // The modified path's `steps` field shows up as a change
    expect(d.paths.modified[0].changes.find((c) => c.field === 'steps')).toBeDefined()
  })
})

describe('computeDiff — totals', () => {
  it('mirrors the per-collection counts', () => {
    const before = emptySchema(); before.nodes = [mkNode('a')]
    const after = emptySchema(); after.nodes = [mkNode('a', { description: 'x' }), mkNode('b')]
    const d = computeDiff(before, after)
    expect(d.totals.nodesAdded).toBe(1)
    expect(d.totals.nodesModified).toBe(1)
    expect(d.totals.nodesRemoved).toBe(0)
  })
})
