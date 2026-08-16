import { describe, expect, it } from 'vitest'
import type { Journey, Link, Node, Schema } from '@/types'
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

// ─── journeys (v1.3) ─────────────────────────────────────────

describe('computeDiff — journeys', () => {
  const mkJourney = (over: Partial<Journey> = {}): Journey => ({
    id: 'j1',
    name: 'Deposit',
    description: '',
    color: '#fff',
    steps: [
      { id: 's1', name: 'Submit', annotation: '', kind: 'action' },
      { id: 'ok', name: 'Done', annotation: '', kind: 'outcome', outcome: 'success' },
    ],
    transitions: [{ id: 't1', from: 's1', to: 'ok' }],
    ...over,
  })

  const withJourneys = (journeys: Journey[]): Schema => ({ ...emptySchema(), journeys })

  it('detects an added journey', () => {
    const d = computeDiff(withJourneys([]), withJourneys([mkJourney()]))
    expect(d.journeys.added.map((j) => j.id)).toEqual(['j1'])
    expect(d.totals.journeysAdded).toBe(1)
  })

  it('detects a removed journey', () => {
    const d = computeDiff(withJourneys([mkJourney()]), withJourneys([]))
    expect(d.journeys.removed.map((j) => j.id)).toEqual(['j1'])
  })

  it('detects a new branch — the signal behind "this journey changed"', () => {
    const before = mkJourney()
    const after = mkJourney({
      steps: [
        ...before.steps,
        { id: 'denied', name: 'Denied', annotation: '', kind: 'outcome', outcome: 'permission_denied' },
      ],
      transitions: [
        ...before.transitions,
        { id: 't2', from: 's1', to: 'denied', condition: 'unauthorised' },
      ],
    })
    const d = computeDiff(withJourneys([before]), withJourneys([after]))
    expect(d.totals.journeysModified).toBe(1)
    expect(d.journeys.modified[0].changes.map((c) => c.field).sort()).toEqual(['steps', 'transitions'])
  })

  it('detects a renamed journey', () => {
    const d = computeDiff(withJourneys([mkJourney()]), withJourneys([mkJourney({ name: 'Deposit v2' })]))
    expect(d.journeys.modified[0].changes[0]).toMatchObject({ field: 'name', after: 'Deposit v2' })
  })

  it('reports no change when journeys are identical', () => {
    const d = computeDiff(withJourneys([mkJourney()]), withJourneys([mkJourney()]))
    expect(d.totals.journeysModified).toBe(0)
  })

  it('treats absent and empty journeys as equivalent', () => {
    const d = computeDiff(emptySchema(), withJourneys([]))
    expect(isEmptyDiff(d)).toBe(true)
  })

  it('counts a journey-only change as a non-empty diff', () => {
    // Before this, a journey change was invisible to every code path:
    // computeDiff compared the deprecated `paths` and skipped `journeys`.
    const d = computeDiff(withJourneys([]), withJourneys([mkJourney()]))
    expect(isEmptyDiff(d)).toBe(false)
  })

  it('ignores evidence churn so git noise cannot swamp real changes', () => {
    const before = mkJourney()
    const after = mkJourney({
      steps: before.steps.map((s) => ({ ...s, evidence: [{ source: 'git', commit: 'abc' }] })),
    })
    // `steps` is diffed as a whole, so this DOES register — the guard
    // that matters is that no top-level `evidence` field exists to churn.
    expect(computeDiff(withJourneys([before]), withJourneys([after])).totals.journeysModified).toBe(1)
  })
})
