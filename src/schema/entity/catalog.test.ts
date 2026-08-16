import { describe, expect, it } from 'vitest'
import {
  addEntityToCatalog,
  assignEntityToNode,
  buildEntityCatalog,
  deleteDomain,
  deleteEntityFromCatalog,
  hasStaleAutoEntityTags,
  normalizeSchemaName,
  renameDomain,
  resetAutoEntityTags,
  resolveOperationEntity,
} from '@/schema/entity/catalog'
import type { OpenAPISpec } from '@/importers/openapi/types'
import type { Schema } from '@/types'
import { SCHEMA_VERSION } from '@/types'

// ─── normalizeSchemaName ────────────────────────────────────

describe('normalizeSchemaName', () => {
  it('strips Admin prefix', () => {
    expect(normalizeSchemaName('AdminPayment')).toBe('payment')
    expect(normalizeSchemaName('AdminBonusIssue')).toBe('bonus-issue')
    expect(normalizeSchemaName('AdminGame')).toBe('game')
  })

  it('kebab-cases PascalCase names and singularizes the last token', () => {
    expect(normalizeSchemaName('FreespinBonus')).toBe('freespin-bonus')
    expect(normalizeSchemaName('RakebackTransaction')).toBe('rakeback-transaction')
    expect(normalizeSchemaName('PaymentSystemCurrencyLimit')).toBe('payment-system-currency-limit')
  })

  it('strips Request / Response / Params / Options / Dto suffixes', () => {
    expect(normalizeSchemaName('CreateCategoryRequest')).toBe('category')
    expect(normalizeSchemaName('UpdateCategoryRequest')).toBe('category')
    expect(normalizeSchemaName('FreespinBonusRequest')).toBe('freespin-bonus')
    expect(normalizeSchemaName('BonusRequest')).toBe('bonus')
  })

  it('filters transport primitives to null', () => {
    expect(normalizeSchemaName('PageInfo')).toBeNull()
    expect(normalizeSchemaName('ProblemDetails')).toBeNull()
    expect(normalizeSchemaName('Error')).toBeNull()
    expect(normalizeSchemaName('CurrencyCode')).toBeNull()
    expect(normalizeSchemaName('TokenResponse')).toBeNull()
  })
})

// ─── buildEntityCatalog ─────────────────────────────────────

