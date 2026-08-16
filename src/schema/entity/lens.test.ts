import { describe, expect, it } from 'vitest'
import { entityLensSubgraph, globalEntitySubgraph, peerEntityChips } from '@/schema/entity/lens'
import type { Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'

const mkNode = (o: Partial<Node> & { id: string }): Node => ({
  name: o.name ?? o.id,
  type: o.type ?? 'ui',
  description: '',
  origin: 'auto:codebase',
  ...o,
})

const mkSchema = (nodes: Node[], links: Array<{ id: string; source: string; target: string; type?: string }>): Schema => ({
  meta: { name: 't', version: SCHEMA_VERSION },
  nodeTypes: {}, linkTypes: {},
  nodes,
  links: links.map((l) => ({ ...l, label: '', description: '', origin: 'auto:codebase' as const })),
  paths: [], annotations: [],
})

describe('peerEntityChips', () => {
  it('returns entity counts of direct peers including the anchor entity', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'hub', entity: 'hub-entity' }),
        mkNode({ id: 'a', entity: 'payment' }),
        mkNode({ id: 'b', entity: 'payment' }),
        mkNode({ id: 'c', entity: 'bonus' }),
        mkNode({ id: 'd' }), // no entity
      ],
      [
        { id: 'l1', source: 'hub', target: 'a' },
        { id: 'l2', source: 'hub', target: 'b' },
        { id: 'l3', source: 'hub', target: 'c' },
        { id: 'l4', source: 'hub', target: 'd' },
      ],
    )
    const chips = peerEntityChips(s, 'hub')
    expect(chips).toEqual([
      { entity: 'payment', count: 2 },
      { entity: 'bonus', count: 1 },
      { entity: 'hub-entity', count: 0 }, // anchor's own entity included
    ])
  })

  it('includes anchor entity when all peers share it', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'bonus-db', entity: 'bonus' }),
        mkNode({ id: 'op1', entity: 'bonus' }),
        mkNode({ id: 'op2', entity: 'bonus' }),
      ],
      [
        { id: 'l1', source: 'bonus-db', target: 'op1' },
        { id: 'l2', source: 'bonus-db', target: 'op2' },
      ],
    )
    const chips = peerEntityChips(s, 'bonus-db')
    expect(chips).toEqual([{ entity: 'bonus', count: 2 }])
  })

  it('returns empty when no peers have entities and anchor has none', () => {
    const s = mkSchema(
      [mkNode({ id: 'a' }), mkNode({ id: 'b' })],
      [{ id: 'l1', source: 'a', target: 'b' }],
    )
    expect(peerEntityChips(s, 'a')).toEqual([])
  })
})

describe('entityLensSubgraph', () => {
  it('returns the anchor + all transitively reachable nodes with the lens entity', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'anchor' }),
        mkNode({ id: 'a', entity: 'payment' }),
        mkNode({ id: 'b', entity: 'payment' }),
        mkNode({ id: 'c', entity: 'bonus' }),
        mkNode({ id: 'd', entity: 'payment' }),
      ],
      [
        { id: 'l1', source: 'anchor', target: 'a' },
        { id: 'l2', source: 'a', target: 'b' },
        { id: 'l3', source: 'anchor', target: 'c' },
        { id: 'l4', source: 'b', target: 'd' },
      ],
    )
    const result = entityLensSubgraph(s, 'anchor', 'payment')
    expect(result).toEqual(new Set(['anchor', 'a', 'b', 'd']))
    // 'c' has entity 'bonus' — excluded from payment lens.
    expect(result.has('c')).toBe(false)
  })

  it('always includes the anchor even if it has a different entity', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'anchor', entity: 'hub' }),
        mkNode({ id: 'a', entity: 'payment' }),
      ],
      [{ id: 'l1', source: 'anchor', target: 'a' }],
    )
    const result = entityLensSubgraph(s, 'anchor', 'payment')
    expect(result.has('anchor')).toBe(true)
    expect(result.has('a')).toBe(true)
  })

  it('stops at nodes with a different entity', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'anchor' }),
        mkNode({ id: 'a', entity: 'payment' }),
        mkNode({ id: 'wall', entity: 'bonus' }),
        mkNode({ id: 'b', entity: 'payment' }),
      ],
      [
        { id: 'l1', source: 'anchor', target: 'a' },
        { id: 'l2', source: 'a', target: 'wall' },
        { id: 'l3', source: 'wall', target: 'b' },
      ],
    )
    const result = entityLensSubgraph(s, 'anchor', 'payment')
    // 'b' is payment but only reachable through 'wall' (bonus) → not in result.
    expect(result).toEqual(new Set(['anchor', 'a']))
  })
})

describe('globalEntitySubgraph', () => {
  it('includes all nodes with the target entity + their immediate neighbors', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'a', entity: 'bonus' }),
        mkNode({ id: 'b', entity: 'bonus' }),
        mkNode({ id: 'c', entity: 'payment' }),
        mkNode({ id: 'd' }), // no entity, neighbor of 'a'
        mkNode({ id: 'e' }), // no entity, not adjacent to any bonus node
      ],
      [
        { id: 'l1', source: 'a', target: 'b' },
        { id: 'l2', source: 'a', target: 'c' },
        { id: 'l3', source: 'a', target: 'd' },
        { id: 'l4', source: 'c', target: 'e' },
      ],
    )
    const result = globalEntitySubgraph(s, 'bonus')
    // a, b = bonus-tagged. c, d = neighbors of bonus nodes. e = not adjacent.
    expect(result).toEqual(new Set(['a', 'b', 'c', 'd']))
    expect(result.has('e')).toBe(false)
  })

  it('returns empty set when no nodes carry the entity', () => {
    const s = mkSchema(
      [mkNode({ id: 'a', entity: 'payment' })],
      [],
    )
    expect(globalEntitySubgraph(s, 'bonus').size).toBe(0)
  })
})
