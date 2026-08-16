import { describe, expect, it } from 'vitest'
import type { Node, Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'
import {
  backfillEntities,
  entityCounts,
  extractEntity,
  mergeEntity,
  renameEntity,
  singularize,
} from '@/schema/entity/extractor'

// ─── singularize ─────────────────────────────────────────────

describe('singularize', () => {
  it('strips trailing "s"', () => {
    expect(singularize('payments')).toBe('payment')
    expect(singularize('users')).toBe('user')
  })
  it('handles "ies" → "y"', () => {
    expect(singularize('categories')).toBe('category')
    expect(singularize('companies')).toBe('company')
  })
  it('handles "ses" → "s"', () => {
    expect(singularize('addresses')).toBe('address')
    expect(singularize('bonuses')).toBe('bonus')
  })
  it('keeps uninflected words unchanged', () => {
    expect(singularize('analytics')).toBe('analytics')
    expect(singularize('news')).toBe('news')
    expect(singularize('status')).toBe('status')
    expect(singularize('series')).toBe('series')
  })
  it('handles known irregulars', () => {
    expect(singularize('people')).toBe('person')
    expect(singularize('children')).toBe('child')
  })
  it('returns empty on empty input', () => {
    expect(singularize('')).toBe('')
  })
  it('is idempotent for already-singular values', () => {
    expect(singularize('payment')).toBe('payment')
    expect(singularize('user')).toBe('user')
  })
})

// ─── extractEntity (closed-vocabulary: manual override only) ─

const emptyContext: { schema: Schema } = {
  schema: {
    meta: { name: 't', version: SCHEMA_VERSION },
    nodeTypes: {}, linkTypes: {}, nodes: [], links: [], paths: [], annotations: [],
  },
}

const mkNode = (o: Partial<Node>): Node => ({
  id: o.id ?? 'n1',
  name: o.name ?? 'N1',
  type: o.type ?? 'service',
  description: o.description ?? '',
  origin: o.origin ?? 'manual',
  ...o,
})

describe('extractEntity — closed vocabulary (GE-115)', () => {
  it('returns the node entity only when a manual override is set', () => {
    const n = mkNode({
      origin: 'auto:openapi',
      type: 'database',
      name: 'AdminPayments',
      entity: 'finance',
      manualOverrides: ['entity'],
    })
    expect(extractEntity(n, emptyContext)).toBe('finance')
  })

  it('returns undefined when no manual override is present', () => {
    const n = mkNode({ origin: 'auto:openapi', type: 'api', group: 'Customer', name: 'GET /admin/players' })
    expect(extractEntity(n, emptyContext)).toBeUndefined()
  })

  it('returns undefined for codebase nodes (entity flows from propagation now)', () => {
    const n = mkNode({ origin: 'auto:codebase', type: 'ui', description: 'modules/payments/hooks/use-all-payments.ts' })
    expect(extractEntity(n, emptyContext)).toBeUndefined()
  })
})

// ─── backfillEntities (no-op in closed-vocabulary model) ────

describe('backfillEntities', () => {
  const mkSchema = (nodes: Node[]): Schema => ({
    meta: { name: 't', version: SCHEMA_VERSION },
    nodeTypes: {}, linkTypes: {}, nodes, links: [], paths: [], annotations: [],
  })

  it('leaves nodes with existing entity untouched', () => {
    const s = mkSchema([
      mkNode({ id: 'n1', origin: 'auto:openapi', type: 'database', name: 'Customer', entity: 'customer' }),
    ])
    const next = backfillEntities(s)
    expect(next.nodes[0].entity).toBe('customer')
  })

  it('is a no-op: entities flow from the catalog (GE-115) + propagation (GE-115b)', () => {
    const s = mkSchema([
      mkNode({ id: 'n1', origin: 'auto:openapi', type: 'database', name: 'Customer' }),
    ])
    const next = backfillEntities(s)
    expect(next.nodes[0].entity).toBeUndefined()
  })

  it('does not mutate the input schema', () => {
    const s = mkSchema([mkNode({ id: 'n1', origin: 'auto:openapi', type: 'database', name: 'Customer' })])
    const snap = JSON.stringify(s)
    backfillEntities(s)
    expect(JSON.stringify(s)).toBe(snap)
  })
})

// ─── entityCounts ────────────────────────────────────────────

describe('entityCounts', () => {
  it('tallies + sorts by count descending', () => {
    const s: Schema = {
      meta: { name: 't', version: SCHEMA_VERSION },
      nodeTypes: {}, linkTypes: {},
      nodes: [
        mkNode({ id: '1', entity: 'customer' }),
        mkNode({ id: '2', entity: 'payment' }),
        mkNode({ id: '3', entity: 'customer' }),
        mkNode({ id: '4', entity: 'customer' }),
        mkNode({ id: '5' }), // no entity
      ],
      links: [], paths: [], annotations: [],
    }
    expect(entityCounts(s)).toEqual([
      { entity: 'customer', count: 3 },
      { entity: 'payment', count: 1 },
    ])
  })
})

// ─── merge / rename ──────────────────────────────────────────

describe('mergeEntity / renameEntity', () => {
  const base = (): Schema => ({
    meta: { name: 't', version: SCHEMA_VERSION, entities: ['customer', 'player', 'payment'] },
    nodeTypes: {}, linkTypes: {},
    nodes: [
      mkNode({ id: '1', entity: 'customer' }),
      mkNode({ id: '2', entity: 'player' }),
      mkNode({ id: '3', entity: 'player' }),
      mkNode({ id: '4', entity: 'payment' }),
    ],
    links: [], paths: [], annotations: [],
  })

  it('reassigns every node from X to Y', () => {
    const next = mergeEntity(base(), 'player', 'customer')
    const customers = next.nodes.filter((n) => n.entity === 'customer')
    const players = next.nodes.filter((n) => n.entity === 'player')
    expect(customers).toHaveLength(3)
    expect(players).toHaveLength(0)
  })

  it('removes the merged-away entity from the canonical dictionary', () => {
    const next = mergeEntity(base(), 'player', 'customer')
    expect(next.meta.entities).not.toContain('player')
    expect(next.meta.entities).toContain('customer')
  })

  it('renameEntity works identically', () => {
    const next = renameEntity(base(), 'payment', 'finance')
    expect(next.nodes.find((n) => n.id === '4')?.entity).toBe('finance')
    expect(next.meta.entities).toContain('finance')
  })
})
