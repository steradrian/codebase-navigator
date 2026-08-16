import { describe, expect, it } from 'vitest'
import { parseOpenAPI } from '@/importers/openapi'
import type { OpenAPISpec } from '@/importers/openapi/types'
import { validate } from '@/schema/validate'

// ─── fixtures ────────────────────────────────────────────────

const minimalSpec: OpenAPISpec = {
  openapi: '3.0.0',
  info: { title: 'Minimal', version: '1.0' },
  paths: {},
  components: { schemas: {} },
}

// CrossRef spec: every schema appears at the top level of a request
// or response body, so none are classified as value objects by GE-115.
const crossRefSpec: OpenAPISpec = {
  openapi: '3.0.0',
  info: { title: 'CrossRef', version: '1.0' },
  components: {
    schemas: {
      User: {
        description: 'A user',
        properties: { id: { type: 'string' } },
      },
      Review: {
        description: 'A review by a user on an item',
        properties: {
          author: { $ref: '#/components/schemas/User' },
          item: { $ref: '#/components/schemas/Item' },
        },
      },
      Item: {
        description: 'An item',
        properties: { id: { type: 'string' } },
      },
    },
  },
  paths: {
    '/reviews': {
      post: {
        tags: ['reviews'],
        summary: 'Create a review',
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Review' },
            },
          },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Review' },
              },
            },
          },
        },
      },
    },
    '/users': {
      get: {
        tags: ['users'],
        responses: {
          '200': {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/User' } },
            },
          },
        },
      },
    },
    '/items': {
      get: {
        tags: ['items'],
        responses: {
          '200': {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Item' } },
            },
          },
        },
      },
    },
  },
}

// Polymorphic: Pick is oneOf A/B. A and B each have a path that uses
// them at the top level so they're entities, not value objects.
const polymorphicSpec: OpenAPISpec = {
  openapi: '3.0.3',
  info: { title: 'Poly', version: '1.0' },
  components: {
    schemas: {
      A: { properties: { id: { type: 'string' } } },
      B: { properties: { id: { type: 'string' } } },
      Pick: {
        oneOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }],
      },
    },
  },
  paths: {
    '/a': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } } } } },
    '/b': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/B' } } } } } } },
    '/pick': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pick' } } } } } } },
  },
}

// Array-item-ref: Tag is used both inside Article AND as its own
// top-level response, so it survives value-object filtering.
const arrayItemRefSpec: OpenAPISpec = {
  openapi: '3.0.0',
  info: { title: 'Array', version: '1.0' },
  components: {
    schemas: {
      Tag: { properties: { name: { type: 'string' } } },
      Article: {
        properties: {
          tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
        },
      },
    },
  },
  paths: {
    '/articles': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Article' } } } } } } },
    '/tags': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Tag' } } } } } } },
  },
}

const unresolvableRefSpec: OpenAPISpec = {
  openapi: '3.0.0',
  info: { title: 'Broken', version: '1.0' },
  components: {
    schemas: {
      Bad: {
        properties: { ref: { $ref: '#/components/schemas/DoesNotExist' } },
      },
    },
  },
}

const externalRefSpec: OpenAPISpec = {
  openapi: '3.0.0',
  info: { title: 'External', version: '1.0' },
  components: {
    schemas: {
      Reference: {
        properties: { other: { $ref: 'other.yaml#/components/schemas/Foo' } },
      },
    },
  },
}

// ─── tests ───────────────────────────────────────────────────

describe('parseOpenAPI — input validation', () => {
  it('rejects non-object input', () => {
    const result = parseOpenAPI(null)
    expect(result.ok).toBe(false)
    expect(result.errors[0].kind).toBe('not_an_object')
  })

  it('rejects a spec missing the openapi version field', () => {
    const result = parseOpenAPI({ info: { title: 'X' } })
    expect(result.ok).toBe(false)
    expect(result.errors[0].kind).toBe('missing_openapi_version')
  })

  it('rejects OpenAPI v2 / Swagger input', () => {
    const result = parseOpenAPI({ openapi: '2.0.0' })
    expect(result.ok).toBe(false)
    expect(result.errors[0].kind).toBe('unsupported_openapi_version')
  })
})

