import { describe, expect, it } from 'vitest'
import type { Journey, Link, Node, OutcomeKind, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { summariseChange } from '@/schema/change'

const node = (id: string, type: string, over: Partial<Node> = {}): Node => ({
  id, name: id, type, description: 'd', origin: 'auto:openapi', ...over,
})

const outcome = (opId: string, status: string, kind: OutcomeKind): Node =>
  node(`${opId}:outcome:${status}`, 'outcome', {
    name: `${status}`, metadata: { outcomeKind: kind },
  })

const link = (source: string, target: string, type: string): Link => ({
  id: `${source}__${type}__${target}`,
  source, target, label: type, description: '', type, origin: 'auto:openapi',
})

const mkSchema = (nodes: Node[], links: Link[] = [], journeys: Journey[] = []): Schema => ({
  meta: { name: 'C', version: SCHEMA_VERSION },
  nodeTypes: {}, linkTypes: {},
  nodes, links, paths: [], journeys, annotations: [],
})

describe('summariseChange — behaviour', () => {
  const op = node('op', 'api', { name: 'POST /deposit', domain: 'payment' })

  it('reports an outcome the operation gained', () => {
    const before = mkSchema([op, outcome('op', '200', 'success')], [link('op', 'op:outcome:200', 'outcome')])
    const after = mkSchema(
      [op, outcome('op', '200', 'success'), outcome('op', '429', 'rate_limited')],
      [link('op', 'op:outcome:200', 'outcome'), link('op', 'op:outcome:429', 'outcome')],
    )
    const { summary } = summariseChange(before, after)
    expect(summary.behavior).toEqual([{
      operationId: 'op',
      operationName: 'POST /deposit',
      addedOutcomes: ['rate_limited'],
      removedOutcomes: [],
    }])
  })

  it('reports an outcome the operation lost', () => {
    const before = mkSchema(
      [op, outcome('op', '200', 'success'), outcome('op', '401', 'permission_denied')],
      [link('op', 'op:outcome:200', 'outcome'), link('op', 'op:outcome:401', 'outcome')],
    )
    const after = mkSchema([op, outcome('op', '200', 'success')], [link('op', 'op:outcome:200', 'outcome')])
    expect(summariseChange(before, after).summary.behavior[0].removedOutcomes)
      .toEqual(['permission_denied'])
  })

  it('says nothing about behaviour when the branches are unchanged', () => {
    const s = mkSchema([op, outcome('op', '200', 'success')], [link('op', 'op:outcome:200', 'outcome')])
    expect(summariseChange(s, s).summary.behavior).toEqual([])
  })
})

describe('summariseChange — journeys', () => {
  const journey = (id: string, nodeId: string): Journey => ({
    id, name: id, description: '', color: '#fff',
    steps: [{ id: 's1', name: 'S', annotation: '', kind: 'action', nodeId }],
    transitions: [],
  })

  it('reports an added journey', () => {
    const before = mkSchema([node('a', 'api')])
    const after = mkSchema([node('a', 'api')], [], [journey('j1', 'a')])
    expect(summariseChange(before, after).summary.journeys)
      .toEqual([{ id: 'j1', name: 'j1', kind: 'added' }])
  })

  it('reports a journey whose own definition changed', () => {
    const before = mkSchema([node('a', 'api')], [], [journey('j1', 'a')])
    const after = mkSchema([node('a', 'api')], [], [{ ...journey('j1', 'a'), name: 'renamed' }])
    expect(summariseChange(before, after).summary.journeys[0].kind).toBe('changed')
  })

  it('reports a journey affected by an entity moving underneath it', () => {
    // The journey definition is untouched, but something it walks
    // through changed — which is exactly what a reader needs to know.
    const before = mkSchema([node('a', 'api', { description: 'old' })], [], [journey('j1', 'a')])
    const after = mkSchema([node('a', 'api', { description: 'new' })], [], [journey('j1', 'a')])
    expect(summariseChange(before, after).summary.journeys)
      .toEqual([{ id: 'j1', name: 'j1', kind: 'affected' }])
  })

  it('does not report journeys untouched by the change', () => {
    const before = mkSchema([node('a', 'api'), node('b', 'api', { description: 'old' })], [], [journey('j1', 'a')])
    const after = mkSchema([node('a', 'api'), node('b', 'api', { description: 'new' })], [], [journey('j1', 'a')])
    expect(summariseChange(before, after).summary.journeys).toEqual([])
  })
})

describe('summariseChange — blast surface', () => {
  it('names tests attached to what moved', () => {
    const f = node('codebase:file:src/a.ts', 'hook')
    const t = node('codebase:test:src/a.test.ts', 'test', { name: 'a.test.ts' })
    const l = link(t.id, f.id, 'tests')
    const before = mkSchema([{ ...f, description: 'old' }, t], [l])
    const after = mkSchema([{ ...f, description: 'new' }, t], [l])
    expect(summariseChange(before, after).summary.affectedTests).toEqual(['a.test.ts'])
  })

  it('flags documentation describing what moved as possibly stale', () => {
    const f = node('codebase:file:src/a.ts', 'hook')
    const d = node('docs:file:docs/a.md', 'document', { name: 'Deposits' })
    const l = link(d.id, f.id, 'documents')
    const before = mkSchema([{ ...f, description: 'old' }, d], [l])
    const after = mkSchema([{ ...f, description: 'new' }, d], [l])
    expect(summariseChange(before, after).summary.possiblyStaleDocs).toEqual(['Deposits'])
  })

  it('collects the domains a change touched', () => {
    const before = mkSchema([node('a', 'api', { domain: 'payment', description: 'old' })])
    const after = mkSchema([node('a', 'api', { domain: 'payment', description: 'new' })])
    expect(summariseChange(before, after).summary.affectedDomains).toEqual(['payment'])
  })
})

describe('summariseChange — confidence and triviality', () => {
  it('rates a change high when what moved carries evidence', () => {
    // Confidence is about how much of the change we can account for,
    // not about how dangerous it is.
    const before = mkSchema([node('a', 'api', { description: 'old' })])
    const after = mkSchema([node('a', 'api', {
      description: 'new', evidence: [{ source: 'static_analysis', confidence: 1 }],
    })])
    expect(summariseChange(before, after).summary.confidence).toBe('high')
  })

  it('rates it low when nothing that moved carries evidence', () => {
    const before = mkSchema([node('a', 'api', { description: 'old' })])
    const after = mkSchema([node('a', 'api', { description: 'new' })])
    expect(summariseChange(before, after).summary.confidence).toBe('low')
  })

  it('marks an identical pair of schemas as trivial', () => {
    const s = mkSchema([node('a', 'api')])
    expect(summariseChange(s, s).summary.trivial).toBe(true)
  })

  it('does not mark a real change as trivial', () => {
    const before = mkSchema([node('a', 'api', { description: 'old' })])
    const after = mkSchema([node('a', 'api', { description: 'new' })])
    expect(summariseChange(before, after).summary.trivial).toBe(false)
  })

  it('is deterministic', () => {
    const before = mkSchema([node('a', 'api', { description: 'old' })])
    const after = mkSchema([node('a', 'api', { description: 'new' })])
    expect(JSON.stringify(summariseChange(before, after)))
      .toBe(JSON.stringify(summariseChange(before, after)))
  })
})
