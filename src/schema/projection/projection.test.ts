import { describe, expect, it } from 'vitest'
import type { Journey, Link, Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { assignAltitudes } from '@/schema/altitude'
import { computeProjection } from '@/schema/projection'
import type { ExplorationQuery } from '@/schema/projection'

const mkNode = (id: string, type: string, over: Partial<Node> = {}): Node => ({
  id, name: id, type, description: `desc ${id}`, origin: 'auto:codebase', ...over,
})

const mkLink = (source: string, target: string, type?: string): Link => ({
  id: `${source}__${type ?? 'none'}__${target}`,
  source, target, label: `${source}->${target}`, description: '', type, origin: 'auto:codebase',
})

const mkSchema = (nodes: Node[], links: Link[] = [], over: Partial<Schema> = {}): Schema =>
  assignAltitudes({
    meta: { name: 'Proj', version: SCHEMA_VERSION, domains: [] },
    nodeTypes: {}, linkTypes: {},
    nodes, links, paths: [], journeys: [], annotations: [],
    ...over,
  })

const q = (over: Partial<ExplorationQuery> = {}): ExplorationQuery => ({
  focusId: 'focus', altitude: 'implementation', lens: 'overview', trail: [], ...over,
})

/** A focus surrounded by peers at implementation altitude. */
const web = (): Schema => {
  const nodes = [
    mkNode('focus', 'hook'),
    ...Array.from({ length: 8 }, (_, i) => mkNode(`n${i}`, 'component')),
  ]
  const links = Array.from({ length: 8 }, (_, i) => mkLink('focus', `n${i}`, 'dependency'))
  return mkSchema(nodes, links)
}

describe('computeProjection — basics', () => {
  it('returns the focus as its own entity', () => {
    const p = computeProjection(web(), q())
    expect(p.focus.id).toBe('focus')
    expect(p.focus.relationToFocus).toBe('self')
  })

  it('never includes the focus among the surrounding nodes', () => {
    const p = computeProjection(web(), q())
    expect(p.nodes.map((n) => n.id)).not.toContain('focus')
  })

  it('is deterministic — identical queries give identical results', () => {
    const s = web()
    expect(JSON.stringify(computeProjection(s, q()))).toBe(JSON.stringify(computeProjection(s, q())))
  })

  it('caps results at the budget and reports how many were considered', () => {
    const p = computeProjection(web(), q({ budget: 3 }))
    expect(p.nodes).toHaveLength(3)
    expect(p.meta.totalCandidates).toBeGreaterThanOrEqual(8)
    expect(p.meta.budget).toBe(3)
  })

  it('only returns nodes at the requested altitude', () => {
    const s = mkSchema(
      [mkNode('focus', 'hook'), mkNode('api1', 'api'), mkNode('c1', 'component')],
      [mkLink('focus', 'api1', 'dependency'), mkLink('focus', 'c1', 'dependency')],
    )
    const p = computeProjection(s, q({ altitude: 'implementation' }))
    expect(p.nodes.map((n) => n.id)).toEqual(['c1'])
  })

  it('never emits a relationship pointing outside the returned set', () => {
    const p = computeProjection(web(), q({ budget: 2 }))
    const visible = new Set([p.focus.id, ...p.nodes.map((n) => n.id)])
    for (const r of p.relationships) {
      expect(visible.has(r.source)).toBe(true)
      expect(visible.has(r.target)).toBe(true)
    }
  })

  it('handles a focus id that does not exist without throwing', () => {
    const p = computeProjection(web(), q({ focusId: 'ghost' }))
    expect(p.focus.id).toBe('ghost')
    expect(p.nodes).toEqual([])
  })
})

describe('computeProjection — hubs do not drown the result', () => {
  // The failure the design review predicted: a hub sits one hop from
  // everything via the strongest edge type, so under pure structural
  // decay it wins every lens.
  // Peers are `database` nodes so they share the hub's `system` altitude
  // and actually compete in the same projection — an earlier version of
  // this fixture put them at implementation, where they could never be
  // compared against the hub at all.
  const withHub = (): Schema => {
    const nodes = [
      mkNode('focus', 'hook', { entity: 'payment' }),
      mkNode('hub', 'util', { isHub: true }),
      ...Array.from({ length: 5 }, (_, i) => mkNode(`p${i}`, 'database', { entity: 'payment' })),
    ]
    const links = [
      mkLink('focus', 'hub', 'dependency'),
      ...Array.from({ length: 5 }, (_, i) => mkLink('focus', `p${i}`, 'dependency')),
    ]
    return mkSchema(nodes, links)
  }

  it('ranks a hub below ordinary same-distance peers under the overview lens', () => {
    const p = computeProjection(withHub(), q({ lens: 'overview', altitude: 'system' }))
    const hub = p.nodes.find((n) => n.id === 'hub')
    const peer = p.nodes.find((n) => n.id.startsWith('p'))
    // Both are one dependency hop from the focus, so structure alone
    // would tie them; hub dampening is the only thing separating them.
    expect(hub).toBeDefined()
    expect(peer).toBeDefined()
    expect(hub!.relevance).toBeLessThan(peer!.relevance)
  })

  it('does not dampen hubs under the impact lens, where they are the point', () => {
    const s = withHub()
    const overview = computeProjection(s, q({ lens: 'overview', altitude: 'system' }))
    const impact = computeProjection(s, q({ lens: 'impact', altitude: 'system' }))
    const hubIn = (p: typeof overview) => p.nodes.find((n) => n.id === 'hub')?.relevance ?? 0
    expect(hubIn(impact)).toBeGreaterThan(hubIn(overview))
  })

  it('flags a hub so the UI can render it distinctly', () => {
    const p = computeProjection(withHub(), q({ lens: 'impact', altitude: 'system' }))
    expect(p.nodes.find((n) => n.id === 'hub')?.whyRelevant).toContain('shared infrastructure')
  })
})

describe('computeProjection — diversity', () => {
  it('does not fill the budget from a single entity cluster', () => {
    // The odd-one-out is named to sort LAST. Every candidate here scores
    // identically on structure, and ties break on id — so a name like
    // "other" would be selected first regardless of diversity, making
    // this test pass without exercising anything.
    const nodes = [
      mkNode('focus', 'hook', { entity: 'payment' }),
      ...Array.from({ length: 6 }, (_, i) => mkNode(`pay${i}`, 'component', { entity: 'payment' })),
      mkNode('zbonus', 'component', { entity: 'bonus' }),
    ]
    const links = [
      ...Array.from({ length: 6 }, (_, i) => mkLink('focus', `pay${i}`, 'dependency')),
      mkLink('focus', 'zbonus', 'dependency'),
    ]
    const p = computeProjection(mkSchema(nodes, links), q({ budget: 3 }))
    expect(p.nodes.map((n) => n.id)).toContain('zbonus')
  })

  it('would rank the odd-one-out last on raw score alone', () => {
    // Guards the test above: confirms the fixture really does depend on
    // diversity pressure rather than on alphabetical luck.
    const nodes = [
      mkNode('focus', 'hook', { entity: 'payment' }),
      ...Array.from({ length: 6 }, (_, i) => mkNode(`pay${i}`, 'component', { entity: 'payment' })),
      mkNode('zbonus', 'component', { entity: 'bonus' }),
    ]
    const links = [
      ...Array.from({ length: 6 }, (_, i) => mkLink('focus', `pay${i}`, 'dependency')),
      mkLink('focus', 'zbonus', 'dependency'),
    ]
    const p = computeProjection(mkSchema(nodes, links), q({ budget: 8 }))
    const scores = new Set(p.nodes.map((n) => n.relevance))
    expect(scores.size).toBe(1)
  })
})

describe('computeProjection — lens filtering', () => {
  const mixed = (): Schema =>
    mkSchema(
      [mkNode('focus', 'hook'), mkNode('dep', 'component'), mkNode('flow', 'component')],
      [mkLink('focus', 'dep', 'dependency'), mkLink('focus', 'flow', 'data_flow')],
    )

  it('excludes link types the lens does not allow, rather than down-weighting them', () => {
    // The code lens allows only `dependency`; a data_flow neighbour must
    // be absent, not merely ranked lower — otherwise it still accumulates
    // relevance across multiple hops.
    const p = computeProjection(mixed(), q({ lens: 'code' }))
    expect(p.nodes.map((n) => n.id)).toContain('dep')
    expect(p.nodes.map((n) => n.id)).not.toContain('flow')
  })

  it('includes both link types under overview, which filters nothing', () => {
    const p = computeProjection(mixed(), q({ lens: 'overview' }))
    expect(p.nodes.map((n) => n.id).sort()).toEqual(['dep', 'flow'])
  })
})

describe('computeProjection — trail', () => {
  it('surfaces a trail entry that structure alone would not reach', () => {
    const s = mkSchema(
      [mkNode('focus', 'hook'), mkNode('near', 'component'), mkNode('far', 'component')],
      [mkLink('focus', 'near', 'dependency')],
    )
    const p = computeProjection(s, q({ trail: ['far'] }))
    expect(p.nodes.map((n) => n.id)).toContain('far')
  })

  it('labels why a trail entry surfaced', () => {
    const s = mkSchema(
      [mkNode('focus', 'hook'), mkNode('far', 'component')],
      [],
    )
    const p = computeProjection(s, q({ trail: ['far'] }))
    expect(p.nodes.find((n) => n.id === 'far')?.whyRelevant).toContain('on your trail')
  })
})

describe('computeProjection — journeys drive behavioural importance', () => {
  const journey: Journey = {
    id: 'j', name: 'J', description: '', color: '#fff',
    steps: [
      { id: 's1', name: 'A', annotation: '', kind: 'action', nodeId: 'inflow' },
    ],
    transitions: [],
  }

  it('ranks a journey member above an equally-connected non-member', () => {
    const s = mkSchema(
      [mkNode('focus', 'hook'), mkNode('inflow', 'component'), mkNode('outflow', 'component')],
      [mkLink('focus', 'inflow', 'data_flow'), mkLink('focus', 'outflow', 'data_flow')],
      { journeys: [journey] },
    )
    const p = computeProjection(s, q({ lens: 'journey' }))
    const rank = (id: string) => p.nodes.findIndex((n) => n.id === id)
    expect(rank('inflow')).toBeLessThan(rank('outflow'))
    expect(p.nodes.find((n) => n.id === 'inflow')?.whyRelevant).toContain('appears in a journey')
  })
})

describe('computeProjection — altitude degrades loudly', () => {
  it('substitutes the nearest populated tier and says so', () => {
    const s = mkSchema([mkNode('focus', 'hook'), mkNode('n0', 'component')],
      [mkLink('focus', 'n0', 'dependency')])
    const p = computeProjection(s, q({ altitude: 'code' }))
    expect(p.altitude).toBe('implementation')
    expect(p.meta.notices).toContainEqual({
      kind: 'altitude_substituted', requested: 'code', used: 'implementation',
    })
  })

  it('never silently returns a different altitude than it reports', () => {
    const s = mkSchema([mkNode('focus', 'hook'), mkNode('n0', 'component')],
      [mkLink('focus', 'n0', 'dependency')])
    const p = computeProjection(s, q({ altitude: 'code' }))
    for (const n of p.nodes) expect(n.altitude).toBe(p.altitude)
  })
})

describe('computeProjection — synthesised coarse tiers', () => {
  const s = (): Schema =>
    mkSchema(
      [mkNode('focus', 'api', { domain: 'payment' }), mkNode('b', 'api', { domain: 'bonus' })],
      [],
      { meta: { name: 'Casino', version: SCHEMA_VERSION, domains: ['payment', 'bonus'] } },
    )

  it('synthesises one entity per catalogued domain', () => {
    const p = computeProjection(s(), q({ altitude: 'domain' }))
    expect(p.nodes.map((n) => n.name).sort()).toEqual(['bonus', 'payment'])
    expect(p.nodes.every((n) => n.synthetic)).toBe(true)
  })

  it('ranks the focus’s own domain first — the subject key held fixed across zoom', () => {
    const p = computeProjection(s(), q({ altitude: 'domain' }))
    expect(p.nodes[0].name).toBe('payment')
    expect(p.nodes[0].whyRelevant).toContain('contains your current focus')
  })

  it('synthesises a single product entity', () => {
    const p = computeProjection(s(), q({ altitude: 'product' }))
    expect(p.nodes.map((n) => n.name)).toEqual(['Casino'])
  })
})

describe('computeProjection — honesty about missing evidence', () => {
  it('flags evidence-dependent lenses when no evidence has been extracted', () => {
    const p = computeProjection(web(), q({ lens: 'why' }))
    expect(p.meta.notices.some((n) => n.kind === 'lens_unsupported_by_data')).toBe(true)
  })

  it('does not flag the why lens once evidence exists', () => {
    const s = web()
    s.nodes[1].evidence = [{ source: 'documentation', confidence: 0.9 }]
    const p = computeProjection(s, q({ lens: 'why' }))
    expect(p.meta.notices.some((n) => n.kind === 'lens_unsupported_by_data')).toBe(false)
  })

  it('does not flag structural lenses, which need no evidence', () => {
    const p = computeProjection(web(), q({ lens: 'code' }))
    expect(p.meta.notices.some((n) => n.kind === 'lens_unsupported_by_data')).toBe(false)
  })

  it('reports resolution independently of relevance', () => {
    const s = mkSchema(
      [mkNode('focus', 'hook'), mkNode('bare', 'component', { description: '' })],
      [mkLink('focus', 'bare', 'dependency')],
    )
    const p = computeProjection(s, q())
    expect(p.nodes.find((n) => n.id === 'bare')?.resolution).toBe('unresolved')
  })
})

describe('computeProjection — recency stays pure', () => {
  const s = (): Schema =>
    mkSchema(
      [
        mkNode('focus', 'hook'),
        mkNode('old', 'component', { metadata: { lastModified: '2020-01-01T00:00:00Z' } }),
        mkNode('new', 'component', { metadata: { lastModified: '2026-08-01T00:00:00Z' } }),
      ],
      [mkLink('focus', 'old', 'dependency'), mkLink('focus', 'new', 'dependency')],
    )

  it('ignores recency entirely when no clock is supplied', () => {
    const withoutNow = computeProjection(s(), q({ lens: 'history' }))
    const oldScore = withoutNow.nodes.find((n) => n.id === 'old')?.relevance
    const newScore = withoutNow.nodes.find((n) => n.id === 'new')?.relevance
    expect(oldScore).toBe(newScore)
  })

  it('ranks recent changes higher under the history lens when given a clock', () => {
    const p = computeProjection(s(), q({ lens: 'history', now: '2026-08-14T00:00:00Z' }))
    const rank = (id: string) => p.nodes.findIndex((n) => n.id === id)
    expect(rank('new')).toBeLessThan(rank('old'))
    expect(p.nodes.find((n) => n.id === 'new')?.whyRelevant).toContain('changed recently')
  })
})

describe('computeProjection — thin neighbourhoods widen', () => {
  it('widens the search rather than returning a near-empty result', () => {
    // A chain: focus -> a -> b -> c. At depth 1 only `a` is reachable,
    // well under budget.
    const s = mkSchema(
      [mkNode('focus', 'hook'), mkNode('a', 'component'), mkNode('b', 'component'), mkNode('c', 'component')],
      [mkLink('focus', 'a', 'dependency'), mkLink('a', 'b', 'dependency'), mkLink('b', 'c', 'dependency')],
    )
    const p = computeProjection(s, q({ depth: 1, budget: 8 }))
    expect(p.meta.notices.some((n) => n.kind === 'widened')).toBe(true)
    expect(p.nodes.length).toBeGreaterThan(1)
  })
})

describe('computeProjection — empty results explain themselves', () => {
  it('reports an isolated focus rather than returning a bare empty set', () => {
    // Real specs produce these constantly: casino-frontend's OpenAPI
    // yielded 25 links across 66 nodes, leaving 26 nodes with no edges.
    const s = mkSchema([mkNode('focus', 'hook'), mkNode('elsewhere', 'component')], [])
    const p = computeProjection(s, q())
    expect(p.nodes).toEqual([])
    expect(p.meta.notices).toContainEqual({ kind: 'focus_isolated', focusId: 'focus' })
  })

  it('distinguishes "connected but nothing at this altitude" from isolation', () => {
    const s = mkSchema(
      [mkNode('focus', 'hook'), mkNode('db', 'database')],
      [mkLink('focus', 'db', 'dependency')],
    )
    // The focus has an edge, but no other implementation-altitude node.
    const p = computeProjection(s, q({ altitude: 'implementation' }))
    expect(p.nodes).toEqual([])
    expect(p.meta.notices.some((n) => n.kind === 'no_candidates_at_altitude')).toBe(true)
    expect(p.meta.notices.some((n) => n.kind === 'focus_isolated')).toBe(false)
  })

  it('adds no such notice when results were found', () => {
    const p = computeProjection(web(), q())
    expect(p.meta.notices.some((n) => n.kind === 'focus_isolated')).toBe(false)
    expect(p.meta.notices.some((n) => n.kind === 'no_candidates_at_altitude')).toBe(false)
  })
})

describe('computeProjection — lens support is judged per required source', () => {
  const evidenced = (source: 'git' | 'runtime' | 'test') => {
    const s = web()
    s.nodes[1].evidence = [{ source, confidence: 1 }]
    return s
  }

  it('still flags runtime when only git evidence exists', () => {
    // The earlier check asked "is there ANY evidence", so it stopped
    // firing the moment any extractor produced anything — and the
    // runtime lens silently returned nothing instead of saying why.
    const p = computeProjection(evidenced('git'), q({ lens: 'runtime' }))
    expect(p.meta.notices.some((n) => n.kind === 'lens_unsupported_by_data')).toBe(true)
  })

  it('stops flagging runtime once runtime evidence exists', () => {
    const p = computeProjection(evidenced('runtime'), q({ lens: 'runtime' }))
    expect(p.meta.notices.some((n) => n.kind === 'lens_unsupported_by_data')).toBe(false)
  })

  it('accepts git evidence for the history lens', () => {
    const p = computeProjection(evidenced('git'), q({ lens: 'history' }))
    expect(p.meta.notices.some((n) => n.kind === 'lens_unsupported_by_data')).toBe(false)
  })

  it('does not accept git evidence for the tests lens', () => {
    const p = computeProjection(evidenced('git'), q({ lens: 'tests' }))
    expect(p.meta.notices.some((n) => n.kind === 'lens_unsupported_by_data')).toBe(true)
  })
})
