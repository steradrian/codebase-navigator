import { describe, expect, it } from 'vitest'
import type { Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import {
  ALTITUDE_ORDER,
  altitudeForNode,
  assignAltitudes,
  nearestPopulatedAltitude,
  populatedAltitudes,
} from '@/schema/altitude'

const mkNode = (id: string, type: string, over: Partial<Node> = {}): Node => ({
  id,
  name: id,
  type,
  description: '',
  origin: 'auto:codebase',
  ...over,
})

const mkSchema = (nodes: Node[], over: Partial<Schema['meta']> = {}): Schema => ({
  meta: { name: 'T', version: SCHEMA_VERSION, ...over },
  nodeTypes: {},
  linkTypes: {},
  nodes,
  links: [],
  paths: [],
  journeys: [],
  annotations: [],
})

describe('altitudeForNode', () => {
  it('places API operations at behavior — things the product does', () => {
    expect(altitudeForNode(mkNode('a', 'api'))).toBe('behavior')
  })

  it('places stores and services at system', () => {
    expect(altitudeForNode(mkNode('a', 'database'))).toBe('system')
    expect(altitudeForNode(mkNode('a', 'service'))).toBe('system')
  })

  it('places every codebase file type at implementation', () => {
    for (const t of ['page', 'layout', 'client', 'hook', 'component', 'util', 'ui']) {
      expect(altitudeForNode(mkNode('a', t))).toBe('implementation')
    }
  })

  it('promotes a hub to system regardless of its type', () => {
    // isHub asserts >=3 entities route through the node, which is the
    // definition of cross-cutting infrastructure.
    expect(altitudeForNode(mkNode('a', 'util', { isHub: true }))).toBe('system')
    expect(altitudeForNode(mkNode('a', 'component', { isHub: true }))).toBe('system')
  })

  it('falls back to implementation for an unknown, user-authored type', () => {
    expect(altitudeForNode(mkNode('a', 'composable'))).toBe('implementation')
  })
})

describe('assignAltitudes', () => {
  it('stamps altitude onto every node', () => {
    const s = assignAltitudes(mkSchema([mkNode('a', 'api'), mkNode('b', 'hook')]))
    expect(s.nodes.map((n) => n.altitude)).toEqual(['behavior', 'implementation'])
  })

  it('is idempotent', () => {
    const once = assignAltitudes(mkSchema([mkNode('a', 'api'), mkNode('b', 'util')]))
    const twice = assignAltitudes(once)
    expect(twice.nodes).toEqual(once.nodes)
    expect(twice.meta.altitudeCoverage).toEqual(once.meta.altitudeCoverage)
  })

  it('preserves a hand-corrected altitude listed in manualOverrides', () => {
    const pinned = mkNode('a', 'util', { altitude: 'behavior', manualOverrides: ['altitude'] })
    const s = assignAltitudes(mkSchema([pinned]))
    expect(s.nodes[0].altitude).toBe('behavior')
  })

  it('recomputes an altitude that is not pinned', () => {
    const stale = mkNode('a', 'api', { altitude: 'code' })
    expect(assignAltitudes(mkSchema([stale])).nodes[0].altitude).toBe('behavior')
  })

  it('records unmapped node types instead of silently mis-tiering them', () => {
    const s = assignAltitudes(mkSchema([mkNode('a', 'composable'), mkNode('b', 'worker')]))
    expect(s.meta.altitudeUnmappedTypes).toEqual(['composable', 'worker'])
  })

  it('leaves unmappedTypes undefined when every type is recognised', () => {
    const s = assignAltitudes(mkSchema([mkNode('a', 'api')]))
    expect(s.meta.altitudeUnmappedTypes).toBeUndefined()
  })

  it('does not count a hub as unmapped — its type was never consulted', () => {
    const s = assignAltitudes(mkSchema([mkNode('a', 'composable', { isHub: true })]))
    expect(s.meta.altitudeUnmappedTypes).toBeUndefined()
  })

  it('counts coverage per tier', () => {
    const s = assignAltitudes(
      mkSchema([mkNode('a', 'api'), mkNode('b', 'api'), mkNode('c', 'hook')]),
    )
    expect(s.meta.altitudeCoverage?.behavior).toBe(2)
    expect(s.meta.altitudeCoverage?.implementation).toBe(1)
  })

  it('reports product coverage as synthesisable from the schema name', () => {
    const s = assignAltitudes(mkSchema([mkNode('a', 'api')]))
    expect(s.meta.altitudeCoverage?.product).toBe(1)
  })

  it('reports domain coverage from the catalogued domains', () => {
    const s = assignAltitudes(mkSchema([mkNode('a', 'api')], { domains: ['auth', 'payments'] }))
    expect(s.meta.altitudeCoverage?.domain).toBe(2)
  })

  it('unions catalogued domains with hand-authored domain nodes', () => {
    const s = assignAltitudes(
      mkSchema([mkNode('billing', 'domain'), mkNode('a', 'api')], { domains: ['auth'] }),
    )
    expect(s.meta.altitudeCoverage?.domain).toBe(2)
  })

  it('reports code coverage as zero — no importer emits symbol-level nodes yet', () => {
    const s = assignAltitudes(mkSchema([mkNode('a', 'api'), mkNode('b', 'hook')]))
    expect(s.meta.altitudeCoverage?.code).toBe(0)
  })
})

describe('populatedAltitudes', () => {
  it('returns only tiers with members, in coarse-to-fine order', () => {
    const s = assignAltitudes(mkSchema([mkNode('a', 'api'), mkNode('b', 'hook')]))
    expect(populatedAltitudes(s)).toEqual(['product', 'behavior', 'implementation'])
  })

  it('returns nothing when coverage has never been computed', () => {
    expect(populatedAltitudes(mkSchema([mkNode('a', 'api')]))).toEqual([])
  })
})

describe('nearestPopulatedAltitude', () => {
  const s = assignAltitudes(mkSchema([mkNode('a', 'api'), mkNode('b', 'hook')]))

  it('returns the requested tier when it is populated', () => {
    expect(nearestPopulatedAltitude(s, 'behavior')).toBe('behavior')
  })

  it('substitutes the nearest populated tier when the request is empty', () => {
    // 'code' is empty; 'implementation' is adjacent.
    expect(nearestPopulatedAltitude(s, 'code')).toBe('implementation')
  })

  it('breaks ties toward the finer tier', () => {
    // 'system' is empty and sits equidistant between behavior and
    // implementation; showing more detail is recoverable by zooming out.
    expect(nearestPopulatedAltitude(s, 'system')).toBe('implementation')
  })

  it('returns null when no tier is populated', () => {
    const bare = { ...mkSchema([]), meta: { name: '', version: SCHEMA_VERSION } }
    expect(nearestPopulatedAltitude(assignAltitudes(bare), 'code')).toBeNull()
  })
})

describe('ALTITUDE_ORDER', () => {
  it('runs coarse to fine with no duplicates', () => {
    expect(ALTITUDE_ORDER).toEqual([
      'product', 'domain', 'behavior', 'system', 'implementation', 'code',
    ])
    expect(new Set(ALTITUDE_ORDER).size).toBe(ALTITUDE_ORDER.length)
  })
})
