import { describe, expect, it } from 'vitest'
import { propagateEntities } from '@/schema/entity/propagate'
import type { Link, Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'

const mkNode = (o: Partial<Node> & { id: string }): Node => ({
  name: o.name ?? o.id,
  type: o.type ?? 'ui',
  description: o.description ?? '',
  origin: o.origin ?? 'auto:codebase',
  ...o,
})

const mkLink = (o: Partial<Link> & { id: string; source: string; target: string }): Link => ({
  label: o.label ?? '',
  description: o.description ?? '',
  origin: o.origin ?? 'auto:codebase',
  ...o,
})

const mkSchema = (nodes: Node[], links: Link[]): Schema => ({
  meta: { name: 't', version: SCHEMA_VERSION },
  nodeTypes: {}, linkTypes: {}, nodes, links, paths: [], annotations: [],
})

describe('propagateEntities', () => {
  it('flows API op entity to the FE client that calls it', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'op:get-payments', type: 'api', origin: 'auto:openapi', entity: 'payment', domain: 'payment' }),
        mkNode({ id: 'fe:client', type: 'ui' }),
      ],
      [
        mkLink({ id: 'l1', source: 'fe:client', target: 'op:get-payments', type: 'data_flow', label: 'calls' }),
      ],
    )
    const out = propagateEntities(s)
    const fe = out.nodes.find((n) => n.id === 'fe:client')!
    expect(fe.entity).toBe('payment')
    expect(fe.domain).toBe('payment')
  })

  it('flows API op entity to BE handler via "implemented by" edge', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'op:post-payments', type: 'api', origin: 'auto:openapi', entity: 'payment', domain: 'payment' }),
        mkNode({ id: 'be:handler', type: 'api' }),
      ],
      [
        mkLink({ id: 'l1', source: 'op:post-payments', target: 'be:handler', type: 'data_flow', label: 'implemented by' }),
      ],
    )
    const out = propagateEntities(s)
    expect(out.nodes.find((n) => n.id === 'be:handler')?.entity).toBe('payment')
  })

  it('propagates transitively up the dependency chain (reverse direction)', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'op:get-payments', type: 'api', origin: 'auto:openapi', entity: 'payment' }),
        mkNode({ id: 'fe:client' }),
        mkNode({ id: 'fe:hook' }),
        mkNode({ id: 'fe:component' }),
      ],
      [
        mkLink({ id: 'c1', source: 'fe:client', target: 'op:get-payments', type: 'data_flow', label: 'calls' }),
        mkLink({ id: 'd1', source: 'fe:hook', target: 'fe:client', type: 'dependency' }),
        mkLink({ id: 'd2', source: 'fe:component', target: 'fe:hook', type: 'dependency' }),
      ],
    )
    const out = propagateEntities(s)
    expect(out.nodes.find((n) => n.id === 'fe:hook')?.entity).toBe('payment')
    expect(out.nodes.find((n) => n.id === 'fe:component')?.entity).toBe('payment')
  })

  it('leaves a utility hub Unclassified when imported by multiple entities', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'fe:payments-file', entity: 'payment' }),
        mkNode({ id: 'fe:customers-file', entity: 'customer' }),
        mkNode({ id: 'fe:bonus-file', entity: 'bonus' }),
        mkNode({ id: 'fe:utils' }),
      ],
      [
        mkLink({ id: 'd1', source: 'fe:payments-file', target: 'fe:utils', type: 'dependency' }),
        mkLink({ id: 'd2', source: 'fe:customers-file', target: 'fe:utils', type: 'dependency' }),
        mkLink({ id: 'd3', source: 'fe:bonus-file', target: 'fe:utils', type: 'dependency' }),
      ],
    )
    const out = propagateEntities(s)
    const utils = out.nodes.find((n) => n.id === 'fe:utils')!
    // Utils is not reached by propagation (dep is import-direction).
    expect(utils.entity).toBeUndefined()
    // But it IS a hub (≥ 3 distinct entities import it).
    expect(utils.isHub).toBe(true)
  })

  it('marks a node as hub when ≥ 3 distinct entities import it', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'a', entity: 'e1' }),
        mkNode({ id: 'b', entity: 'e2' }),
        mkNode({ id: 'c', entity: 'e3' }),
        mkNode({ id: 'util' }),
      ],
      [
        mkLink({ id: 'l1', source: 'a', target: 'util', type: 'dependency' }),
        mkLink({ id: 'l2', source: 'b', target: 'util', type: 'dependency' }),
        mkLink({ id: 'l3', source: 'c', target: 'util', type: 'dependency' }),
      ],
    )
    const out = propagateEntities(s)
    expect(out.nodes.find((n) => n.id === 'util')?.isHub).toBe(true)
  })

  it('does not mark a hub when imported by nodes all with the same entity', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'a', entity: 'payment' }),
        mkNode({ id: 'b', entity: 'payment' }),
        mkNode({ id: 'c', entity: 'payment' }),
        mkNode({ id: 'util' }),
      ],
      [
        mkLink({ id: 'l1', source: 'a', target: 'util', type: 'dependency' }),
        mkLink({ id: 'l2', source: 'b', target: 'util', type: 'dependency' }),
        mkLink({ id: 'l3', source: 'c', target: 'util', type: 'dependency' }),
      ],
    )
    const out = propagateEntities(s)
    const util = out.nodes.find((n) => n.id === 'util')!
    // Propagation flows target → source (importer inherits from imported).
    // util has no outgoing imports, so it doesn't inherit anything.
    expect(util.entity).toBeUndefined()
    // Only 1 distinct entity imports util → below hub threshold.
    expect(util.isHub).toBeUndefined()
  })

  it('respects manualOverrides: ["entity"]', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'op', type: 'api', origin: 'auto:openapi', entity: 'payment' }),
        mkNode({ id: 'fe', entity: 'handmade', manualOverrides: ['entity'] }),
      ],
      [
        mkLink({ id: 'l1', source: 'fe', target: 'op', type: 'data_flow', label: 'calls' }),
      ],
    )
    const out = propagateEntities(s)
    expect(out.nodes.find((n) => n.id === 'fe')?.entity).toBe('handmade')
  })

  it('is idempotent — running twice produces the same result', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'op', type: 'api', origin: 'auto:openapi', entity: 'payment' }),
        mkNode({ id: 'fe' }),
      ],
      [mkLink({ id: 'l1', source: 'fe', target: 'op', type: 'data_flow', label: 'calls' })],
    )
    const once = propagateEntities(s)
    const twice = propagateEntities(once)
    expect(twice.nodes.map((n) => ({ id: n.id, entity: n.entity, domain: n.domain, isHub: n.isHub })))
      .toEqual(once.nodes.map((n) => ({ id: n.id, entity: n.entity, domain: n.domain, isHub: n.isHub })))
  })

  it('does not infinite-loop on cycles', () => {
    const s = mkSchema(
      [
        mkNode({ id: 'a', entity: 'x' }),
        mkNode({ id: 'b' }),
      ],
      [
        mkLink({ id: 'l1', source: 'a', target: 'b', type: 'dependency' }),
        mkLink({ id: 'l2', source: 'b', target: 'a', type: 'dependency' }),
      ],
    )
    const out = propagateEntities(s)
    expect(out.nodes.find((n) => n.id === 'b')?.entity).toBe('x')
  })

  it('sets meta.lastPropagationAt', () => {
    const s = mkSchema([mkNode({ id: 'n1' })], [])
    const out = propagateEntities(s)
    expect(out.meta.lastPropagationAt).toBeDefined()
    expect(typeof out.meta.lastPropagationAt).toBe('string')
  })
})
