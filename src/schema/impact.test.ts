import { describe, expect, it } from 'vitest'
import type { Link, Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import { computeBlastRadius } from '@/schema/impact'

const mkNode = (id: string): Node => ({
  id, name: id.toUpperCase(), type: 'service', description: '', origin: 'manual',
})
const mkLink = (source: string, target: string, type: Link['type']): Link => ({
  id: `${source}__${type ?? 'none'}__${target}`,
  source, target, label: '', description: '', type, origin: 'manual',
})

const emptySchema = (): Schema => ({
  meta: { name: 't', version: SCHEMA_VERSION },
  nodeTypes: { service: { color: '#000', label: 'Service' } },
  linkTypes: {
    data_flow: { color: '#111', label: 'Data' },
    dependency: { color: '#222', label: 'Dep' },
    triggers: { color: '#333', label: 'Trig' },
  },
  nodes: [], links: [], paths: [], annotations: [],
})

describe('computeBlastRadius — basic', () => {
  it('returns only the start node when it is isolated', () => {
    const s = emptySchema()
    s.nodes = [mkNode('a')]
    const r = computeBlastRadius(s, 'a', 'downstream')
    expect(r).toEqual([{ nodeId: 'a', severity: 1, distance: 0 }])
  })

  it('returns [] when the start node does not exist', () => {
    const s = emptySchema()
    s.nodes = [mkNode('a')]
    expect(computeBlastRadius(s, 'ghost', 'downstream')).toEqual([])
  })

  it('follows a single downstream dependency hop with the expected decay', () => {
    const s = emptySchema()
    s.nodes = [mkNode('a'), mkNode('b')]
    s.links = [mkLink('a', 'b', 'dependency')]
    const r = computeBlastRadius(s, 'a', 'downstream')
    expect(r.map((i) => i.nodeId)).toEqual(['a', 'b'])
    expect(r[1].severity).toBeCloseTo(0.85, 4)
    expect(r[1].distance).toBe(1)
  })
})

describe('computeBlastRadius — direction', () => {
  it('upstream reverses the traversal direction', () => {
    const s = emptySchema()
    s.nodes = [mkNode('a'), mkNode('b'), mkNode('c')]
    s.links = [mkLink('a', 'b', 'dependency'), mkLink('b', 'c', 'dependency')]

    const downFromA = computeBlastRadius(s, 'a', 'downstream').map((i) => i.nodeId).sort()
    expect(downFromA).toEqual(['a', 'b', 'c'])

    const upFromC = computeBlastRadius(s, 'c', 'upstream').map((i) => i.nodeId).sort()
    expect(upFromC).toEqual(['a', 'b', 'c'])

    // Downstream from C reaches no one.
    const downFromC = computeBlastRadius(s, 'c', 'downstream')
    expect(downFromC).toEqual([{ nodeId: 'c', severity: 1, distance: 0 }])
  })
})

describe('computeBlastRadius — link type weighting', () => {
  it('prefers a longer all-dependency path over a short data_flow path', () => {
    // a → b via data_flow (0.65), a → c → b via two dependencies (0.85*0.85 = 0.7225)
    const s = emptySchema()
    s.nodes = [mkNode('a'), mkNode('b'), mkNode('c')]
    s.links = [
      mkLink('a', 'b', 'data_flow'),
      mkLink('a', 'c', 'dependency'),
      mkLink('c', 'b', 'dependency'),
    ]
    const r = computeBlastRadius(s, 'a', 'downstream')
    const b = r.find((i) => i.nodeId === 'b')!
    expect(b.severity).toBeCloseTo(0.7225, 3) // via the dep chain, not data_flow
  })

  it('triggers propagate less severely than dependencies', () => {
    const s = emptySchema()
    s.nodes = [mkNode('a'), mkNode('b')]
    s.links = [mkLink('a', 'b', 'triggers')]
    const r = computeBlastRadius(s, 'a', 'downstream')
    expect(r[1].severity).toBeCloseTo(0.5, 4)
  })
})

describe('computeBlastRadius — robustness', () => {
  it('does not infinite-loop on a cycle', () => {
    const s = emptySchema()
    s.nodes = [mkNode('a'), mkNode('b')]
    s.links = [mkLink('a', 'b', 'dependency'), mkLink('b', 'a', 'dependency')]
    const r = computeBlastRadius(s, 'a', 'downstream')
    expect(r.map((i) => i.nodeId).sort()).toEqual(['a', 'b'])
    // Start node's own severity is never overwritten
    expect(r.find((i) => i.nodeId === 'a')!.severity).toBe(1)
  })

  it('cuts off at the minimum-severity threshold', () => {
    // Chain of 20 triggers — decay 0.5 per hop, so severity falls below 0.05
    // somewhere around hop 5 (0.5^5 = 0.03125).
    const s = emptySchema()
    for (let i = 0; i < 20; i++) s.nodes.push(mkNode(`n${i}`))
    for (let i = 0; i < 19; i++) s.links.push(mkLink(`n${i}`, `n${i + 1}`, 'triggers'))

    const r = computeBlastRadius(s, 'n0', 'downstream')
    // All returned impacts must be >= MIN_SEVERITY (0.05).
    for (const impact of r) expect(impact.severity).toBeGreaterThanOrEqual(0.05)
    // And not all 20 nodes should be reached.
    expect(r.length).toBeLessThan(20)
  })

  it('returns impacts sorted by severity desc then distance asc', () => {
    const s = emptySchema()
    s.nodes = [mkNode('a'), mkNode('b'), mkNode('c'), mkNode('d')]
    s.links = [
      mkLink('a', 'b', 'dependency'),
      mkLink('a', 'c', 'data_flow'),
      mkLink('a', 'd', 'triggers'),
    ]
    const r = computeBlastRadius(s, 'a', 'downstream')
    const severities = r.map((i) => i.severity)
    const sorted = [...severities].sort((x, y) => y - x)
    expect(severities).toEqual(sorted)
  })
})

describe('computeBlastRadius — link type fallback', () => {
  // Regression: `(type && DECAY_BY_TYPE[type]) ?? DEFAULT_DECAY` returned
  // '' for an empty-string type, because ?? does not catch ''. That
  // multiplied to severity 0, fell under MIN_SEVERITY, and silently
  // dropped the edge — the node vanished from the blast radius entirely.
  it('treats an empty-string link type as the default decay, not a dropped edge', () => {
    const s = emptySchema()
    s.nodes = [mkNode('a'), mkNode('b')]
    s.links = [{ ...mkLink('a', 'b', undefined), type: '' }]
    const r = computeBlastRadius(s, 'a', 'downstream')
    expect(r.map((i) => i.nodeId)).toContain('b')
    expect(r.find((i) => i.nodeId === 'b')?.severity).toBeCloseTo(0.6)
  })

  it('treats an unregistered link type as the default decay', () => {
    const s = emptySchema()
    s.nodes = [mkNode('a'), mkNode('b')]
    s.links = [mkLink('a', 'b', 'brand_new_type')]
    const r = computeBlastRadius(s, 'a', 'downstream')
    expect(r.find((i) => i.nodeId === 'b')?.severity).toBeCloseTo(0.6)
  })

  it('treats an undefined link type as the default decay', () => {
    const s = emptySchema()
    s.nodes = [mkNode('a'), mkNode('b')]
    s.links = [mkLink('a', 'b', undefined)]
    const r = computeBlastRadius(s, 'a', 'downstream')
    expect(r.find((i) => i.nodeId === 'b')?.severity).toBeCloseTo(0.6)
  })
})