describe('parseOpenAPI — output validity', () => {
  it('produces a schema that passes the v1.0 validator', () => {
    const result = parseOpenAPI(crossRefSpec)
    expect(result.ok).toBe(true)
    expect(result.schema).not.toBeNull()
    const v = validate(result.schema!)
    expect(v.errors).toEqual([])
    expect(v.ok).toBe(true)
  })

  it('tags every emitted node and link with origin: "auto:openapi"', () => {
    const result = parseOpenAPI(crossRefSpec)
    expect(result.schema!.nodes.every((n) => n.origin === 'auto:openapi')).toBe(true)
    expect(result.schema!.links.every((l) => l.origin === 'auto:openapi')).toBe(true)
  })

  it('sets meta.sources to ["auto:openapi"]', () => {
    const result = parseOpenAPI(crossRefSpec)
    expect(result.schema!.meta.sources).toEqual(['auto:openapi'])
  })

  it('handles a minimal empty spec without crashing', () => {
    const result = parseOpenAPI(minimalSpec)
    expect(result.ok).toBe(true)
    expect(result.schema!.nodes).toEqual([])
    expect(result.schema!.links).toEqual([])
  })
})

describe('parseOpenAPI — schema translation', () => {
  it('emits one database-type node per components.schemas entry', () => {
    const result = parseOpenAPI(crossRefSpec)
    const schemaNodes = result.schema!.nodes.filter((n) => n.type === 'database')
    expect(schemaNodes.map((n) => n.name).sort()).toEqual(['Item', 'Review', 'User'])
  })

  it('emits dependency links for $ref between schema properties', () => {
    const result = parseOpenAPI(crossRefSpec)
    const depLinks = result.schema!.links.filter((l) => l.type === 'dependency')
    // Review references User and Item — two dependency edges
    expect(depLinks).toHaveLength(2)
    const targets = depLinks.map((l) => l.target).sort()
    expect(targets).toEqual(['openapi:schema:item', 'openapi:schema:user'])
  })

  it('follows $ref through array items', () => {
    const result = parseOpenAPI(arrayItemRefSpec)
    const depLinks = result.schema!.links.filter((l) => l.type === 'dependency')
    expect(depLinks).toHaveLength(1)
    expect(depLinks[0].source).toBe('openapi:schema:article')
    expect(depLinks[0].target).toBe('openapi:schema:tag')
  })

  it('follows $ref through oneOf / anyOf branches', () => {
    const result = parseOpenAPI(polymorphicSpec)
    const depLinks = result.schema!.links
      .filter((l) => l.type === 'dependency' && l.source === 'openapi:schema:pick')
      .map((l) => l.target)
      .sort()
    expect(depLinks).toEqual(['openapi:schema:a', 'openapi:schema:b'])
  })
})

describe('parseOpenAPI — path translation', () => {
  it('emits one API node per path × method with summary as description', () => {
    const result = parseOpenAPI(crossRefSpec)
    const apiNodes = result.schema!.nodes.filter((n) => n.type === 'api')
    expect(apiNodes.map((n) => n.name).sort()).toEqual([
      'GET /items',
      'GET /users',
      'POST /reviews',
    ])
    const post = apiNodes.find((n) => n.name === 'POST /reviews')
    expect(post?.description).toBe('Create a review')
    expect(post?.group).toBe('reviews')
  })

  it('creates data_flow links: api → schema for request body, schema → api for response', () => {
    const result = parseOpenAPI(crossRefSpec)
    const dataFlows = result.schema!.links.filter((l) => l.type === 'data_flow')

    const apiId = 'openapi:op:post:reviews'
    const schemaId = 'openapi:schema:review'

    const request = dataFlows.find((l) => l.source === apiId && l.target === schemaId)
    const response = dataFlows.find((l) => l.source === schemaId && l.target === apiId)

    expect(request).toBeDefined()
    expect(response).toBeDefined()
  })
})

describe('parseOpenAPI — warnings & graceful degradation', () => {
  it('warns on unresolvable local refs without erroring', () => {
    const result = parseOpenAPI(unresolvableRefSpec)
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.kind === 'unresolved_local_ref')).toBe(true)
  })

  it('warns on external refs and skips them', () => {
    const result = parseOpenAPI(externalRefSpec)
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.kind === 'external_ref_skipped')).toBe(true)
    // No link emitted for the external ref
    expect(result.schema!.links).toEqual([])
  })
})

describe('parseOpenAPI — determinism', () => {
  it('produces byte-identical output for the same input', () => {
    const a = parseOpenAPI(crossRefSpec)
    const b = parseOpenAPI(crossRefSpec)
    expect(JSON.stringify(a.schema)).toBe(JSON.stringify(b.schema))
  })

  it('orders nodes and links by ID regardless of input key order', () => {
    const result = parseOpenAPI(crossRefSpec)
    const nodeIds = result.schema!.nodes.map((n) => n.id)
    const sorted = [...nodeIds].sort()
    expect(nodeIds).toEqual(sorted)
  })
})
