import { describe, expect, it } from 'vitest'
import type { Journey, Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { assignAltitudes } from '@/schema/altitude'
import { COVERAGE_DIMENSIONS, computeCoverage } from '@/schema/coverage'

const mkNode = (id: string, type: string, over: Partial<Node> = {}): Node => ({
  id, name: id, type, description: 'd', origin: 'auto:openapi', ...over,
})

const mkSchema = (nodes: Node[], journeys: Journey[] = [], domains: string[] = []): Schema =>
  assignAltitudes({
    meta: { name: 'C', version: SCHEMA_VERSION, domains },
    nodeTypes: {}, linkTypes: {},
    nodes, links: [], paths: [], journeys, annotations: [],
  })

const NOW = '2026-08-14T00:00:00Z'

describe('computeCoverage — applicability', () => {
  it('reports null rather than zero when a dimension does not apply', () => {
    // A domain with no behaviour has no outcomes to declare. Scoring it 0%
    // invents a gap; scoring it 100% invents knowledge.
    const s = mkSchema([mkNode('f', 'hook', { domain: 'ui' })])
    const ui = computeCoverage(s).domains.find((d) => d.domain === 'ui')!
    expect(ui.dimensions.behavior.value).toBeNull()
    expect(ui.dimensions.behavior.total).toBe(0)
  })

  it('reports freshness as unmeasurable without a clock', () => {
    const s = mkSchema([mkNode('a', 'api', { metadata: { lastModified: NOW } })])
    expect(computeCoverage(s).product.dimensions.freshness.value).toBeNull()
  })

  it('reports freshness as unmeasurable when nothing carries a date', () => {
    const s = mkSchema([mkNode('a', 'api')])
    expect(computeCoverage(s, { now: NOW }).product.dimensions.freshness.value).toBeNull()
  })

  it('excludes unmeasurable dimensions from the overall score', () => {
    const s = mkSchema([mkNode('f', 'hook', { entity: 'x', domain: 'ui' })])
    const ui = computeCoverage(s).domains.find((d) => d.domain === 'ui')!
    // entities is 1.0; behavior and freshness do not apply. A naive mean
    // over all eight would report 0.125 and look like near-total ignorance.
    expect(ui.overall).toBeGreaterThan(0.1)
    expect(ui.dimensions.entities.value).toBe(1)
  })

  it('returns a null overall when nothing at all is measurable', () => {
    expect(computeCoverage(mkSchema([])).product.overall).toBeNull()
  })
})

describe('computeCoverage — dimensions', () => {
  it('measures entity classification', () => {
    const s = mkSchema([
      mkNode('a', 'api', { entity: 'payment' }),
      mkNode('b', 'api'),
    ])
    expect(computeCoverage(s).product.dimensions.entities).toMatchObject({
      value: 0.5, covered: 1, total: 2,
    })
  })

  it('measures behaviour as operations that declare their outcomes', () => {
    const s = mkSchema([
      mkNode('op1', 'api', { domain: 'pay' }),
      mkNode('op1:outcome:401', 'outcome', { domain: 'pay' }),
      mkNode('op2', 'api', { domain: 'pay' }),
    ])
    const pay = computeCoverage(s).domains.find((d) => d.domain === 'pay')!
    expect(pay.dimensions.behavior).toMatchObject({ value: 0.5, covered: 1, total: 2 })
  })

  it('does not let outcome nodes pad the population being measured', () => {
    // Outcomes are the answer to behaviour coverage, not subjects of it.
    const s = mkSchema([
      mkNode('op', 'api', { domain: 'pay' }),
      ...Array.from({ length: 5 }, (_, i) =>
        mkNode(`op:outcome:${400 + i}`, 'outcome', { domain: 'pay' })),
    ])
    expect(computeCoverage(s).domains.find((d) => d.domain === 'pay')!.nodeCount).toBe(1)
  })

  it('measures journey participation', () => {
    const journey: Journey = {
      id: 'j', name: 'J', description: '', color: '#fff',
      steps: [{ id: 's', name: 'S', annotation: '', kind: 'action', nodeId: 'a' }],
      transitions: [],
    }
    const s = mkSchema([mkNode('a', 'api'), mkNode('b', 'api')], [journey])
    expect(computeCoverage(s).product.dimensions.journeys).toMatchObject({ value: 0.5 })
  })

  it('measures test linkage separately from evidence in general', () => {
    const s = mkSchema([
      mkNode('a', 'api', { evidence: [{ source: 'test' }] }),
      mkNode('b', 'api', { evidence: [{ source: 'git' }] }),
    ])
    const d = computeCoverage(s).product.dimensions
    expect(d.evidence.value).toBe(1)
    expect(d.tests.value).toBe(0.5)
  })

  it('counts rationale, not documentation of any kind, as why coverage', () => {
    const s = mkSchema([
      mkNode('a', 'api', { evidence: [{ source: 'documentation' }] }),
      mkNode('b', 'api', { evidence: [{ source: 'human' }] }),
      mkNode('c', 'api', { evidence: [{ source: 'git' }] }),
    ])
    expect(computeCoverage(s).product.dimensions.why).toMatchObject({ covered: 2, total: 3 })
  })

  it('reports runtime as uncovered rather than unmeasurable when nodes exist', () => {
    // Nothing produces runtime evidence yet, and 0% is the honest answer:
    // the question applies, and the answer is none.
    const s = mkSchema([mkNode('a', 'api')])
    expect(computeCoverage(s).product.dimensions.runtime.value).toBe(0)
  })

  it('treats recent attestation as fresh and old as stale', () => {
    const s = mkSchema([
      mkNode('fresh', 'api', { metadata: { lastModified: '2026-08-01T00:00:00Z' } }),
      mkNode('stale', 'api', { metadata: { lastModified: '2020-01-01T00:00:00Z' } }),
    ])
    expect(computeCoverage(s, { now: NOW }).product.dimensions.freshness)
      .toMatchObject({ value: 0.5, covered: 1, total: 2 })
  })

  it('lets a human confirmation refresh an otherwise old node', () => {
    const s = mkSchema([mkNode('a', 'api', {
      metadata: { lastModified: '2020-01-01T00:00:00Z' },
      evidence: [{ source: 'human', verifiedAt: '2026-08-01T00:00:00Z' }],
    })])
    expect(computeCoverage(s, { now: NOW }).product.dimensions.freshness.value).toBe(1)
  })
})

describe('computeCoverage — shape', () => {
  it('reports every dimension for every domain', () => {
    const s = mkSchema([mkNode('a', 'api', { domain: 'pay' })])
    const pay = computeCoverage(s).domains[0]
    for (const d of COVERAGE_DIMENSIONS) expect(pay.dimensions[d]).toBeDefined()
  })

  it('includes catalogued domains that have no nodes yet', () => {
    // A declared but unmapped domain is exactly the gap this view exists
    // to reveal, so it must not be silently absent.
    const s = mkSchema([mkNode('a', 'api', { domain: 'pay' })], [], ['pay', 'bonus'])
    expect(computeCoverage(s).domains.map((d) => d.domain)).toEqual(['bonus', 'pay'])
  })

  it('counts nodes belonging to no domain', () => {
    const s = mkSchema([mkNode('a', 'api', { domain: 'pay' }), mkNode('b', 'api')])
    expect(computeCoverage(s).unclassifiedNodes).toBe(1)
  })

  it('sorts domains by name for stable rendering', () => {
    const s = mkSchema([
      mkNode('a', 'api', { domain: 'zeta' }),
      mkNode('b', 'api', { domain: 'alpha' }),
    ])
    expect(computeCoverage(s).domains.map((d) => d.domain)).toEqual(['alpha', 'zeta'])
  })

  it('is deterministic', () => {
    const s = mkSchema([mkNode('a', 'api', { domain: 'pay', entity: 'payment' })])
    expect(JSON.stringify(computeCoverage(s, { now: NOW })))
      .toBe(JSON.stringify(computeCoverage(s, { now: NOW })))
  })
})