describe('buildEntityCatalog', () => {
  it('produces entity + domain catalog from a minimal spec', () => {
    const spec: OpenAPISpec = {
      openapi: '3.0.0',
      tags: [{ name: 'Customer' }, { name: 'Payments' }],
      components: {
        schemas: {
          Customer: { properties: { id: { type: 'string' } } },
          Payment: { properties: { id: { type: 'string' } } },
        },
      },
      paths: {
        '/customers': { get: { tags: ['Customer'], responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } } } } } },
        '/payments': { get: { tags: ['Payments'], responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } } } } } },
      },
    }
    const catalog = buildEntityCatalog(spec)
    expect(catalog.entities.map((e) => e.name).sort()).toEqual(['customer', 'payment'])
    expect(catalog.domains).toEqual(['customer', 'payment'])
  })

  it('collapses Admin-prefixed wrappers into one entity (payment family)', () => {
    const spec: OpenAPISpec = {
      openapi: '3.0.0',
      components: {
        schemas: {
          AdminPayment: { properties: { id: { type: 'string' } } },
          AdminCashout: { allOf: [{ $ref: '#/components/schemas/AdminPayment' }] },
          AdminDeposit: { allOf: [{ $ref: '#/components/schemas/AdminPayment' }] },
          AdminPaymentItem: { oneOf: [{ $ref: '#/components/schemas/AdminCashout' }, { $ref: '#/components/schemas/AdminDeposit' }] },
        },
      },
      paths: {
        '/payments': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/AdminPaymentItem' } } } } } } },
      },
    }
    const catalog = buildEntityCatalog(spec)
    expect(catalog.entities.map((e) => e.name)).toEqual(['payment'])
    // All four schemas collapse to 'payment' in the lookup map.
    expect(catalog.schemaToEntity.get('AdminPayment')).toBe('payment')
    expect(catalog.schemaToEntity.get('AdminCashout')).toBe('payment')
    expect(catalog.schemaToEntity.get('AdminDeposit')).toBe('payment')
    expect(catalog.schemaToEntity.get('AdminPaymentItem')).toBe('payment')
  })

  it('filters enums, wrappers, primitives, and value objects', () => {
    const spec: OpenAPISpec = {
      openapi: '3.0.0',
      components: {
        schemas: {
          // Real entity — used at top level.
          Customer: { properties: { id: { type: 'string' }, amount: { $ref: '#/components/schemas/Amount' } } },
          // Value object — referenced only from Customer, never top-level.
          Amount: { properties: { cents: { type: 'integer' } } },
          // Pure enum — filtered.
          DocumentStatus: { type: 'string', enum: ['approved', 'pending'] },
          // Wrapper — collapses to its underlying entity.
          CreateCustomerRequest: { properties: { name: { type: 'string' } } },
          // Transport primitive — filtered by name.
          PageInfo: { properties: { hasNext: { type: 'boolean' } } },
        },
      },
      paths: {
        '/customers': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateCustomerRequest' } } } }, responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } } } } } },
      },
    }
    const catalog = buildEntityCatalog(spec)
    // Only 'customer' survives.
    expect(catalog.entities.map((e) => e.name)).toEqual(['customer'])
    // Wrapper schemaToEntity maps to 'customer'.
    expect(catalog.schemaToEntity.get('CreateCustomerRequest')).toBe('customer')
    // Enum / value object / primitive not in schemaToEntity at all.
    expect(catalog.schemaToEntity.has('DocumentStatus')).toBe(false)
    expect(catalog.schemaToEntity.has('Amount')).toBe(false)
    expect(catalog.schemaToEntity.has('PageInfo')).toBe(false)
  })

  it('is deterministic — same spec produces byte-identical catalog', () => {
    const spec: OpenAPISpec = {
      openapi: '3.0.0',
      tags: [{ name: 'Z' }, { name: 'A' }],
      components: { schemas: {
        Beta: { properties: {} },
        Alpha: { properties: {} },
      } },
      paths: {
        '/a': { get: { tags: ['A'], responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Alpha' } } } } } } },
        '/z': { get: { tags: ['Z'], responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Beta' } } } } } } },
      },
    }
    const a = buildEntityCatalog(spec)
    const b = buildEntityCatalog(spec)
    expect(a.entities).toEqual(b.entities)
    expect(a.domains).toEqual(b.domains)
  })
})

// ─── resolveOperationEntity ─────────────────────────────────

describe('resolveOperationEntity', () => {
  const spec: OpenAPISpec = {
    openapi: '3.0.0',
    tags: [{ name: 'Payment' }, { name: 'Auth' }],
    components: {
      schemas: {
        Payment: { properties: { id: { type: 'string' } } },
      },
    },
    paths: {
      '/payments': {
        get: { tags: ['Payment'], responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } } } } },
      },
    },
  }
  const catalog = buildEntityCatalog(spec)

  it('unwraps { data: $ref } shape', () => {
    const result = resolveOperationEntity(
      {
        tags: ['Payment'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/Payment' } },
                },
              },
            },
          },
        },
      },
      catalog,
    )
    expect(result).toEqual({ entity: 'payment', domain: 'payment' })
  })

  it('unwraps { data: array of $ref } shape', () => {
    const result = resolveOperationEntity(
      {
        tags: ['Payment'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Payment' } } },
                },
              },
            },
          },
        },
      },
      catalog,
    )
    expect(result.entity).toBe('payment')
  })

  it('handles a direct $ref response', () => {
    const result = resolveOperationEntity(
      {
        tags: ['Payment'],
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } } },
        },
      },
      catalog,
    )
    expect(result.entity).toBe('payment')
  })

  it('falls back to request body when response unwrap fails', () => {
    const result = resolveOperationEntity(
      {
        tags: ['Payment'],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } } },
        responses: { '204': {} },
      },
      catalog,
    )
    expect(result.entity).toBe('payment')
  })

  it('falls back to tag when no schemas match (inline Auth-style)', () => {
    const result = resolveOperationEntity(
      {
        tags: ['Auth'],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' } } } } } },
        responses: { '201': { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
      catalog,
    )
    expect(result.entity).toBe('auth')
    expect(result.domain).toBe('auth')
  })
})

// ─── catalog mutation helpers ───────────────────────────────

describe('catalog mutation helpers', () => {
  const base = (): Schema => ({
    meta: {
      name: 'T', version: SCHEMA_VERSION,
      entities: ['customer', 'payment'],
      domains: ['customer', 'payment'],
    },
    nodeTypes: {}, linkTypes: {},
    nodes: [
      { id: 'n1', name: 'A', type: 'api', description: '', origin: 'auto:openapi', entity: 'customer', domain: 'customer' },
      { id: 'n2', name: 'B', type: 'api', description: '', origin: 'auto:openapi', entity: 'payment', domain: 'payment' },
      { id: 'n3', name: 'C', type: 'ui', description: '', origin: 'auto:codebase' },
    ],
    links: [], paths: [], annotations: [],
  })

  it('addEntityToCatalog adds a new entity, idempotent', () => {
    const s1 = addEntityToCatalog(base(), 'bonus')
    expect(s1.meta.entities).toContain('bonus')
    const s2 = addEntityToCatalog(s1, 'bonus')
    expect(s2.meta.entities).toEqual(s1.meta.entities)
  })

  it('deleteEntityFromCatalog removes entity + untags matching nodes', () => {
    const next = deleteEntityFromCatalog(base(), 'customer')
    expect(next.meta.entities).not.toContain('customer')
    expect(next.nodes.find((n) => n.id === 'n1')?.entity).toBeUndefined()
    // Unrelated nodes untouched.
    expect(next.nodes.find((n) => n.id === 'n2')?.entity).toBe('payment')
  })

  it('renameDomain updates the catalog and all tagged nodes', () => {
    const next = renameDomain(base(), 'customer', 'customers')
    expect(next.meta.domains).toContain('customers')
    expect(next.meta.domains).not.toContain('customer')
    expect(next.nodes.find((n) => n.id === 'n1')?.domain).toBe('customers')
  })

  it('deleteDomain removes the domain + untags matching nodes', () => {
    const next = deleteDomain(base(), 'customer')
    expect(next.meta.domains).not.toContain('customer')
    expect(next.nodes.find((n) => n.id === 'n1')?.domain).toBeUndefined()
    // entity is untouched.
    expect(next.nodes.find((n) => n.id === 'n1')?.entity).toBe('customer')
  })

  it('assignEntityToNode sets entity + marks manualOverrides', () => {
    const next = assignEntityToNode(base(), 'n3', 'payment')
    const n3 = next.nodes.find((n) => n.id === 'n3')!
    expect(n3.entity).toBe('payment')
    expect(n3.manualOverrides).toContain('entity')
  })

  it('assignEntityToNode with null clears entity + the override', () => {
    const s1 = assignEntityToNode(base(), 'n1', null)
    const n1 = s1.nodes.find((n) => n.id === 'n1')!
    expect(n1.entity).toBeUndefined()
    expect(n1.manualOverrides).toBeUndefined()
  })
})

// ─── stale-state cleanup ────────────────────────────────────

describe('hasStaleAutoEntityTags / resetAutoEntityTags', () => {
  const stuck = (): Schema => ({
    meta: { name: 'Stuck', version: SCHEMA_VERSION, entities: [], domains: [] },
    nodeTypes: {}, linkTypes: {},
    nodes: [
      // Auto node carrying junk entity from the old extractor.
      { id: 'n1', name: 'utils.ts', type: 'ui', description: '', origin: 'auto:codebase', entity: 'util' },
      { id: 'n2', name: 'theme.ts', type: 'ui', description: '', origin: 'auto:codebase', entity: 'theme' },
      // Manual override — should survive the wipe.
      { id: 'n3', name: 'pinned', type: 'ui', description: '', origin: 'auto:codebase', entity: 'kept', manualOverrides: ['entity'] },
      // Pure manual node — also survives.
      { id: 'n4', name: 'hand-made', type: 'service', description: '', origin: 'manual', entity: 'service' },
    ],
    links: [], paths: [], annotations: [],
  })

  it('detects stuck state when catalog is empty + nodes carry auto entity tags', () => {
    expect(hasStaleAutoEntityTags(stuck())).toBe(true)
  })

  it('does not flag stuck when catalog has entries', () => {
    const s = { ...stuck(), meta: { ...stuck().meta, entities: ['util'] } }
    expect(hasStaleAutoEntityTags(s)).toBe(false)
  })

  it('does not flag stuck when only manual / override nodes have entities', () => {
    const s: Schema = {
      ...stuck(),
      nodes: [stuck().nodes[2], stuck().nodes[3]], // only the protected ones
    }
    expect(hasStaleAutoEntityTags(s)).toBe(false)
  })

  it('resetAutoEntityTags wipes entity+domain on auto nodes only, preserving overrides + manual', () => {
    const cleaned = resetAutoEntityTags(stuck())
    expect(cleaned.nodes.find((n) => n.id === 'n1')?.entity).toBeUndefined()
    expect(cleaned.nodes.find((n) => n.id === 'n2')?.entity).toBeUndefined()
    // Manual override preserved.
    expect(cleaned.nodes.find((n) => n.id === 'n3')?.entity).toBe('kept')
    // Pure manual node preserved.
    expect(cleaned.nodes.find((n) => n.id === 'n4')?.entity).toBe('service')
    // Catalog is reset to empty arrays (ready for re-import).
    expect(cleaned.meta.entities).toEqual([])
    expect(cleaned.meta.domains).toEqual([])
  })

  it('resetAutoEntityTags is idempotent', () => {
    const once = resetAutoEntityTags(stuck())
    const twice = resetAutoEntityTags(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })
})
